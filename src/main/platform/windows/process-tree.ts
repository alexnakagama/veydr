import { spawn as spawnChild, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { stat } from 'node:fs/promises'
import { DEFAULT_STOP_TIMEOUT_MS } from '../../../shared/config'
import { SpawnError } from '../errors'
import type { LedgerEntry, ProcessIdentity, ProcessTree, SpawnPlan, StopResult, Survivor } from '../types'
import { helperLaunch, isFullyQualified } from './command-line'
import {
  HELPER_KILL_WAIT_MS,
  procInfo,
  startHelperRun,
  STOP_MARGIN_MS,
  type HelperClientOptions,
  type SpawnHelper,
  type WindowsManagedProcess,
} from './helper-client'
import { createHelperCheck, runHelperTool, type HelperCheck, type ReadHelperVersion } from './helper-tool'
import { parseWindowsIdentity, windowsIdentity } from './identity'
import {
  encodeIdentities,
  MAX_GRACE_MS,
  MAX_TOOL_IDENTITIES,
  parseInspectOutput,
  parseTerminateOutput,
  ProtocolError,
  type HelperMember,
  type WindowsProcessRef,
} from './protocol'

export interface WindowsProcessTreeOptions extends HelperClientOptions {
  /**
   * The check of `helperPath`, shared with everything else that runs the same helper; its
   * `helperPath` must be this tree's. Without it the tree makes its own, with `readHelperVersion`.
   */
  readonly helperCheck?: HelperCheck
  /** `veydr-helper.exe version` outside tests; only without `helperCheck`. */
  readonly readHelperVersion?: ReadHelperVersion
  /** Time survivors get to end after Ctrl+Break (the default stop timeout, 5 s). */
  readonly survivorGraceMs?: number
  /** How long `veydr-helper.exe inspect` may take. */
  readonly inspectTimeoutMs?: number
  /** This process; never reported or ended. */
  readonly selfPid?: number
  /** Starts an unsupervised program for `launchDetached`; `child_process.spawn` outside tests. */
  readonly spawnDetached?: SpawnHelper
  /** How long Node may take to say why `spawnDetached` created no process (`SPAWN_ERROR_WAIT_MS`). */
  readonly spawnErrorWaitMs?: number
}

/** The Windows process tree; its runs also report the console the helper gave them. */
export interface WindowsProcessTree extends Pick<ProcessTree, 'launchDetached' | 'findSurvivors' | 'terminateSurvivors'> {
  spawn(plan: SpawnPlan): Promise<WindowsManagedProcess>
}

/** How long `veydr-helper.exe inspect` may take. */
export const INSPECT_TIMEOUT_MS = 30_000

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export { isFullyQualified }

/**
 * Windows process trees (add-windows-process-supervision design D1): each command runs through its
 * own `veydr-helper.exe run`, which holds the command's Job Object. `spawn` refuses, before any
 * process of the command exists, a helper that is missing or speaks another protocol version
 * (design D5). The helper's version is read once per helper file, and again after it changes.
 */
export function createWindowsProcessTree(options: WindowsProcessTreeOptions): WindowsProcessTree {
  const selfPid = options.selfPid ?? process.pid
  const survivorGraceMs = options.survivorGraceMs ?? DEFAULT_STOP_TIMEOUT_MS
  const inspectTimeoutMs = options.inspectTimeoutMs ?? INSPECT_TIMEOUT_MS
  const stopMarginMs = options.stopMarginMs ?? STOP_MARGIN_MS
  requireMs('survivorGraceMs', survivorGraceMs, 0)
  requireMs('inspectTimeoutMs', inspectTimeoutMs, 1)
  requireMs('stopMarginMs', stopMarginMs, 0)
  const helperCheck = sharedHelperCheck(options)
  const checkHelper = (): Promise<void> => helperCheck.verify()

  /**
   * Runs a survivor subcommand on `targets`, at most MAX_TOOL_IDENTITIES per call; `call` gives each
   * call's arguments and time limit when it starts. Every process an answer reports must be one
   * that call asked about.
   */
  async function runTool<T>(
    targets: ReadonlyMap<string, WindowsProcessRef>,
    call: () => { readonly args: readonly string[]; readonly timeoutMs: number },
    parse: (output: string) => T,
    reported: (answer: T) => readonly HelperMember[],
  ): Promise<T[]> {
    await checkHelper()
    const all = [...targets]
    const answers: T[] = []
    for (let start = 0; start < all.length; start += MAX_TOOL_IDENTITIES) {
      const chunk = new Map(all.slice(start, start + MAX_TOOL_IDENTITIES))
      const { args, timeoutMs } = call()
      const output = await runHelperTool(options.helperPath, args, encodeIdentities([...chunk.values()]), {
        spawnHelper: options.spawnHelper ?? spawnChild,
        timeoutMs,
      })
      const answer = parse(output)
      for (const m of reported(answer)) {
        if (!chunk.has(refKey(m))) throw new ProtocolError('malformed', `The Windows helper reported process ${m.pid}, which ${args[0] ?? ''} was not asked about`)
      }
      answers.push(answer)
    }
    return answers
  }

  /** The Windows identities among `identities`, without duplicates and without this process. */
  const targetsOf = (identities: Iterable<ProcessIdentity>): Map<string, WindowsProcessRef> => {
    const targets = new Map<string, WindowsProcessRef>()
    for (const identity of identities) {
      // Another platform's identity (e.g. a Linux ledger entry) names no Windows process.
      const parsed = parseWindowsIdentity(identity)
      if (parsed === null || parsed.pid === selfPid) continue
      targets.set(refKey(parsed), parsed)
    }
    return targets
  }

  return {
    async spawn(plan: SpawnPlan): Promise<WindowsManagedProcess> {
      // What the plan alone shows is refused before the helper's version is even read.
      checkPlanText(plan)
      await checkHelper()
      await checkPlanFiles(plan)
      return startHelperRun(plan, options)
    },

    /**
     * Starts an editor or another unsupervised program (design D4), without the helper: Node's
     * `spawn` with `detached` (`DETACHED_PROCESS`, so no console and outside libuv's job, which ends
     * Veydr's children with Veydr), no pipes, and the plan's command line verbatim. The same checks
     * as `spawn` run first, the batch-file refusal included, so `CreateProcess` never runs a batch
     * file without `cmd.exe`.
     *
     * No `windowsHide`: `DETACHED_PROCESS` already keeps a console program from getting a console,
     * and libuv turns `windowsHide` into `SW_HIDE` in the child's `STARTUPINFO`, which a GUI editor
     * started directly (`Code.exe`) would apply to its first window.
     */
    async launchDetached(plan: SpawnPlan): Promise<void> {
      checkPlanText(plan)
      await checkPlanFiles(plan)
      const { file, argv0, args } = detachedLaunch(plan)
      const spawnDetached = options.spawnDetached ?? spawnChild
      let child: ChildProcess
      try {
        child = spawnDetached(file, args, {
          cwd: plan.cwd,
          env: { ...plan.env },
          argv0,
          detached: true,
          windowsVerbatimArguments: true,
          stdio: 'ignore',
          shell: false,
        })
      } catch (error) {
        throw detachedSpawnFailure(error, plan)
      }
      // Attached first and kept: an `error` event without a listener would be an uncaught exception,
      // also one that comes after `spawnErrorOf` stopped waiting.
      child.on('error', (error) => options.log?.record('warn', 'process.detached-error', { message: error.message }))
      if (child.pid === undefined) {
        // No process was created; Node reports why with an `error` event, which is not waited for forever.
        throw detachedSpawnFailure(await spawnErrorOf(child, options.spawnErrorWaitMs ?? SPAWN_ERROR_WAIT_MS), plan)
      }
      child.unref()
    },

    /**
     * Crash recovery on Windows (design D4): a recorded process survives if a live process has
     * both its PID and its creation time, as `veydr-helper.exe inspect` reads them. Nothing is
     * opened for writing.
     */
    async findSurvivors(entries: readonly LedgerEntry[]): Promise<Survivor[]> {
      const targets = targetsOf(entries.flatMap((entry) => [entry.leader, ...entry.descendants]))
      if (targets.size === 0) return []
      const answers = await runTool(targets, () => ({ args: ['inspect'], timeoutMs: inspectTimeoutMs }), parseInspectOutput, (answer) => answer.processes)
      const alive = new Map(answers.flatMap((answer) => answer.processes).map((m) => [refKey(m), m]))

      const found = new Map<string, Survivor>()
      for (const entry of entries) {
        for (const identity of [entry.leader, ...entry.descendants]) {
          const parsed = parseWindowsIdentity(identity)
          if (parsed === null) continue
          const key = refKey(parsed)
          const m = alive.get(key)
          if (m === undefined || found.has(key)) continue
          found.set(key, { commandId: entry.commandId, runId: entry.runId, identity: windowsIdentity(m.pid, m.created), info: procInfo(m) })
        }
      }
      return [...found.values()]
    },

    /**
     * Ends survivors found by `findSurvivors` through `veydr-helper.exe terminate` (design D4): each
     * is re-verified, gets Ctrl+Break where its console holds only survivors, and is then ended
     * with `TerminateProcess` if it still matches. Survivors are in no job Veydr holds, so
     * processes they started meanwhile are not ended.
     *
     * More than MAX_TOOL_IDENTITIES survivors take several calls. The grace period counts from the
     * first call, so later calls get only what is left of it; and a console shared by survivors of
     * different calls looks foreign to each, so those survivors are ended without Ctrl+Break.
     */
    async terminateSurvivors(survivors: readonly Survivor[]): Promise<StopResult> {
      const targets = targetsOf(survivors.map((s) => s.identity))
      if (targets.size === 0) return { graceful: 'yes', forced: false, survivors: [] }
      const started = Date.now()
      const call = (): { args: string[]; timeoutMs: number } => {
        const graceMs = Math.max(0, survivorGraceMs - (Date.now() - started))
        // The helper sends no event once graceMs has passed, so it spends at most graceMs, one
        // event's delivery (1 s), and its kill wait (1 s).
        return { args: ['terminate', String(graceMs)], timeoutMs: graceMs + 2 * HELPER_KILL_WAIT_MS + stopMarginMs }
      }
      const answers = await runTool(targets, call, parseTerminateOutput, (answer) => answer.survivors)
      const left = answers.flatMap((answer) => answer.survivors).map(procInfo)
      if (left.length > 0) options.log?.record('warn', 'process.survivors', { pids: left.map((s) => s.pid) })
      return {
        graceful: answers.every((answer) => answer.graceful === 'yes') ? 'yes' : 'no',
        forced: answers.some((answer) => answer.forced),
        survivors: left,
      }
    },
  }
}

const refKey = (ref: WindowsProcessRef): string => `${ref.pid}:${ref.created}`

/**
 * The tree's helper check: the one it was given, which must check the very file the tree runs, or
 * its own. A check of another file would let the tree run a helper whose version nobody read.
 */
function sharedHelperCheck(options: WindowsProcessTreeOptions): HelperCheck {
  const { helperCheck } = options
  if (helperCheck === undefined) return createHelperCheck(options.helperPath, options.readHelperVersion)
  if (options.readHelperVersion !== undefined) throw new RangeError('Give the Windows process tree either helperCheck or readHelperVersion, not both')
  if (helperCheck.helperPath !== options.helperPath) {
    throw new RangeError(`The helper check is for ${helperCheck.helperPath}, but the process tree runs ${options.helperPath}`)
  }
  return helperCheck
}

function requireMs(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min || value > MAX_GRACE_MS) {
    throw new RangeError(`${name} must be an integer from ${min} to ${MAX_GRACE_MS}: ${String(value)}`)
  }
}

