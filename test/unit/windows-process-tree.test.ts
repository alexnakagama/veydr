import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SpawnError } from '../../src/main/platform/errors'
import type { LedgerEntry, ProcessIdentity, SpawnPlan, Survivor } from '../../src/main/platform/types'
import { CommandLineError } from '../../src/main/platform/windows/command-line'
import { createWindowsProcessTree, isFullyQualified, runHelperVersion, type WindowsProcessTreeOptions } from '../../src/main/platform/windows/process-tree'
import { MAX_GRACE_MS, MAX_TOOL_IDENTITIES, MAX_TOOL_OUTPUT_BYTES, PROTOCOL_VERSION } from '../../src/main/platform/windows/protocol'
import { localSockets } from '../support/local-socket'

// The Windows process tree's checks before a command starts (add-windows-process-supervision design
// D5, task 3.2): a missing helper or one that speaks another protocol version is refused, and no
// helper process is started. The run itself is covered by windows-helper-client.test.ts.

let dir: string
let helperPath: string
let sockets: ReturnType<typeof localSockets>
let spawned: { file: string; args: readonly string[] }[]
let versionReads: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'veydr-wpt-'))
  helperPath = join(dir, 'veydr-helper.exe')
  writeFileSync(helperPath, 'not really a helper')
  sockets = localSockets()
  spawned = []
  versionReads = []
})

afterEach(() => {
  sockets.cleanup()
  rmSync(dir, { recursive: true, force: true })
})

/** A helper process that Node failed to create, as `child_process.spawn` reports one. */
function unstartableHelper(): ChildProcess {
  const child = new EventEmitter() as EventEmitter & { pid: undefined; stdout: PassThrough; stderr: PassThrough }
  child.pid = undefined
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  setImmediate(() => child.emit('error', new Error('spawn failed in the test')))
  return child as unknown as ChildProcess
}

function options(version: string | (() => Promise<string>) = `${PROTOCOL_VERSION}\r\n`): WindowsProcessTreeOptions {
  return {
    helperPath,
    pipePath: () => sockets.next(),
    readHelperVersion: (path) => {
      versionReads.push(path)
      return typeof version === 'string' ? Promise.resolve(version) : version()
    },
    spawnHelper: (file, args) => {
      spawned.push({ file, args })
      return unstartableHelper()
    },
  }
}

const plan = (): SpawnPlan => ({ file: process.execPath, args: ['server.js'], cwd: dir, env: {} })

async function spawnError(pending: Promise<unknown>): Promise<SpawnError> {
  const error = await pending.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(SpawnError)
  return error as SpawnError
}

describe('a missing helper', () => {
  it('rejects with "Windows helper not found" and starts nothing', async () => {
    rmSync(helperPath)
    const error = await spawnError(createWindowsProcessTree(options()).spawn(plan()))
    expect(error).toMatchObject({ reason: 'other', message: `Windows helper not found: ${helperPath}` })
    expect(versionReads).toEqual([])
    expect(spawned).toEqual([])
  })

  it('treats a directory in the helper\'s place as missing', async () => {
    rmSync(helperPath)
    mkdirSync(helperPath)
    const error = await spawnError(createWindowsProcessTree(options()).spawn(plan()))
    expect(error.message).toBe(`Windows helper not found: ${helperPath}`)
    expect(spawned).toEqual([])
  })
})

describe('the helper path', () => {
  it('must be absolute, so that it is never looked up on PATH', async () => {
    const error = await spawnError(createWindowsProcessTree({ ...options(), helperPath: 'veydr-helper.exe' }).spawn(plan()))
    expect(error).toMatchObject({ reason: 'other', message: 'The Windows helper path must be absolute: veydr-helper.exe' })
    expect(versionReads).toEqual([])
    expect(spawned).toEqual([])
  })
})

describe('full paths', () => {
  it('accept a drive path or a UNC path, as the helper does', () => {
    for (const path of ['C:\\Program Files\\nodejs\\node.exe', 'c:/tools/node.exe', '\\\\server\\share\\node.exe', '//server/share/node.exe']) {
      expect(isFullyQualified(path), path).toBe(true)
    }
  })

  it('refuse a drive-relative, root-relative, or bare path', () => {
    for (const path of ['C:node.exe', '\\node.exe', '\\\\', 'node.exe', '.\\node.exe', '']) {
      expect(isFullyQualified(path), path).toBe(false)
    }
  })
})

