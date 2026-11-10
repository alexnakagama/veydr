import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SpawnError } from '../../src/main/platform/errors'
import { createHelperCheck, createHelperPortsReader, PORTS_TIMEOUT_MS, runHelperTool, type HelperCheck, type HelperToolOptions } from '../../src/main/platform/windows/helper-tool'
import { createWindowsProcessTree } from '../../src/main/platform/windows/process-tree'
import { MAX_PORTS_OUTPUT_BYTES, MAX_TOOL_OUTPUT_BYTES, PROTOCOL_VERSION, ProtocolError } from '../../src/main/platform/windows/protocol'

// The helper's short-lived subcommands, shared by the process tree and the port listing
// (add-windows-port-inspection design D6, task 1.2): one version check per helper file for every
// user of the helper, and `runHelperTool` with a per-call output limit. The process tree's use of
// both is covered by windows-process-tree.test.ts.

let dir: string
let helperPath: string
let versionReads: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'veydr-wht-'))
  helperPath = join(dir, 'veydr-helper.exe')
  writeFileSync(helperPath, 'not really a helper')
  versionReads = 0
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const readVersion = (version = `${PROTOCOL_VERSION}\r\n`) => (): Promise<string> => {
  versionReads++
  return Promise.resolve(version)
}

async function rejection(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: unknown) => error,
  )
}

describe('createHelperCheck', () => {
  it('names the helper it checks', () => {
    expect(createHelperCheck(helperPath, readVersion()).helperPath).toBe(helperPath)
  })

  it('reads the version once for every caller, also concurrent ones, and again after the file changes', async () => {
    const check = createHelperCheck(helperPath, readVersion())
    await Promise.all([check.verify(), check.verify(), check.verify()])
    await check.verify()
    expect(versionReads).toBe(1)
    writeFileSync(helperPath, 'a rebuilt helper, of another size')
    utimesSync(helperPath, new Date(), new Date(Date.now() + 5_000))
    await check.verify()
    expect(versionReads).toBe(2)
  })

  it('refuses another protocol version with a SpawnError naming both versions, and does not remember the failure', async () => {
    // A version 2 helper, built before `ports` existed (add-windows-port-inspection design D2).
    const stale = PROTOCOL_VERSION - 1
    expect(stale).toBe(2)
    let version = `${stale}\n`
    const check = createHelperCheck(helperPath, () => {
      versionReads++
      return Promise.resolve(version)
    })
    const error = await rejection(check.verify())
    expect(error).toBeInstanceOf(SpawnError)
    expect((error as Error).message).toBe(`The Windows helper ${helperPath} speaks protocol version ${stale}, but Veydr needs version ${PROTOCOL_VERSION}`)
    version = `${PROTOCOL_VERSION}\n`
    await check.verify()
    expect(versionReads).toBe(2)
  })

  it('refuses a missing helper, a relative path and an empty path without reading a version', async () => {
    rmSync(helperPath)
    for (const [path, message] of [
      [helperPath, `Windows helper not found: ${helperPath}`],
      ['veydr-helper.exe', 'The Windows helper path must be absolute: veydr-helper.exe'],
      ['', 'The Windows helper path is not configured'],
    ] as const) {
      const error = await rejection(createHelperCheck(path, readVersion()).verify())
      expect(error, path).toBeInstanceOf(SpawnError)
      expect((error as Error).message, path).toBe(message)
    }
    expect(versionReads).toBe(0)
  })
})

describe('the process tree with a shared check', () => {
  const plan = () => ({ file: process.execPath, args: [], cwd: dir, env: {} })

  it('uses the check it is given, so one version read serves every user of the helper', async () => {
    const check = createHelperCheck(helperPath, readVersion('1\n'))
    const tree = createWindowsProcessTree({ helperPath, helperCheck: check, spawnHelper: () => expect.fail('nothing may start') })
    await expect(tree.spawn(plan())).rejects.toThrow(/speaks protocol version 1/)
    await expect(check.verify()).rejects.toThrow(/speaks protocol version 1/)
    // The failure is not remembered, so each call read the version again; the tree read it through the check.
    expect(versionReads).toBe(2)
  })

  it('refuses a check of another helper file, so it never runs a helper whose version nobody read', () => {
    const other = join(dir, 'other', 'veydr-helper.exe')
    expect(() => createWindowsProcessTree({ helperPath, helperCheck: createHelperCheck(other, readVersion()) })).toThrow(
      new RangeError(`The helper check is for ${other}, but the process tree runs ${helperPath}`),
    )
  })

  it('refuses both a check and a version reader, which would be ignored', () => {
    expect(() => createWindowsProcessTree({ helperPath, helperCheck: createHelperCheck(helperPath, readVersion()), readHelperVersion: readVersion() })).toThrow(RangeError)
  })
})