/**
 * What the helper cannot report precisely: Node fails to start the helper itself for a missing
 * working directory, and that must not read as a missing helper. The helper also refuses a program
 * that is not given by its full path, so that nothing is looked up in the working directory, and a
 * command line it would refuse (`helperLaunch`).
 */
function checkPlanText(plan: SpawnPlan): void {
  const hasNul = (text: string): boolean => text.includes('\0')
  if (hasNul(plan.file) || hasNul(plan.cwd) || plan.args.some(hasNul) || (plan.commandLine !== undefined && hasNul(plan.commandLine))) {
    throw new SpawnError('other', `Could not start ${plan.file.replaceAll('\0', '\\0')}: the command contains a NUL character`)
  }
  if (!isFullyQualified(plan.file)) throw new SpawnError('executable-not-found', `Executable not found: ${plan.file} (a full path is needed)`)
  // The command line, before anything is read from disk: a batch file without one built for
  // cmd.exe, for one, is refused whether or not it exists (design D1).
  helperLaunch(plan)
}

/** What `child_process.spawn` is given for a detached launch (design D4). */
export interface DetachedLaunch {
  readonly file: string
  /** The quoted program: with verbatim arguments Node copies argv[0] into the command line as is. */
  readonly argv0: string
  /** The rest of the command line as one verbatim argument, or none. */
  readonly args: readonly string[]
}

