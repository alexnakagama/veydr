import { randomUUID } from 'node:crypto'
import type { CommandProcessState, RunState } from '../../shared/api'
import type { CommandConfig, ProjectConfig } from '../../shared/config'
import { NotFoundError, ShuttingDownError } from '../errors'
import { SpawnError, UnsupportedPlatformError } from '../platform/errors'
import type { ExitInfo, ManagedProcess, PlatformLog, ProcInfo, ProcessTree, SpawnPlan, StopResult } from '../platform/types'
import type { RunLedger } from './ledger'
import type { ProcessStateRegistry } from './state'

/** A configured command together with its project. */
export interface LaunchTarget {
  readonly project: ProjectConfig
  readonly command: CommandConfig
}

/** How to run a command, or why it cannot run (a reason meant for the user). */
export type PlanResult = { readonly ok: true; readonly plan: SpawnPlan } | { readonly ok: false; readonly reason: string }

export type OutputStream = 'stdout' | 'stderr'

/**
 * Receives a run's output. Its methods are called synchronously from the run's streams and must
 * not block: output is always consumed, whatever happens downstream (spec: output does not block
 * processes).
 */
export interface OutputSink {
  /** A run was spawned with `command`'s configuration; called before any output of the run. */
  open(commandId: string, runId: string, command: CommandConfig): void
  /** A chunk of the run's `stream`. */
  write(commandId: string, runId: string, stream: OutputStream, chunk: Buffer): void
  /** The run's `stream` is closed: no more output follows on it. */
  close(commandId: string, runId: string, stream: OutputStream): void
}

const NO_OUTPUT: OutputSink = { open: () => undefined, write: () => undefined, close: () => undefined }

export interface SupervisorDeps {
  readonly processTree: Pick<ProcessTree, 'spawn'>
  readonly states: ProcessStateRegistry
  /** The configured command, or `null` if it does not exist. */
  readonly lookup: (commandId: string) => LaunchTarget | null
  readonly plan: (target: LaunchTarget) => Promise<PlanResult>
  readonly output?: OutputSink
  /** Durable record of runs whose processes may be alive (crash recovery, design D9). */
  readonly ledger?: Pick<RunLedger, 'add' | 'updateDescendants' | 'remove'>
  readonly log: PlatformLog
  readonly now?: () => number
  readonly newRunId?: () => string
}

/**
 * Explicit lifecycle actions (design D7). Each resolves with the command's state once the action
 * has been processed; actions on one command are processed one at a time, in request order.
 */
export interface Supervisor {
  /** Starts a new run unless one is running; a duplicate start reports the current run. */
  start(commandId: string): Promise<CommandProcessState>
  /** Stops the current run; a stop requested during a stop completes with it. */
  stop(commandId: string): Promise<CommandProcessState>
  /** Stops the current run completely, then starts a new one (spec: restart a running command). */
  restart(commandId: string): Promise<CommandProcessState>
  /**
   * Quit (design D10): from now on starts and restarts are refused (`ShuttingDownError`); stops
   * every command's current run in parallel, each with its own stop timeout. Resolves once every
   * command has processed its stop; how it went is in the states and the ledger.
   */
  stopAll(): Promise<void>
  /**
   * Commands with a run whose processes may be alive, including a run still being started (being
   * planned or spawned), with the stop timeout that applies to each.
   */
  active(): readonly ActiveRun[]
}

export interface ActiveRun {
  readonly commandId: string
  readonly graceMs: number
}

interface Run {
  readonly runId: string
  readonly process: ManagedProcess
  readonly startedAt: number
  /** Stop timeout when the run started; used if the command no longer exists when it is stopped. */
  readonly graceMs: number
  leaderExit: ExitInfo | null
  ended: boolean
}

/** States the actor rests in between actions; `starting` and `stopping` exist only during one. */
type Status = RunState['status']

interface CommandActor {
  start(): Promise<void>
  stop(): Promise<void>
  restart(): Promise<void>
  /** Stop timeout of the run whose processes may be alive or that is being started, or `null` if there is none. */
  activeGraceMs(): number | null
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  const actors = new Map<string, CommandActor>()
  let shuttingDown = false

  const stateOf = (commandId: string): CommandProcessState => {
    const [state] = deps.states.snapshot([commandId]).commands
    if (state === undefined) throw new Error(`No state for ${commandId}`)
    return state
  }

  const actorFor = (commandId: string): CommandActor => {
    let actor = actors.get(commandId)
    if (actor === undefined) {
      // Commands removed from the configuration keep their actor, so a run that is still alive can be stopped.
      if (deps.lookup(commandId) === null) throw new NotFoundError(`Command ${commandId} does not exist`)
      actor = createCommandActor(commandId, deps)
      actors.set(commandId, actor)
    }
    return actor
  }