describe('the helper\'s protocol version', () => {
  it('rejects a helper that speaks another version, and starts no run', async () => {
    const error = await spawnError(createWindowsProcessTree(options('3\n')).spawn(plan()))
    expect(error).toMatchObject({
      reason: 'other',
      message: `The Windows helper ${helperPath} speaks protocol version 3, but Veydr needs version ${PROTOCOL_VERSION}`,
    })
    expect(versionReads).toEqual([helperPath])
    expect(spawned).toEqual([])
  })

  it('rejects a stale version 1 helper by name, and starts no run', async () => {
    expect(PROTOCOL_VERSION).toBe(2)
    const error = await spawnError(createWindowsProcessTree(options('1\r\n')).spawn(plan()))
    expect(error).toMatchObject({ reason: 'other', message: `The Windows helper ${helperPath} speaks protocol version 1, but Veydr needs version 2` })
    expect(spawned).toEqual([])
  })

  it('shows unexpected version output quoted and shortened', async () => {
    const error = await spawnError(createWindowsProcessTree(options(`usage: veydr-helper ${'x'.repeat(100)}`)).spawn(plan()))
    expect(error.message).toBe(`The Windows helper ${helperPath} speaks protocol version ${JSON.stringify(`usage: veydr-helper ${'x'.repeat(20)}`)}, but Veydr needs version ${PROTOCOL_VERSION}`)
    expect(spawned).toEqual([])
  })

  it('rejects a helper that cannot report its version', async () => {
    const error = await spawnError(createWindowsProcessTree(options(() => Promise.reject(new Error('exited with 2')))).spawn(plan()))
    expect(error.message).toBe(`The Windows helper ${helperPath} could not report its protocol version: exited with 2`)
    expect(spawned).toEqual([])
  })

  it('runs the real version command, which fails for a file that is no program', async () => {
    await expect(runHelperVersion(helperPath)).rejects.toThrow()
  })

  it('starts the run once the version matches', async () => {
    const error = await spawnError(createWindowsProcessTree(options()).spawn(plan()))
    // The fake helper could not be started; what matters is that the run was attempted.
    expect(error.message).toBe(`Could not start the Windows helper ${helperPath}: spawn failed in the test`)
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.file).toBe(helperPath)
    // Version 2: only the pipe is an argument; the command goes over stdin (design D1).
    expect(spawned[0]?.args).toHaveLength(2)
    expect(spawned[0]?.args[0]).toBe('run')
  })

  it('reads the version once per helper file, and again after the file changes', async () => {
    const tree = createWindowsProcessTree(options())
    await Promise.all([spawnError(tree.spawn(plan())), spawnError(tree.spawn(plan()))])
    await spawnError(tree.spawn(plan()))
    expect(versionReads).toHaveLength(1)

    writeFileSync(helperPath, 'a rebuilt helper')
    utimesSync(helperPath, new Date(), new Date(Date.now() + 60_000))
    await spawnError(tree.spawn(plan()))
    expect(versionReads).toHaveLength(2)
    expect(spawned).toHaveLength(4)
  })

  it('does not remember a failed check', async () => {
    let answer = Promise.reject<string>(new Error('busy'))
    answer.catch(() => undefined)
    const tree = createWindowsProcessTree(options(() => answer))
    await spawnError(tree.spawn(plan()))
    answer = Promise.resolve(`${PROTOCOL_VERSION}\n`)
    await spawnError(tree.spawn(plan()))
    expect(versionReads).toHaveLength(2)
    expect(spawned).toHaveLength(1)
  })
})

