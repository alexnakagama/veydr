import { describe, expect, it } from 'vitest'
import { NotFoundError } from '../../src/main/errors'
import { SpawnError } from '../../src/main/platform/errors'
import { createWindowsPlatform } from '../../src/main/platform/windows'
import type { PlatformLog, ProcessTree } from '../../src/main/platform/types'
import { batchCommandLine, shellCommandLine } from '../../src/main/platform/windows/command-line'
import { createEnvironmentService } from '../../src/main/projects/environment'
import { createPlanner } from '../../src/main/supervisor/plan'
import { createProcessStateRegistry } from '../../src/main/supervisor/state'
import { createSupervisor, type LaunchTarget, type OutputStream, type PlanResult } from '../../src/main/supervisor/supervisor'
import type { ProcessStateEvent } from '../../src/shared/api'
import type { CommandConfig } from '../../src/shared/config'
import { cooperative, FakeProcessTree } from './support/fake-process-tree'
import { command, project, quietLog } from './support/config'
import { windowsFs } from './support/windows-fs'

/** A process tree that records every call and starts nothing. */
function spyProcessTree(): { readonly tree: ProcessTree; readonly calls: string[] } {
  const calls: string[] = []
  const refuse = (name: string): Promise<never> => {
    calls.push(name)
    return Promise.reject(new Error(`${name} must not be called`))
  }
  return {
    calls,
    tree: {
      spawn: () => refuse('spawn'),
      launchDetached: () => refuse('launchDetached'),
      findSurvivors: () => refuse('findSurvivors'),
      terminateSurvivors: () => refuse('terminateSurvivors'),
    },
  }
}

/** Lets queued microtasks and zero-delay timers run. */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 5))

interface Harness {
  readonly tree: FakeProcessTree
  readonly events: ProcessStateEvent[]
  readonly commandId: string
  readonly target: LaunchTarget
  readonly supervisor: ReturnType<typeof createSupervisor>
  readonly output: [string, OutputStream | 'open' | 'close', string][]
  /** The fallback encoding each opened run was given, in order. */
  readonly fallbackEncodings: (string | null)[]
  plans: number
  /** Status sequence of the emitted events. */
  statuses(): string[]
  /** Removes the command from the configuration. */
  remove(): void
}

function harness(
  options: {
    readonly command?: Partial<CommandConfig>
    readonly projectPath?: string
    readonly plan?: (target: LaunchTarget) => Promise<PlanResult>
    readonly tree?: Pick<ProcessTree, 'spawn'>
  } = {},
): Harness {
  const tree = new FakeProcessTree()
  const events: ProcessStateEvent[] = []
  const states = createProcessStateRegistry((event) => events.push(event))
  const cmd = command({ stopTimeoutMs: 1234, ...options.command })
  const proj = project({ commands: [cmd], ...(options.projectPath === undefined ? {} : { path: options.projectPath }) })
  let target: LaunchTarget | null = { project: proj, command: cmd }
  const output: [string, OutputStream | 'open' | 'close', string][] = []
  const fallbackEncodings: (string | null)[] = []
  const h: Harness = {
    tree,
    events,
    commandId: cmd.id,
    target,
    output,
    fallbackEncodings,
    plans: 0,
    statuses: () => events.map((e) => e.status),
    remove: () => {
      target = null
    },
    supervisor: createSupervisor({
      processTree: options.tree ?? tree,
      states,
      lookup: (id) => (id === cmd.id ? target : null),
      plan: (t) => {
        h.plans++
        return options.plan?.(t) ?? Promise.resolve({ ok: true, plan: { file: t.command.name, args: [], cwd: t.project.path, env: {} } })
      },
      output: {
        open: (_commandId, runId, opened, fallbackEncoding) => {
          output.push([runId, 'open', opened.id])
          fallbackEncodings.push(fallbackEncoding)
        },
        write: (_commandId, runId, stream, chunk) => {
          if (chunk.toString() === 'boom') throw new Error('sink failed')
          output.push([runId, stream, chunk.toString()])
        },
        close: (_commandId, runId, stream) => output.push([runId, 'close', stream]),
      },
      log: quietLog(),
      now: () => 42_000,
    }),
  }
  return h
}