  const act = async (commandId: string, action: (actor: CommandActor) => Promise<void>): Promise<CommandProcessState> => {
    await action(actorFor(commandId))
    return stateOf(commandId)
  }

  const refuseWhenShuttingDown = (): void => {
    if (shuttingDown) throw new ShuttingDownError('Veydr is quitting; commands cannot be started.')
  }

  return {
    start: async (commandId) => {
      refuseWhenShuttingDown()
      return act(commandId, (actor) => actor.start())
    },
    stop: (commandId) => act(commandId, (actor) => actor.stop()),
    restart: async (commandId) => {
      refuseWhenShuttingDown()
      return act(commandId, (actor) => actor.restart())
    },
    async stopAll() {
      shuttingDown = true
      // A start queued before this point runs first; the stop queued here then ends its run.
      await Promise.all([...actors.values()].map((actor) => actor.stop()))
    },
    active: () =>
      [...actors.entries()].flatMap(([commandId, actor]) => {
        const graceMs = actor.activeGraceMs()
        return graceMs === null ? [] : [{ commandId, graceMs }]
      }),
  }
}

/**
 * One command's state machine (design D7):
 *
 *   idle|exited|failed --start--> starting --spawned--> running --leader exit--> exited
 *                                    | cannot start        | stop
 *                                    v                     v
 *                                  failed               stopping --tree gone--> exited
 *
 * Every action runs on one queue, so at most one run exists per command and a run's `starting`
 * is recorded before anything else of it and never after a newer run (see `belongsToCurrentRun`).
 */