describe('the command', () => {
  const failure = async (overrides: Partial<SpawnPlan>): Promise<SpawnError> => {
    const error = await spawnError(createWindowsProcessTree(options()).spawn({ ...plan(), ...overrides }))
    expect(spawned).toEqual([])
    return error
  }

  it('must be given by its full path', async () => {
    expect(await failure({ file: 'node.exe' })).toMatchObject({ reason: 'executable-not-found', message: 'Executable not found: node.exe (a full path is needed)' })
  })

  it('must exist and be a file', async () => {
    const missing = join(dir, 'missing.exe')
    expect(await failure({ file: missing })).toMatchObject({ reason: 'executable-not-found', message: `Executable not found: ${missing}` })
    expect(await failure({ file: dir })).toMatchObject({ reason: 'not-executable', message: `Not an executable file: ${dir}` })
  })

  it('needs an existing working directory, reported as such rather than as a missing helper', async () => {
    const gone = join(dir, 'gone')
    expect(await failure({ cwd: gone })).toMatchObject({ reason: 'cwd-missing', message: `Working directory does not exist: ${gone}` })
    expect(await failure({ cwd: helperPath })).toMatchObject({ reason: 'cwd-not-directory', message: `Working directory is not a directory: ${helperPath}` })
  })

  it('may not contain a NUL character', async () => {
    expect(await failure({ args: ['a\0b'] })).toMatchObject({ reason: 'other', message: `Could not start ${process.execPath}: the command contains a NUL character` })
    expect(await failure({ commandLine: `"${process.execPath}" a\0b` })).toMatchObject({ reason: 'other', message: `Could not start ${process.execPath}: the command contains a NUL character` })
  })

  it('refuses a batch file without a command line built for cmd.exe, as the helper does', async () => {
    // Refused before the file system is read: none of these exists.
    for (const name of ['build.bat', 'npm.CMD', 'run.cmd. .']) {
      const error = await failure({ file: join(dir, name) })
      expect(error, name).toBeInstanceOf(CommandLineError)
      expect((error as CommandLineError).refusal, name).toBe('batch-file-program')
      expect(error.message, name).toContain('can only run through cmd.exe')
    }
  })

  it('refuses what the plan alone shows before reading the helper\'s version', async () => {
    await failure({ file: join(dir, 'build.bat') })
    await failure({ args: ['a\0b'] })
    await failure({ file: 'node.exe' })
    expect(versionReads).toEqual([])
  })

  it('refuses a planned command line that does not start with the program', async () => {
    const error = await failure({ commandLine: '"C:\\Windows\\System32\\cmd.exe" /c whoami' })
    expect((error as CommandLineError).refusal).toBe('command-line-mismatch')
  })
})

it('checks the helper before the command', async () => {
  rmSync(helperPath)
  const error = await spawnError(createWindowsProcessTree(options()).spawn({ ...plan(), cwd: join(dir, 'gone') }))
  expect(error.message).toBe(`Windows helper not found: ${helperPath}`)
})