/**
 * The plan's command line (`helperLaunch`, with all its refusals) split for Node: argv[0], the
 * quoted program, becomes `argv0`, and what follows it the one verbatim argument. libuv joins them
 * with a space, so the program receives exactly the planned command line.
 */
export function detachedLaunch(plan: SpawnPlan): DetachedLaunch {
  const { application, commandLine } = helperLaunch(plan)
  const argv0 = `"${application}"`
  // helperLaunch guarantees the line is argv0 alone, or argv0 and a space; checked again here, so a
  // change there cannot silently cut the wrong part of the line.
  if (commandLine !== argv0 && !commandLine.startsWith(`${argv0} `)) {
    throw new SpawnError('other', `Could not start ${plan.file}: the command line does not start with the quoted program`)
  }
  const rest = commandLine.slice(argv0.length + 1)
  return { file: application, argv0, args: rest === '' ? [] : [rest] }
}

/** How long Node may take to report why it created no process. */
export const SPAWN_ERROR_WAIT_MS = 5_000

/** The `error` Node emits for a child it could not create, or a timeout error if none comes. */
async function spawnErrorOf(child: ChildProcess, waitMs: number): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), waitMs)
  try {
    const [error] = (await once(child, 'error', { signal: controller.signal })) as [unknown]
    return error
  } catch {
    return new Error(`no process was created, and Node gave no reason within ${waitMs} ms`)
  } finally {
    clearTimeout(timer)
  }
}