describe('supervisor state machine', () => {
  it('[spec:process-supervision/running-state-details] starts: idle → starting → running with PID and start time', async () => {
    const h = harness()
    const state = await h.supervisor.start(h.commandId)
    expect(h.statuses()).toEqual(['starting', 'running'])
    expect(state).toMatchObject({ commandId: h.commandId, status: 'running', pid: h.tree.last.pid, startedAt: 42_000, exit: null, error: null })
    expect(state.runId).toBe(h.events[0]?.runId)
    expect(h.tree.last.plan).toEqual({ file: 'api', args: [], cwd: '/home/dev/shop', env: {} })
  })

  it('[spec:process-supervision/duplicate-start] reports the current run for a start while starting or running, without a second process', async () => {
    const h = harness()
    h.tree.behavior = { ...cooperative, spawnDelayMs: 20 }
    const [first, second] = await Promise.all([h.supervisor.start(h.commandId), h.supervisor.start(h.commandId)])
    const third = await h.supervisor.start(h.commandId)
    expect(h.tree.spawnCalls).toBe(1)
    expect(first.runId).toBe(second.runId)
    expect(third).toEqual(second)
    expect(h.statuses()).toEqual(['starting', 'running'])
  })

  it('stops a running command: running → stopping → exited, with the stop timeout of the command', async () => {
    const h = harness()
    await h.supervisor.start(h.commandId)
    const state = await h.supervisor.stop(h.commandId)
    expect(h.statuses()).toEqual(['starting', 'running', 'stopping', 'exited'])
    expect(state).toMatchObject({ status: 'exited', pid: null, exit: { code: null, signal: 'SIGTERM', forced: false }, survivors: [] })
    expect(h.tree.last.stopGraceMs).toEqual([1234])
    expect(h.events[2]).toMatchObject({ status: 'stopping', pid: h.tree.last.pid, startedAt: 42_000 })
    expect(new Set(h.events.map((e) => e.runId)).size).toBe(1)
  })

  it('[spec:process-supervision/exit-details] reports a forced stop and its signal', async () => {
    const h = harness()
    h.tree.behavior = { ...cooperative, uncooperative: true }
    await h.supervisor.start(h.commandId)
    const state = await h.supervisor.stop(h.commandId)
    expect(state).toMatchObject({ status: 'exited', exit: { code: null, signal: 'SIGKILL', forced: true } })
  })

  it('reports processes that survived the stop', async () => {
    const h = harness()
    h.tree.behavior = { ...cooperative, uncooperative: true, survivors: 1 }
    await h.supervisor.start(h.commandId)
    const state = await h.supervisor.stop(h.commandId)
    expect(state).toMatchObject({ status: 'exited', exit: { forced: true }, survivors: [{ pid: h.tree.last.pid * 100, name: 'child' }] })
  })

  it('[spec:process-supervision/stop-during-stop] completes a stop requested during a stop together with it', async () => {
    const h = harness()
    h.tree.behavior = { ...cooperative, stopDelayMs: 30 }
    await h.supervisor.start(h.commandId)
    const order: string[] = []
    const first = h.supervisor.stop(h.commandId).then((s) => {
      order.push('first')
      return s
    })
    await settle()
    expect(h.statuses().at(-1)).toBe('stopping')
    const second = h.supervisor.stop(h.commandId).then((s) => {
      order.push('second')
      return s
    })
    const [a, b] = await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
    expect(a).toEqual(b)
    expect(h.tree.last.stopCalls).toBe(1)
    expect(h.statuses()).toEqual(['starting', 'running', 'stopping', 'exited'])
  })

  it('ignores stop for a command that is not running', async () => {
    const h = harness()
    expect(await h.supervisor.stop(h.commandId)).toMatchObject({ status: 'idle', runId: null })
    h.tree.behavior = { ...cooperative, spawnError: new SpawnError('executable-not-found', 'Executable not found: api') }
    await h.supervisor.start(h.commandId)
    expect(await h.supervisor.stop(h.commandId)).toMatchObject({ status: 'failed' })
    expect(h.statuses()).toEqual(['starting', 'failed'])
  })

  it('[spec:process-supervision/restart-a-running-command] stops the current run completely before starting the new one', async () => {
    const h = harness()
    h.tree.behavior = { ...cooperative, stopDelayMs: 20 }
    const first = await h.supervisor.start(h.commandId)
    const old = h.tree.last
    const state = await h.supervisor.restart(h.commandId)
    expect(h.statuses()).toEqual(['starting', 'running', 'stopping', 'exited', 'starting', 'running'])
    expect(old.alive).toBe(false)
    expect(h.tree.spawned).toHaveLength(2)
    expect(state.runId).not.toBe(first.runId)
    expect(state).toMatchObject({ status: 'running', pid: h.tree.last.pid })
    // The new run's events all carry its runId; seq keeps increasing across runs.
    expect(h.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(h.events.slice(4).every((e) => e.runId === state.runId)).toBe(true)
  })

  it('restart of a command that is not running starts it', async () => {
    const h = harness()
    expect(await h.supervisor.restart(h.commandId)).toMatchObject({ status: 'running' })
    expect(h.statuses()).toEqual(['starting', 'running'])
  })

  it('does not start a new run when the old one could not be stopped completely', async () => {
    const h = harness()
    h.tree.behavior = { ...cooperative, uncooperative: true, survivors: 2 }
    await h.supervisor.start(h.commandId)
    const state = await h.supervisor.restart(h.commandId)
    expect(state).toMatchObject({ status: 'exited', survivors: [{ name: 'child' }, { name: 'child' }] })
    expect(h.tree.spawned).toHaveLength(1)
  })

  it('reports a start failure with the reason and creates no process', async () => {
    const h = harness()
    h.tree.behavior = { ...cooperative, spawnError: new SpawnError('not-executable', 'Permission denied: /x is not executable') }
    const state = await h.supervisor.start(h.commandId)
    expect(state).toMatchObject({ status: 'failed', pid: null, error: 'Permission denied: /x is not executable' })
    expect(h.tree.spawned).toHaveLength(0)
    // A failed command can be started again.
    h.tree.behavior = cooperative
    expect(await h.supervisor.start(h.commandId)).toMatchObject({ status: 'running' })
  })

  it('fails without spawning when the command cannot be planned', async () => {
    const h = harness({ plan: () => Promise.resolve({ ok: false, reason: 'The working directory is outside the project folder.' }) })
    const state = await h.supervisor.start(h.commandId)
    expect(state).toMatchObject({ status: 'failed', error: 'The working directory is outside the project folder.' })
    expect(h.tree.spawnCalls).toBe(0)
  })

  it('[spec:process-supervision/unexpected-exit] an exit without a stop request ends in exited and is not restarted', async () => {
    const h = harness()
    await h.supervisor.start(h.commandId)
    h.tree.last.exit(3)
    await settle()
    expect(h.statuses()).toEqual(['starting', 'running', 'exited'])
    expect(h.events.at(-1)).toMatchObject({ status: 'exited', pid: null, exit: { code: 3, signal: null, forced: false } })
    await settle()
    expect(h.tree.spawnCalls).toBe(1)
    expect(h.plans).toBe(1)
  })

  it('stops what the leader left behind when it exits on its own', async () => {
    const h = harness()
    h.tree.behavior = { ...cooperative, leftovers: 2 }
    await h.supervisor.start(h.commandId)
    const run = h.tree.last
    run.exit(1)
    await settle()
    expect(h.statuses()).toEqual(['starting', 'running', 'stopping', 'exited'])
    expect(h.events[2]).toMatchObject({ status: 'stopping', pid: null })
    expect(h.events.at(-1)).toMatchObject({ exit: { code: 1, signal: null, forced: false }, survivors: [] })
    expect(run.alive).toBe(false)
    expect(run.stopGraceMs).toEqual([1234])
  })

  it('[spec:process-supervision/late-events-ignored] does not attribute the exit of a previous run to the new run', async () => {
    const h = harness()
    await h.supervisor.start(h.commandId)
    const old = h.tree.last
    await h.supervisor.restart(h.commandId)
    // A second exit report of the old run (e.g. delivered late) changes nothing.
    old.exit(9)
    await settle()
    expect(h.statuses()).toEqual(['starting', 'running', 'stopping', 'exited', 'starting', 'running'])
  })

  it('a stop racing with the leader exit finishes the run once', async () => {
    const h = harness()
    h.tree.behavior = { ...cooperative, stopDelayMs: 10 }
    await h.supervisor.start(h.commandId)
    const stopped = h.supervisor.stop(h.commandId)
    h.tree.last.exit(0)
    await stopped
    await settle()
    expect(h.statuses()).toEqual(['starting', 'running', 'stopping', 'exited'])
    expect(h.events.at(-1)).toMatchObject({ exit: { code: 0, forced: false } })
  })

  it('drains output of the current run into the sink, tagged with the run, and survives a failing sink', async () => {
    const h = harness()
    const state = await h.supervisor.start(h.commandId)
    h.tree.last.stdout.write('out')
    h.tree.last.stderr.write('boom')
    h.tree.last.stderr.write('err')
    h.tree.last.stdout.end()
    h.tree.last.stderr.destroy()
    await settle()
    expect(h.output.slice(0, 3)).toEqual([
      [state.runId, 'open', h.commandId],
      [state.runId, 'stdout', 'out'],
      [state.runId, 'stderr', 'err'],
    ])
    // Each stream reports its end once, whether it ended or was destroyed.
    expect(h.output.slice(3).sort()).toEqual([
      [state.runId, 'close', 'stderr'],
      [state.runId, 'close', 'stdout'],
    ])
  })

  it("opens the run's output with the process's fallback encoding (add-windows-environment-and-commands design D5)", async () => {
    const h = harness()
    await h.supervisor.start(h.commandId)
    h.tree.fallbackEncoding = 'windows-1252'
    await h.supervisor.restart(h.commandId)
    expect(h.fallbackEncodings).toEqual([null, 'windows-1252'])
  })

  it('rejects unknown commands with NotFoundError and records nothing', async () => {
    const h = harness()
    await expect(h.supervisor.start('9b0f2a1e-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(NotFoundError)
    await expect(h.supervisor.stop('9b0f2a1e-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(NotFoundError)
    expect(h.events).toEqual([])
  })

  it('can still stop a run whose command was removed, using the stop timeout it started with', async () => {
    const h = harness()
    await h.supervisor.start(h.commandId)
    h.remove()
    expect(await h.supervisor.stop(h.commandId)).toMatchObject({ status: 'exited' })
    expect(h.tree.last.stopGraceMs).toEqual([1234])
    await expect(h.supervisor.start(h.commandId)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('logs and fails a start on an unexpected error', async () => {
    const h = harness({ plan: () => Promise.reject(new Error('resolver crashed')) })
    expect(await h.supervisor.start(h.commandId)).toMatchObject({ status: 'failed', error: 'resolver crashed' })
  })

  it('ends a run whose stop fails as unverified, listing what is known to be alive, and can start again', async () => {
    const h = harness()
    h.tree.behavior = { ...cooperative, stopError: new Error('EMFILE: too many open files, scandir /proc') }
    await h.supervisor.start(h.commandId)
    const state = await h.supervisor.stop(h.commandId)
    expect(h.statuses()).toEqual(['starting', 'running', 'stopping', 'exited'])
    expect(state).toMatchObject({
      status: 'exited',
      error: 'Could not verify that the command stopped: EMFILE: too many open files, scandir /proc',
      survivors: [{ name: 'leader' }, { name: 'child' }, { name: 'child' }],
    })
    // Not stuck: the command can be started again.
    h.tree.behavior = cooperative
    expect(await h.supervisor.start(h.commandId)).toMatchObject({ status: 'running', error: null })
  })

  it('a failing stop during a restart does not start a new run', async () => {
    const h = harness()
    h.tree.behavior = { ...cooperative, stopError: new Error('scan failed') }
    await h.supervisor.start(h.commandId)
    expect(await h.supervisor.restart(h.commandId)).toMatchObject({ status: 'exited', error: expect.stringContaining('scan failed') as unknown })
    expect(h.tree.spawned).toHaveLength(1)
  })

  it('stops the leftovers of an exited leader even when they cannot be listed first', async () => {
    const h = harness()
    h.tree.behavior = { ...cooperative, leftovers: 1, remainingError: new Error('scan failed') }
    await h.supervisor.start(h.commandId)
    const run = h.tree.last
    run.exit(2)
    await settle()
    expect(h.statuses()).toEqual(['starting', 'running', 'stopping', 'exited'])
    expect(h.events.at(-1)).toMatchObject({ exit: { code: 2 }, error: null, survivors: [] })
    expect(run.alive).toBe(false)
  })

  it('ends a run as unverified when its leader exits and the run can no longer be checked (a dead Windows helper)', async () => {
    // A Windows run whose helper was killed: the leader is reported exited, and every later
    // question to the helper fails (test/integration/windows-process-tree.test.ts).
    const h = harness()
    const gone = new Error('The Windows helper failed: the control channel closed')
    h.tree.behavior = { ...cooperative, stopError: gone, remainingError: gone }
    await h.supervisor.start(h.commandId)
    h.tree.last.exit(null)
    await settle()
    expect(h.statuses()).toEqual(['starting', 'running', 'stopping', 'exited'])
    expect(h.events.at(-1)).toMatchObject({
      status: 'exited',
      error: `Could not verify that the command stopped: ${gone.message}`,
      survivors: [],
    })
  })

  it('never leaves a command in stopping when both stop and remaining fail', async () => {
    const h = harness()
    h.tree.behavior = { ...cooperative, stopError: new Error('stop failed'), remainingError: new Error('scan failed') }
    await h.supervisor.start(h.commandId)
    expect(await h.supervisor.stop(h.commandId)).toMatchObject({ status: 'exited', survivors: [], error: expect.stringContaining('stop failed') as unknown })
  })
})

describe('supervisor attribution sets (ports, task 8.2)', () => {
  it('lists the processes of every current run, and none of an ended run', async () => {
    const h = harness()
    expect(await h.supervisor.attribution()).toEqual([])
    const state = await h.supervisor.start(h.commandId)
    const leader = h.tree.last
    expect(await h.supervisor.attribution()).toEqual([
      {
        commandId: h.commandId,
        runId: state.runId,
        processes: [leader.pid, leader.pid * 100, leader.pid * 100 + 1].map((pid) => ({ pid, token: `fake:${pid}` })),
      },
    ])
    await h.supervisor.stop(h.commandId)
    expect(await h.supervisor.attribution()).toEqual([])
  })

  it('leaves out a run whose processes cannot be determined, without failing the others', async () => {
    const h = harness()
    await h.supervisor.start(h.commandId)
    h.tree.last.attributed = () => Promise.reject(new Error('EMFILE'))
    expect(await h.supervisor.attribution()).toEqual([])
    expect(h.statuses()).toEqual(['starting', 'running'])
  })
})

describe('supervisor on the Windows platform', () => {
  const PROJECT = 'C:\\Users\\dev\\shop'
  const CMD = 'C:\\Windows\\System32\\cmd.exe'

  /** The Windows platform as the composition root builds it, over a fake Windows filesystem. */
  function windowsPlatform(log: PlatformLog = quietLog()) {
    return createWindowsPlatform({
      helperPath: 'C:\\veydr\\out-helper\\veydr-helper.exe',
      log,
      // Veydr's own environment: both spellings of the path variable, and Electron's runtime variables.
      inherited: { Path: 'C:\\Program Files\\nodejs', PATH: 'C:\\stale', SystemRoot: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1', '=C:': 'C:\\' },
      resolverFs: windowsFs([`${PROJECT}\\package.json`, 'C:\\Program Files\\nodejs\\npm.cmd', 'C:\\Program Files\\nodejs\\node.exe', CMD]),
    })
  }

  /** The planner of the composition root over `platform`'s resolver and environment. */
  const plannerOf = (platform: ReturnType<typeof windowsPlatform>) =>
    createPlanner({ resolver: platform.commandResolver, environment: createEnvironmentService({ provider: platform.envProvider }), envNames: platform.conventions.envNames })

  it('[spec:process-supervision/command-started-on-windows] plans and spawns a command through the Windows resolver and environment', async () => {
    const platform = windowsPlatform()
    expect(platform.supported).toBe(true)

    // Direct mode: a batch-file shim found through PATH and PATHEXT runs through cmd.exe, with an
    // override of the path variable in another spelling replacing the inherited one.
    const direct = harness({
      projectPath: PROJECT,
      command: { execution: { mode: 'direct', file: 'npm', args: ['run', 'dev'] }, env: [{ key: 'PATH', value: 'C:\\Program Files\\nodejs', secret: false }, { key: 'port', value: '5173', secret: false }] },
      plan: plannerOf(platform),
    })
    const started = await direct.supervisor.start(direct.commandId)
    expect(started).toMatchObject({ status: 'running', error: null })
    expect(started.pid).toBe(direct.tree.last.pid)
    expect(direct.statuses()).toEqual(['starting', 'running'])
    const plan = direct.tree.last.plan
    expect(plan).toEqual({
      file: CMD,
      args: [],
      cwd: PROJECT,
      env: { PATH: 'C:\\Program Files\\nodejs', SystemRoot: 'C:\\Windows', port: '5173' },
      commandLine: batchCommandLine(CMD, 'C:\\Program Files\\nodejs\\npm.CMD', ['run', 'dev']),
    })
    // Exactly one path variable, and no runtime or per-drive variable, reaches the process.
    expect(Object.keys(plan.env).filter((name) => name.toUpperCase() === 'PATH')).toEqual(['PATH'])
    expect(Object.keys(plan.env).some((name) => name.toUpperCase().startsWith('ELECTRON_') || name.startsWith('='))).toBe(false)
    // Its output reaches its log, and a stop ends it.
    direct.tree.last.stdout.write('ready\n')
    await settle()
    expect(direct.output).toContainEqual([direct.events[0]?.runId, 'stdout', 'ready\n'])
    expect(await direct.supervisor.stop(direct.commandId)).toMatchObject({ status: 'exited', survivors: [] })

    // Shell mode: the script runs verbatim through the default shell, cmd.exe in the system directory.
    const shell = harness({
      projectPath: PROJECT,
      command: { execution: { mode: 'shell', shell: platform.conventions.defaultShell ?? '', script: 'npm run build && echo %PORT%' } },
      plan: plannerOf(platform),
    })
    expect(await shell.supervisor.start(shell.commandId)).toMatchObject({ status: 'running' })
    expect(shell.tree.last.plan).toMatchObject({ file: CMD, args: [], cwd: PROJECT, commandLine: shellCommandLine(CMD, 'npm run build && echo %PORT%') })
  })

  it('fails a start the Windows resolver refuses, and spawns nothing', async () => {
    const platform = windowsPlatform()
    const spy = spyProcessTree()
    for (const execution of [
      { mode: 'shell' as const, shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', script: 'npm run dev' },
      { mode: 'direct' as const, file: 'C:tool.exe', args: [] },
      { mode: 'shell' as const, shell: CMD, script: 'npm run build\r\nnpm run dev' },
    ]) {
      const h = harness({ projectPath: PROJECT, command: { execution }, tree: spy.tree, plan: plannerOf(platform) })
      expect(await h.supervisor.start(h.commandId)).toMatchObject({ status: 'failed' })
      expect(h.statuses()).toEqual(['starting', 'failed'])
    }
    expect(spy.calls).toEqual([])
  })
})