// Crash recovery on Windows (design D4, task 5.1): `findSurvivors` and `terminateSurvivors` run the
// helper's `inspect` and `terminate` subcommands. A fake helper answers on its stdio here; the
// real one runs against real processes in test/integration/windows-process-tree.test.ts.
describe('survivors', () => {
  const LEADER = { pid: 4244, created: '134067012345678901', image: 'C:\\Program Files\\nodejs\\node.exe' }
  const CHILD = { pid: 4248, created: '134067012345678999', image: '' }
  const SELF = 777

  type Answer = { readonly stdout?: string | Buffer; readonly stderr?: string; readonly code?: number } | 'hang'
  interface ToolCall {
    readonly args: readonly string[]
    readonly options: SpawnOptions
    input: string
    readonly child: FakeTool
  }

  /** A short-lived helper subcommand: it reads stdin to its end, then answers and exits. */
  class FakeTool extends EventEmitter {
    readonly pid = 5150
    readonly stdin = new PassThrough()
    readonly stdout = new PassThrough()
    readonly stderr = new PassThrough()
    exitCode: number | null = null
    signalCode: NodeJS.Signals | null = null
    readonly kills: unknown[] = []

    kill(signal?: unknown): boolean {
      this.kills.push(signal)
      this.signalCode = 'SIGKILL'
      setImmediate(() => this.emit('close', null, 'SIGKILL'))
      return true
    }

    finish(answer: Exclude<Answer, 'hang'>): void {
      if (answer.stdout !== undefined) this.stdout.write(answer.stdout)
      if (answer.stderr !== undefined) this.stderr.write(answer.stderr)
      this.stdout.end()
      this.stderr.end()
      this.exitCode = answer.code ?? 0
      this.emit('exit', this.exitCode, null)
      setImmediate(() => this.emit('close', this.exitCode, null))
    }
  }

  let calls: ToolCall[]

  function survivorOptions(answer: (call: ToolCall) => Answer, extra: Partial<WindowsProcessTreeOptions> = {}): WindowsProcessTreeOptions {
    return {
      ...options(),
      selfPid: SELF,
      spawnHelper: (file, args, spawnOptions) => {
        expect(file).toBe(helperPath)
        const child = new FakeTool()
        const call: ToolCall = { args, options: spawnOptions, input: '', child }
        calls.push(call)
        child.stdin.setEncoding('utf8')
        child.stdin.on('data', (text: string) => (call.input += text))
        child.stdin.on('end', () => {
          const result = answer(call)
          if (result !== 'hang') child.finish(result)
        })
        return child as unknown as ChildProcess
      },
      ...extra,
    }
  }

  beforeEach(() => {
    calls = []
  })

  const identity = (m: { pid: number; created: string }): ProcessIdentity => ({ pid: m.pid, token: m.created })
  const entry = (leader: ProcessIdentity, descendants: ProcessIdentity[] = [], runId = 'run-1'): LedgerEntry => ({
    commandId: 'cmd-1',
    runId,
    leader,
    sessionId: null,
    descendants,
  })
  const inspected = (...processes: object[]): string => `${JSON.stringify({ type: 'inspected', processes })}\n`
  const terminated = (graceful: 'yes' | 'no', forced: boolean, ...survivors: object[]): string =>
    `${JSON.stringify({ type: 'terminated', graceful, forced, survivors })}\n`
  const sentIdentities = (call: ToolCall | undefined): unknown => JSON.parse(call?.input ?? 'null')

  describe('findSurvivors', () => {
    it('asks the helper once about every recorded identity, and maps the live ones back to their runs', async () => {
      const tree = createWindowsProcessTree(survivorOptions(() => ({ stdout: inspected(LEADER, CHILD) })))
      const gone = { pid: 4300, token: '134067012345670000' }
      const found = await tree.findSurvivors([entry(identity(LEADER), [identity(CHILD), gone]), entry(identity(CHILD), [], 'run-2')])

      expect(calls).toHaveLength(1)
      expect(calls[0]?.args).toEqual(['inspect'])
      expect(calls[0]?.options).toMatchObject({ windowsHide: true, detached: false, shell: false })
      // Each identity once, as pid and creation time only.
      expect(sentIdentities(calls[0])).toEqual([
        { pid: LEADER.pid, created: LEADER.created },
        { pid: CHILD.pid, created: CHILD.created },
        { pid: gone.pid, created: gone.token },
      ])
      expect(found).toEqual([
        { commandId: 'cmd-1', runId: 'run-1', identity: identity(LEADER), info: { pid: LEADER.pid, name: 'node.exe', commandLine: LEADER.image } },
        // An unreadable image is shown by its PID; a process recorded twice is reported once.
        { commandId: 'cmd-1', runId: 'run-1', identity: identity(CHILD), info: { pid: CHILD.pid, name: `PID ${CHILD.pid}`, commandLine: '' } },
      ])
    })

    it('runs no helper for no entries, other platforms\' identities, or only this process', async () => {
      const tree = createWindowsProcessTree(survivorOptions(() => ({ stdout: inspected() })))
      const linux = { pid: 4244, token: 'b1f2c3d4-0000-4000-8000-000000000000:12345' }
      expect(await tree.findSurvivors([])).toEqual([])
      expect(await tree.findSurvivors([entry(linux), entry({ pid: SELF, token: LEADER.created })])).toEqual([])
      expect(calls).toEqual([])
    })

    it('splits more identities than one call may carry across several calls', async () => {
      const descendants = Array.from({ length: MAX_TOOL_IDENTITIES + 1 }, (_, i) => ({ pid: 10_000 + i, token: LEADER.created }))
      const tree = createWindowsProcessTree(survivorOptions(() => ({ stdout: inspected() })))
      expect(await tree.findSurvivors([entry(identity(LEADER), descendants)])).toEqual([])
      expect(calls.map((call) => (sentIdentities(call) as unknown[]).length)).toEqual([MAX_TOOL_IDENTITIES, 2])
    })

    it('refuses an invalid time limit', () => {
      for (const inspectTimeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_GRACE_MS + 1]) {
        expect(() => createWindowsProcessTree({ ...options(), inspectTimeoutMs }), String(inspectTimeoutMs)).toThrow(RangeError)
      }
      for (const stopMarginMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => createWindowsProcessTree({ ...options(), stopMarginMs }), String(stopMarginMs)).toThrow(RangeError)
      }
    })

    it('refuses a helper that reports a process it was not asked about', async () => {
      const tree = createWindowsProcessTree(survivorOptions(() => ({ stdout: inspected(LEADER, { ...CHILD, created: '134067012345679000' }) })))
      await expect(tree.findSurvivors([entry(identity(LEADER), [identity(CHILD)])])).rejects.toThrow(/reported process 4248, which inspect was not asked about/)
    })

    it('rejects malformed output, a failed helper, and too much output', async () => {
      const cases: [Answer, RegExp][] = [
        [{ stdout: 'garbage\n' }, /Not a JSON/],
        [{ stdout: inspected().trimEnd() }, /not one complete line/],
        [{ stdout: Buffer.from([0xff, 0x0a]) }, /inspect output is not valid UTF-8/],
        [{ stderr: 'veydr-helper: stdin holds a malformed identity at offset 1\n', code: 1 }, /inspect failed \(exit code 1\): veydr-helper: stdin holds a malformed identity at offset 1$/],
        [{ stdout: 'x'.repeat(MAX_TOOL_OUTPUT_BYTES + 1) }, /printed more than/],
      ]
      for (const [answer, message] of cases) {
        const tree = createWindowsProcessTree(survivorOptions(() => answer))
        await expect(tree.findSurvivors([entry(identity(LEADER))]), JSON.stringify(answer).slice(0, 80)).rejects.toThrow(message)
      }
    })

    it('kills a helper that does not answer in time', async () => {
      const tree = createWindowsProcessTree(survivorOptions(() => 'hang', { inspectTimeoutMs: 50 }))
      await expect(tree.findSurvivors([entry(identity(LEADER))])).rejects.toThrow("The Windows helper's inspect did not finish within 50 ms")
      expect(calls[0]?.child.kills).toEqual(['SIGKILL'])
    })

    it('refuses a missing or mismatched helper before running anything', async () => {
      rmSync(helperPath)
      await expect(createWindowsProcessTree(survivorOptions(() => ({ stdout: inspected() }))).findSurvivors([entry(identity(LEADER))])).rejects.toThrow(
        `Windows helper not found: ${helperPath}`,
      )
      writeFileSync(helperPath, 'a helper')
      await expect(
        createWindowsProcessTree(survivorOptions(() => ({ stdout: inspected() }), { readHelperVersion: () => Promise.resolve('3\n') })).findSurvivors([
          entry(identity(LEADER)),
        ]),
      ).rejects.toThrow(/speaks protocol version 3/)
      expect(calls).toEqual([])
    })
  })

  describe('terminateSurvivors', () => {
    const survivor = (m: { pid: number; created: string }): Survivor => ({
      commandId: 'cmd-1',
      runId: 'run-1',
      identity: identity(m),
      info: { pid: m.pid, name: 'node.exe', commandLine: '' },
    })

    it('passes the default stop timeout and the identities, and reports the result', async () => {
      const tree = createWindowsProcessTree(survivorOptions(() => ({ stdout: terminated('no', true, CHILD) })))
      expect(await tree.terminateSurvivors([survivor(LEADER), survivor(CHILD), survivor(CHILD)])).toEqual({
        graceful: 'no',
        forced: true,
        survivors: [{ pid: CHILD.pid, name: `PID ${CHILD.pid}`, commandLine: '' }],
      })
      expect(calls[0]?.args[0]).toBe('terminate')
      expect(Number(calls[0]?.args[1])).toBeGreaterThan(4_000)
      expect(sentIdentities(calls[0])).toEqual([
        { pid: LEADER.pid, created: LEADER.created },
        { pid: CHILD.pid, created: CHILD.created },
      ])
    })

    it('passes a configured grace period', async () => {
      const tree = createWindowsProcessTree(survivorOptions(() => ({ stdout: terminated('yes', false) }), { survivorGraceMs: 0 }))
      expect(await tree.terminateSurvivors([survivor(LEADER)])).toEqual({ graceful: 'yes', forced: false, survivors: [] })
      expect(calls[0]?.args).toEqual(['terminate', '0'])
      expect(() => createWindowsProcessTree({ ...options(), survivorGraceMs: -1 })).toThrow(RangeError)
      expect(() => createWindowsProcessTree({ ...options(), survivorGraceMs: MAX_GRACE_MS + 1 })).toThrow(RangeError)
    })

    it('ends nothing for no survivors, other platforms\' identities, or this process', async () => {
      const tree = createWindowsProcessTree(survivorOptions(() => ({ stdout: terminated('yes', false) })))
      expect(await tree.terminateSurvivors([])).toEqual({ graceful: 'yes', forced: false, survivors: [] })
      expect(await tree.terminateSurvivors([{ ...survivor(LEADER), identity: { pid: SELF, token: LEADER.created } }])).toEqual({
        graceful: 'yes',
        forced: false,
        survivors: [],
      })
      expect(await tree.terminateSurvivors([{ ...survivor(LEADER), identity: { pid: LEADER.pid, token: 'boot:123' } }])).toEqual({
        graceful: 'yes',
        forced: false,
        survivors: [],
      })
      expect(calls).toEqual([])
    })

    it('refuses a helper that reports a survivor it was not asked to end', async () => {
      const tree = createWindowsProcessTree(survivorOptions(() => ({ stdout: terminated('no', true, CHILD) })))
      await expect(tree.terminateSurvivors([survivor(LEADER)])).rejects.toThrow(/which terminate was not asked about/)
    })

    it('rejects a failed helper with its message', async () => {
      const tree = createWindowsProcessTree(survivorOptions(() => ({ stderr: 'veydr-helper: unexpected failure: boom', code: 1 })))
      await expect(tree.terminateSurvivors([survivor(LEADER)])).rejects.toThrow("The Windows helper's terminate failed (exit code 1): veydr-helper: unexpected failure: boom")
    })

    it('waits for a helper whose grace period exceeds what one timer can hold', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      try {
        const tree = createWindowsProcessTree(survivorOptions(() => 'hang', { survivorGraceMs: MAX_GRACE_MS }))
        const pending = tree.terminateSurvivors([survivor(LEADER)])
        pending.catch(() => undefined)
        await vi.waitFor(() => expect(calls).toHaveLength(1))
        // The grace period counts from the call, so the helper check may already have used a little.
        const graceMs = Number(calls[0]?.args[1])
        expect(graceMs).toBeGreaterThan(MAX_GRACE_MS - 1_000)
        // A clamped or overflowing timer would have fired by now and killed the helper.
        await vi.advanceTimersByTimeAsync(graceMs)
        expect(calls[0]?.child.kills).toEqual([])
        await vi.advanceTimersByTimeAsync(2_000 + 5_000)
        await expect(pending).rejects.toThrow(`did not finish within ${graceMs + 7_000} ms`)
        expect(calls[0]?.child.kills).toEqual(['SIGKILL'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('reports forced: false when nothing had to be terminated, as the helper answers', async () => {
      const tree = createWindowsProcessTree(survivorOptions(() => ({ stdout: terminated('no', false, LEADER) })))
      expect(await tree.terminateSurvivors([survivor(LEADER)])).toEqual({
        graceful: 'no',
        forced: false,
        survivors: [{ pid: LEADER.pid, name: 'node.exe', commandLine: LEADER.image }],
      })
    })

    it('refuses an answer naming a survivor of another call', async () => {
      const tree = createWindowsProcessTree(survivorOptions(() => ({ stdout: terminated('no', true, LEADER) })))
      const many = Array.from({ length: MAX_TOOL_IDENTITIES }, (_, i) => survivor({ pid: 10_000 + i, created: CHILD.created }))
      // LEADER is in the second call; the first call reports it.
      await expect(tree.terminateSurvivors([...many, survivor(LEADER)])).rejects.toThrow(/which terminate was not asked about/)
      expect(calls).toHaveLength(1)
    })

    it('combines the answers of several calls, counting the grace period from the first', async () => {
      let n = 0
      const tree = createWindowsProcessTree(survivorOptions(() => ({ stdout: n++ === 0 ? terminated('yes', false) : terminated('no', true, LEADER) })))
      const many = Array.from({ length: MAX_TOOL_IDENTITIES }, (_, i) => survivor({ pid: 10_000 + i, created: CHILD.created }))
      expect(await tree.terminateSurvivors([...many, survivor(LEADER)])).toEqual({
        graceful: 'no',
        forced: true,
        survivors: [{ pid: LEADER.pid, name: 'node.exe', commandLine: LEADER.image }],
      })
      expect(calls).toHaveLength(2)
      const graces = calls.map((call) => Number(call.args[1]))
      expect(graces[0]).toBeGreaterThan(4_000)
      expect(graces[0]).toBeLessThanOrEqual(5_000)
      expect(graces[1]).toBeLessThanOrEqual(graces[0] as number)
    })
  })
})