function detachedSpawnFailure(error: unknown, plan: SpawnPlan): SpawnError {
  if (error instanceof SpawnError) return error
  const code = errnoOf(error)
  if (code === 'ENOENT') return new SpawnError('executable-not-found', `Executable not found: ${plan.file}`)
  if (code === 'EACCES' || code === 'EPERM') return new SpawnError('not-executable', `Not an executable file: ${plan.file}`)
  return new SpawnError('other', `Could not start ${plan.file}: ${messageOf(error)}`)
}

/** The working directory and the program, as they are on disk. */
async function checkPlanFiles(plan: SpawnPlan): Promise<void> {
  let cwd
  try {
    cwd = await stat(plan.cwd)
  } catch (error) {
    const code = errnoOf(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new SpawnError('cwd-missing', `Working directory does not exist: ${plan.cwd}`)
    if (code === 'EACCES' || code === 'EPERM') throw new SpawnError('cwd-inaccessible', `Working directory is not accessible: ${plan.cwd}`)
    throw new SpawnError('other', `Working directory cannot be checked: ${plan.cwd} (${code ?? messageOf(error)})`)
  }
  if (!cwd.isDirectory()) throw new SpawnError('cwd-not-directory', `Working directory is not a directory: ${plan.cwd}`)

  let file
  try {
    file = await stat(plan.file)
  } catch (error) {
    const code = errnoOf(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new SpawnError('executable-not-found', `Executable not found: ${plan.file}`)
    throw new SpawnError('other', `Executable cannot be checked: ${plan.file} (${code ?? messageOf(error)})`)
  }
  if (!file.isFile()) throw new SpawnError('not-executable', `Not an executable file: ${plan.file}`)
}