/** A helper child that prints `stdout` and exits with `code` once its stdin is closed. */
class FakeTool extends EventEmitter {
  readonly pid = 5150
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly kills: unknown[] = []
  input = ''

  stdinClosed = false

  /** With `hang`, it never prints or exits on its own, like a hung helper. */
  constructor(stdout: string | Buffer, code = 0, hang = false) {
    super()
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (text: string) => (this.input += text))
    this.stdin.on('end', () => {
      this.stdinClosed = true
      if (hang) return
      this.stdout.end(stdout)
      this.stderr.end()
      this.exitCode = code
      setImmediate(() => this.emit('close', code, null))
    })
  }

  kill(signal?: unknown): boolean {
    this.kills.push(signal)
    this.signalCode = 'SIGKILL'
    setImmediate(() => this.emit('close', null, 'SIGKILL'))
    return true
  }
}

describe('runHelperTool', () => {
  const run = (stdout: string | Buffer, extra: Partial<HelperToolOptions> = {}) => {
    const children: FakeTool[] = []
    const calls: { args: readonly string[]; options: SpawnOptions }[] = []
    const pending = runHelperTool(helperPath, ['inspect'], 'input\n', {
      spawnHelper: (_file, args, options) => {
        calls.push({ args, options })
        const child = new FakeTool(stdout)
        children.push(child)
        return child as unknown as ChildProcess
      },
      timeoutMs: 5_000,
      ...extra,
    })
    return { pending, children, calls }
  }

  it('runs the helper hidden, not detached and without a shell, and resolves with its stdout', async () => {
    const { pending, children, calls } = run('{"ok":true}\n')
    await expect(pending).resolves.toBe('{"ok":true}\n')
    expect(calls).toEqual([{ args: ['inspect'], options: { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: false, shell: false } }])
    expect(children[0]?.input).toBe('input\n')
  })

  it('accepts output up to MAX_TOOL_OUTPUT_BYTES by default and refuses more, killing the helper', async () => {
    await expect(run('x'.repeat(MAX_TOOL_OUTPUT_BYTES)).pending).resolves.toHaveLength(MAX_TOOL_OUTPUT_BYTES)
    const over = run('x'.repeat(MAX_TOOL_OUTPUT_BYTES + 1))
    const error = await rejection(over.pending)
    expect(error).toBeInstanceOf(ProtocolError)
    expect((error as Error).message).toBe(`The Windows helper's inspect printed more than ${MAX_TOOL_OUTPUT_BYTES} bytes`)
  })

  it('applies a call\'s own output limit, above or below the default', async () => {
    await expect(run('x'.repeat(MAX_TOOL_OUTPUT_BYTES + 1), { maxOutputBytes: MAX_TOOL_OUTPUT_BYTES + 1 }).pending).resolves.toHaveLength(MAX_TOOL_OUTPUT_BYTES + 1)
    await expect(run('12345', { maxOutputBytes: 5 }).pending).resolves.toBe('12345')
    await expect(run('123456', { maxOutputBytes: 5 }).pending).rejects.toThrow("The Windows helper's inspect printed more than 5 bytes")
  })

  it('refuses a limit or a time limit that is not a positive integer, before starting anything', async () => {
    for (const extra of [{ maxOutputBytes: 0 }, { maxOutputBytes: -1 }, { maxOutputBytes: 1.5 }, { maxOutputBytes: Number.NaN }, { maxOutputBytes: Number.POSITIVE_INFINITY }, { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 1.5 }, { timeoutMs: Number.NaN }, { timeoutMs: Number.POSITIVE_INFINITY }]) {
      const { pending, calls } = run('', extra)
      await expect(pending, JSON.stringify(extra)).rejects.toThrow(RangeError)
      expect(calls, JSON.stringify(extra)).toEqual([])
    }
  })

  it('refuses output that is not UTF-8', async () => {
    await expect(run(Buffer.from([0xff, 0xfe, 0x0a])).pending).rejects.toThrow("The Windows helper's inspect output is not valid UTF-8")
  })
})