function createCommandActor(commandId: string, deps: SupervisorDeps): CommandActor {
  const now = deps.now ?? Date.now
  const newRunId = deps.newRunId ?? randomUUID
  const output = deps.output ?? NO_OUTPUT

  let status: Status = 'idle'
  /** The run whose processes may be alive; set from spawn until the run has ended. */
  let current: Run | null = null
  /** Stop timeout of a run being planned or spawned (not yet `current`). */
  let startingGraceMs: number | null = null
  let tail: Promise<unknown> = Promise.resolve()

  const enqueue = (action: () => Promise<void>): Promise<void> => {
    const result = tail.then(action)
    tail = result.catch(() => undefined)
    return result
  }

  const record = (runId: string, next: Partial<RunState> & { readonly status: Status }): void => {
    const state: RunState = { pid: null, startedAt: null, exit: null, error: null, survivors: [], ...next }
    // `null` would mean a late event; the queue makes that impossible, so it is a bug worth logging.
    if (deps.states.record(commandId, runId, state) === null) {
      deps.log.record('error', 'supervisor.state-rejected', { commandId, runId, status: state.status })
    }
    status = state.status
  }

  const graceFor = (run: Run): number => deps.lookup(commandId)?.command.stopTimeoutMs ?? run.graceMs

  /** Calls the sink; a failing sink is logged and never stops output from being consumed. */
  const toSink = (runId: string, call: () => void): void => {
    try {
      call()
    } catch (error) {
      deps.log.record('error', 'supervisor.output-sink-failed', { commandId, runId, message: errorMessage(error) })
    }
  }

  const drain = (run: Run, stream: OutputStream): void => {
    const readable = run.process[stream]
    readable.on('data', (chunk: Buffer) => toSink(run.runId, () => output.write(commandId, run.runId, stream, chunk)))
    readable.on('error', (error) => deps.log.record('warn', 'supervisor.output-error', { commandId, runId: run.runId, stream, message: error.message }))
    // Emitted after the end of the stream, or after an error: either way no more output follows.
    readable.once('close', () => toSink(run.runId, () => output.close(commandId, run.runId, stream)))
  }

  /**
   * Ends `run`. `error` says why the end could not be verified (the stop itself failed). The run
   * leaves the ledger only if nothing of it is known to be alive; otherwise the next launch after
   * a crash still finds its survivors.
   */
  const finish = (run: Run, forced: boolean, survivors: readonly ProcInfo[], error: string | null = null): void => {
    run.ended = true
    if (current === run) current = null
    if (survivors.length === 0 && error === null) deps.ledger?.remove(run.runId)
    const exit = run.leaderExit
    record(run.runId, {
      status: 'exited',
      exit: { code: exit?.code ?? null, signal: exit?.signal ?? null, forced },
      error,
      survivors: survivors.map(({ pid, name }) => ({ pid, name })),
    })
    if (survivors.length > 0) {
      deps.log.record('warn', 'supervisor.survivors', { commandId, runId: run.runId, pids: survivors.map((s) => s.pid) })
    }
  }

  /** What is still alive of `run`; `null` if that cannot be determined. */
  const remaining = async (run: Run): Promise<readonly ProcInfo[] | null> => {
    try {
      return await run.process.remaining()
    } catch (error) {
      deps.log.record('error', 'supervisor.remaining-failed', { commandId, runId: run.runId, message: errorMessage(error) })
      return null
    }
  }

  /**
   * Stops `run` and ends it, so the command never stays in `stopping`. If the stop itself fails,
   * the run ends as unverified: whatever is still known to be alive is listed as survivors.
   * Returns whether nothing of the run survived.
   */
  const terminate = async (run: Run): Promise<boolean> => {
    let result: StopResult
    try {
      result = await run.process.stop({ graceMs: graceFor(run) })
    } catch (error) {
      deps.log.record('error', 'supervisor.stop-failed', { commandId, runId: run.runId, message: errorMessage(error) })
      finish(run, false, (await remaining(run)) ?? [], `Could not verify that the command stopped: ${errorMessage(error)}`)
      return false
    }
    finish(run, result.forced, result.survivors)
    return result.survivors.length === 0
  }

  const leaderExited = async (run: Run): Promise<void> => {
    if (run.ended) return
    // The leader exited although no stop was requested. Nothing of a command may outlive its
    // run, so whatever it left behind is stopped like on a user stop (decision 2026-10-23).
    // The leader is gone, so `stopping` carries no PID.
    const left = await remaining(run)
    if (left !== null && left.length === 0) return finish(run, false, [])
    record(run.runId, { status: 'stopping', startedAt: run.startedAt })
    await terminate(run)
  }

  const start = async (): Promise<void> => {
    // Duplicate start: no second process; the caller receives the current run's state.
    if (status === 'running') return
    const target = deps.lookup(commandId)
    if (target === null) throw new NotFoundError(`Command ${commandId} does not exist`)

    const runId = newRunId()
    record(runId, { status: 'starting' })
    let process: ManagedProcess
    startingGraceMs = target.command.stopTimeoutMs
    try {
      const planned = await deps.plan(target)
      if (!planned.ok) return record(runId, { status: 'failed', error: planned.reason })
      process = await deps.processTree.spawn(planned.plan)
    } catch (error) {
      record(runId, { status: 'failed', error: errorMessage(error) })
      if (error instanceof UnsupportedPlatformError) throw error
      if (!(error instanceof SpawnError)) deps.log.record('error', 'supervisor.start-failed', { commandId, runId, message: errorMessage(error) })
      return
    } finally {
      startingGraceMs = null
    }

    const run: Run = { runId, process, startedAt: now(), graceMs: target.command.stopTimeoutMs, leaderExit: null, ended: false }
    current = run
    toSink(runId, () => output.open(commandId, runId, target.command))
    drain(run, 'stdout')
    drain(run, 'stderr')
    process.onExit((info) => {
      run.leaderExit = info
      enqueue(() => leaderExited(run)).catch((error: unknown) =>
        deps.log.record('error', 'supervisor.exit-handling-failed', { commandId, runId, message: errorMessage(error) }),
      )
    })
    // The run is reported running only once its record is on disk. A crash between spawn and the
    // end of that write (normally a few milliseconds) leaves the run unrecorded (docs/processes.md).
    // Descendants are forwarded after the entry exists, so none observed meanwhile is dropped.
    const recorded = deps.ledger?.add({ commandId, runId, leader: process.identity, sessionId: process.sessionId, descendants: [] })
    process.onDescendantsChange((descendants) => deps.ledger?.updateDescendants(runId, descendants))
    await recorded
    record(runId, { status: 'running', pid: process.pid, startedAt: run.startedAt })
  }

  /** Stops the current run, if one is running; `false` if processes survived the stop. */
  const stop = async (): Promise<boolean> => {
    const run = current
    if (run === null || status !== 'running') return true
    record(run.runId, { status: 'stopping', pid: run.process.pid, startedAt: run.startedAt })
    return terminate(run)
  }

  return {
    start: () => enqueue(start),
    stop: () => enqueue(async () => void (await stop())),
    // A run that could not be stopped completely is not replaced: the survivors are reported instead.
    restart: () => enqueue(async () => ((await stop()) ? start() : undefined)),
    activeGraceMs: () => (current === null ? startingGraceMs : graceFor(current)),
  }
}