describe('createHelperPortsReader (add-windows-port-inspection design D6, task 3.2)', () => {
  const LISTING = '{"type":"ports","takenAt":"133485408000000000","listeners":[],"owners":[]}\n'
  const passing: HelperCheck = { get helperPath() { return helperPath }, verify: () => Promise.resolve() }

  /** A reader over fake helpers; `make` builds each child the reader starts. */
  const reader = (make: () => FakeTool, check: HelperCheck = passing) => {
    const children: FakeTool[] = []
    const calls: { file: string; args: readonly string[]; options: SpawnOptions }[] = []
    const read = createHelperPortsReader({
      helperPath,
      check,
      spawnHelper: (file, args, options) => {
        calls.push({ file, args, options })
        const child = make()
        children.push(child)
        return child as unknown as ChildProcess
      },
    })
    return { read, children, calls }
  }

  /** `error` is a plain Error, not a SpawnError or ProtocolError, whose message names the helper. */
  const expectPlainHelperError = (error: unknown, message: string | RegExp): void => {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).constructor).toBe(Error)
    expect(error).not.toBeInstanceOf(SpawnError)
    expect((error as Error).message).toMatch(/Windows helper/)
    expect((error as Error).message).toMatch(message)
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs exactly `<helper> ports`, hidden, not detached and without a shell, with stdin closed empty, and resolves with its stdout', async () => {
    const { read, children, calls } = reader(() => new FakeTool(LISTING))
    await expect(read()).resolves.toBe(LISTING)
    expect(calls).toEqual([{ file: helperPath, args: ['ports'], options: { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: false, shell: false } }])
    expect(children[0]?.input).toBe('')
    expect(children[0]?.stdinClosed).toBe(true)
    expect(children[0]?.kills).toEqual([])
  })

  it('starts one helper per listing', async () => {
    const { read, calls } = reader(() => new FakeTool(LISTING))
    await read()
    await read()
    expect(calls.map((call) => call.args)).toEqual([['ports'], ['ports']])
  })

  it('kills only the helper it started when it takes longer than PORTS_TIMEOUT_MS, and rejects', async () => {
    vi.useFakeTimers()
    const { read, children, calls } = reader(() => new FakeTool('', 0, true))
    const pending = rejection(read())
    await vi.advanceTimersByTimeAsync(PORTS_TIMEOUT_MS - 1)
    expect(children[0]?.kills).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expectPlainHelperError(await pending, `The Windows helper's ports did not finish within ${PORTS_TIMEOUT_MS} ms`)
    expect(calls).toHaveLength(1)
    expect(children[0]?.kills).toEqual(['SIGKILL'])
  })

  it('rejects an exit code other than 0 with a plain Error naming the helper', async () => {
    const { read } = reader(() => new FakeTool('', 1))
    expectPlainHelperError(await rejection(read()), "The Windows helper's ports failed (exit code 1)")
  })

  it('accepts output up to MAX_PORTS_OUTPUT_BYTES and rejects more with a plain Error naming the helper, killing it', async () => {
    expect(MAX_PORTS_OUTPUT_BYTES).toBe(16 * 1024 * 1024)
    await expect(reader(() => new FakeTool('x'.repeat(MAX_PORTS_OUTPUT_BYTES))).read()).resolves.toHaveLength(MAX_PORTS_OUTPUT_BYTES)
    const over = reader(() => new FakeTool('x'.repeat(MAX_PORTS_OUTPUT_BYTES + 1)))
    const error = await rejection(over.read())
    expectPlainHelperError(error, `The Windows helper's ports printed more than ${MAX_PORTS_OUTPUT_BYTES} bytes`)
    expect((error as Error).cause).toBeInstanceOf(ProtocolError)
  })

  it('rejects a stale helper with a plain Error naming both versions, and starts nothing', async () => {
    const check = createHelperCheck(helperPath, readVersion(`${PROTOCOL_VERSION - 1}\n`))
    const { read, calls } = reader(() => expect.fail('nothing may start'), check)
    const error = await rejection(read())
    expectPlainHelperError(error, `The Windows helper ${helperPath} speaks protocol version ${PROTOCOL_VERSION - 1}, but Veydr needs version ${PROTOCOL_VERSION}`)
    expect((error as Error).cause).toBeInstanceOf(SpawnError)
    expect(calls).toEqual([])
  })

  it('rejects a missing helper with a plain Error, and starts nothing', async () => {
    rmSync(helperPath)
    const { read, calls } = reader(() => expect.fail('nothing may start'), createHelperCheck(helperPath, readVersion()))
    expectPlainHelperError(await rejection(read()), `Windows helper not found: ${helperPath}`)
    expect(calls).toEqual([])
  })

  it('rejects a helper that cannot be started with a plain Error', async () => {
    const read = createHelperPortsReader({
      helperPath,
      check: passing,
      spawnHelper: () => {
        throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })
      },
    })
    expectPlainHelperError(await rejection(read()), "The Windows helper's ports could not be started: spawn EACCES")
  })

  it('shares the version read with the process tree through one check', async () => {
    const check = createHelperCheck(helperPath, readVersion())
    const { read } = reader(() => new FakeTool(LISTING), check)
    await Promise.all([read(), read(), check.verify()])
    expect(versionReads).toBe(1)
  })

  it('refuses a check of another helper file, so it never runs a helper whose version nobody read', () => {
    const other = join(dir, 'other', 'veydr-helper.exe')
    expect(() => createHelperPortsReader({ helperPath, check: createHelperCheck(other, readVersion()) })).toThrow(
      new RangeError(`The helper check is for ${other}, but the ports reader runs ${helperPath}`),
    )
  })
})
