import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { connect, createServer, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SpawnError } from '../../src/main/platform/errors'
import { CommandLineError, shellCommandLine } from '../../src/main/platform/windows/command-line'
import { MAX_PENDING_CONNECTIONS, startHelperRun, type HelperClientOptions, type WindowsManagedProcess } from '../../src/main/platform/windows/helper-client'
import { MAX_GRACE_MS, MAX_HANDSHAKE_BYTES, PROTOCOL_VERSION, ProtocolError } from '../../src/main/platform/windows/protocol'
import type { ExitInfo, ManagedProcess, PlatformLog, SpawnPlan } from '../../src/main/platform/types'
import { localSockets } from '../support/local-socket'

// The helper client (add-windows-process-supervision design D2) against a fake helper that speaks
// the protocol over a real local socket: a named pipe on Windows, a Unix socket elsewhere.

const HELPER = 'C:\\veydr\\out-helper\\veydr-helper.exe'
const HELPER_PID = 4240
const LEADER = { pid: 4244, created: '134067012345678901', image: 'C:\\Program Files\\nodejs\\node.exe' }
const CHILD = { pid: 4248, created: '134067012345678999', image: 'C:\\Windows\\System32\\cmd.exe' }
const GRANDCHILD = { pid: 4252, created: '134067012345679100', image: 'C:\\tools\\esbuild.exe' }
/** The `started` fields of protocol version 2 for a console set to UTF-8 (design D5). */
const CONSOLE = { utf8Console: true, ansiCodePage: 1252 } as const
const plan: SpawnPlan = { file: 'C:\\Program Files\\nodejs\\node.exe', args: ['server.js', '--port', '3000'], cwd: 'C:\\work\\app', env: { Path: 'C:\\Windows', SECRET: 'x' } }

type Message = Record<string, unknown>

/** An in-process stand-in for `veydr-helper.exe run`: real stdio streams and a real socket. */
class FakeHelper extends EventEmitter {
  pid: number | undefined = HELPER_PID
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kills: (NodeJS.Signals | number | undefined)[] = []
  /** Lines Veydr sent over the control channel. */
  readonly received: Message[] = []
  socket: Socket | null = null
  exited = false
  private stdinText = ''
  private readonly stdinEnded: Promise<void>
  private receivedWaiters: (() => void)[] = []

  constructor(readonly args: readonly string[]) {
    super()
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (text: string) => (this.stdinText += text))
    this.stdinEnded = once(this.stdin, 'end').then(() => undefined)
  }

  get pipe(): string {
    return this.args[1] ?? ''
  }

  /** Everything Veydr wrote on stdin, once stdin was closed. */
  async stdinContent(): Promise<string> {
    await this.stdinEnded
    return this.stdinText
  }

  /** The token Veydr wrote as the first line on stdin. */
  async token(): Promise<string> {
    return (await this.stdinContent()).split('\n')[0] ?? ''
  }

  /** The run request Veydr wrote as the second line on stdin. */
  async request(): Promise<unknown> {
    return JSON.parse((await this.stdinContent()).split('\n')[1] ?? '') as unknown
  }

  /** Connects to the control pipe; `first` is the handshake line (the real one by default). */
  async connect(first?: string): Promise<Socket> {
    const socket = connect(this.pipe)
    socket.on('error', () => undefined)
    await once(socket, 'connect')
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (text: string) => {
      buffer += text
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        this.received.push(JSON.parse(buffer.slice(0, end)) as Message)
        buffer = buffer.slice(end + 1)
        for (const wake of this.receivedWaiters.splice(0)) wake()
      }
    })
    this.socket = socket
    socket.write(`${first ?? JSON.stringify({ type: 'ready', version: PROTOCOL_VERSION, token: await this.token(), pid: HELPER_PID })}\n`)
    return socket
  }

  send(...messages: Message[]): void {
    this.sendRaw(messages.map((m) => `${JSON.stringify(m)}\n`).join(''))
  }

  sendRaw(text: string): void {
    if (this.socket === null) throw new Error('not connected')
    this.socket.write(text)
  }

  /** Waits until Veydr has sent `count` control lines in total. */
  async receivedCount(count: number): Promise<Message[]> {
    while (this.received.length < count) await new Promise<void>((wake) => this.receivedWaiters.push(wake))
    return this.received
  }

  /** The helper process ends: its end of the channel closes, then it reports its exit. */
  async exit(code: number | null): Promise<void> {
    if (this.exited) return
    this.exited = true
    if (this.socket !== null && !this.socket.destroyed) {
      this.socket.end()
      await once(this.socket, 'close')
    }
    this.emit('exit', code, code === null ? 'SIGKILL' : null)
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal)
    // TerminateProcess: the process and its handles (the pipe) are gone at once.
    this.socket?.destroy()
    setImmediate(() => void this.exit(null))
    return true
  }
}

interface Harness {
  readonly helpers: FakeHelper[]
  readonly spawnCalls: { file: string; args: readonly string[]; options: SpawnOptions }[]
  readonly log: PlatformLog & { events: { level: string; event: string; detail?: Record<string, unknown> }[] }
  options(extra?: Partial<HelperClientOptions>): HelperClientOptions
  nextPipe(): string
}

let sockets: ReturnType<typeof localSockets>
let harness: Harness

beforeEach(() => {
  sockets = localSockets()
  const helpers: FakeHelper[] = []
  const spawnCalls: Harness['spawnCalls'] = []
  const events: Harness['log']['events'] = []
  harness = {
    helpers,
    spawnCalls,
    log: { events, record: (level, event, detail) => events.push({ level, event, ...(detail === undefined ? {} : { detail }) }) },
    nextPipe: () => sockets.next(),
    options(extra = {}) {
      return {
        helperPath: HELPER,
        pipePath: () => sockets.next(),
        spawnHelper: (file, args, options) => {
          spawnCalls.push({ file, args, options })
          const helper = new FakeHelper(args)
          helpers.push(helper)
          return helper as unknown as ChildProcess
        },
        log: harness.log,
        ...extra,
      }
    },
  }
})

afterEach(async () => {
  for (const helper of harness.helpers) {
    helper.socket?.destroy()
    if (!helper.exited) await helper.exit(0)
  }
  sockets.cleanup()
  vi.useRealTimers()
})

/** Spawns a run whose fake helper completes the handshake and reports `started`. */
async function startedRun(extra: Partial<HelperClientOptions> = {}): Promise<{ run: ManagedProcess; helper: FakeHelper }> {
  const pending = start(harness.options(extra))
  const helper = await waitForHelper()
  await helper.connect()
  helper.send({ type: 'started', pid: LEADER.pid, created: LEADER.created, ...CONSOLE })
  return { run: await pending, helper }
}

/** Starts a run; the rejection is handled where the test awaits it, however late. */
function start(options: HelperClientOptions): Promise<ManagedProcess> {
  const pending = startHelperRun(plan, options)
  pending.catch(() => undefined)
  return pending
}

async function waitForHelper(index = 0): Promise<FakeHelper> {
  await vi.waitFor(() => expect(harness.helpers[index]).toBeDefined())
  return harness.helpers[index] as FakeHelper
}

const exitOf = (run: ManagedProcess): Promise<ExitInfo> => new Promise((resolve) => run.onExit(resolve))

async function expectSpawnError(pending: Promise<unknown>, text: string | RegExp): Promise<SpawnError> {
  const error = await pending.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(SpawnError)
  expect((error as SpawnError).message).toMatch(text)
  return error as SpawnError
}

describe('starting the helper', () => {
  it('spawns the helper hidden and attached, with the pipe as argument and the token only on stdin', async () => {
    const { run, helper } = await startedRun()
    const [call] = harness.spawnCalls
    expect(call?.file).toBe(HELPER)
    // Only the pipe is on the helper's command line; the command goes over stdin (design D1).
    expect(call?.args).toEqual(['run', helper.pipe])
    expect(call?.options).toMatchObject({ cwd: plan.cwd, env: plan.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: false, shell: false })
    const token = await helper.token()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(call?.args.join(' ')).not.toContain(token)
    expect(helper.stdin.writableEnded).toBe(true)
    // Exactly two lines: the token, then the request with the complete command line.
    const commandLine = `"${plan.file}" "server.js" "--port" "3000"`
    expect(await helper.stdinContent()).toBe(`${token}\n${JSON.stringify({ application: plan.file, commandLine })}\n`)
    expect(await helper.request()).toEqual({ application: plan.file, commandLine })

    expect(run.pid).toBe(LEADER.pid)
    expect(run.identity).toEqual({ pid: LEADER.pid, token: LEADER.created })
    expect(run.sessionId).toBeNull()
    expect(run.stdout).toBe(helper.stdout)
    expect(run.stderr).toBe(helper.stderr)
  })

  it('uses a new pipe and token for every run', async () => {
    const first = await startedRun()
    const pending = start(harness.options())
    const second = await waitForHelper(1)
    await second.connect()
    second.send({ type: 'started', pid: 5000, created: LEADER.created, ...CONSOLE })
    await pending
    expect(second.pipe).not.toBe(first.helper.pipe)
    expect(await second.token()).not.toBe(await first.helper.token())
  })

  it('accepts no further connection once the helper has proven itself', async () => {
    const { helper } = await startedRun()
    const intruder = connect(helper.pipe)
    // A Unix socket refuses at once. A named pipe still exists while the helper's instance is open,
    // so the client waits for a free instance that never comes. Either way nothing connects.
    const outcome = await new Promise<string>((resolve) => {
      intruder.once('connect', () => resolve('connected'))
      intruder.once('error', () => resolve('refused'))
      setTimeout(resolve, 500, 'still waiting')
    })
    intruder.destroy()
    expect(outcome).not.toBe('connected')
    expect(harness.log.events.filter((e) => e.event === 'process.helper-connection-refused')).toEqual([])
  })

  it('refuses a connection without the token and still accepts the helper', async () => {
    const pending = start(harness.options())
    const helper = await waitForHelper()
    for (const first of [
      JSON.stringify({ type: 'ready', version: PROTOCOL_VERSION, token: 'f'.repeat(64), pid: HELPER_PID }),
      JSON.stringify({ type: 'started', pid: 1, created: '1', ...CONSOLE }),
      'hello',
    ]) {
      const intruder = connect(helper.pipe)
      intruder.on('error', () => undefined)
      await once(intruder, 'connect')
      intruder.write(`${first}\n`)
      // An intruder never sees what Veydr sends; its connection is closed.
      intruder.on('data', () => expect.unreachable('an unauthenticated connection received data'))
      await once(intruder, 'close')
    }
    await helper.connect()
    helper.send({ type: 'started', pid: LEADER.pid, created: LEADER.created, ...CONSOLE })
    await expect(pending).resolves.toMatchObject({ pid: LEADER.pid })
    expect(harness.log.events.filter((e) => e.event === 'process.helper-connection-refused')).toHaveLength(3)
  })

  it('closes a connection whose first line exceeds the handshake limit before it ends', async () => {
    const pending = start(harness.options())
    const helper = await waitForHelper()
    const intruder = connect(helper.pipe)
    intruder.on('error', () => undefined)
    await once(intruder, 'connect')
    intruder.write('x'.repeat(MAX_HANDSHAKE_BYTES + 1))
    await once(intruder, 'close')
    await helper.connect()
    helper.send({ type: 'started', pid: LEADER.pid, created: LEADER.created, ...CONSOLE })
    await expect(pending).resolves.toBeDefined()
  })

  it('accepts lines that arrive together with the handshake, whatever their length', async () => {
    const pending = start(harness.options())
    const helper = await waitForHelper()
    const many = Array.from({ length: 200 }, (_, i) => ({ pid: 8000 + 4 * i, created: GRANDCHILD.created, image: GRANDCHILD.image }))
    const ready = JSON.stringify({ type: 'ready', version: PROTOCOL_VERSION, token: await helper.token(), pid: HELPER_PID })
    const started = JSON.stringify({ type: 'started', pid: LEADER.pid, created: LEADER.created, ...CONSOLE })
    const members = JSON.stringify({ type: 'members', answer: false, members: [LEADER, ...many] })
    await helper.connect(`${ready}\n${started}\n${members}`)
    const run = await pending
    const seen = new Promise<number>((resolve) => run.onDescendantsChange((d) => resolve(d.length)))
    expect(await seen).toBe(200)
  })

  it('closes a connection that sends no first line in time, and still accepts the helper', async () => {
    const pending = start(harness.options({ handshakeTimeoutMs: 50 }))
    const helper = await waitForHelper()
    const idle = connect(helper.pipe)
    idle.on('error', () => undefined)
    await once(idle, 'connect')
    await once(idle, 'close')
    await helper.connect()
    helper.send({ type: 'started', pid: LEADER.pid, created: LEADER.created, ...CONSOLE })
    await expect(pending).resolves.toBeDefined()
    expect(harness.log.events.find((e) => e.event === 'process.helper-connection-refused')?.detail?.['reason']).toMatch(/no first line within 50 ms/)
  })

  it('does not let idle connections keep the helper out', async () => {
    const pending = start(harness.options())
    const helper = await waitForHelper()
    const idle: Socket[] = []
    const closed = new Set<Socket>()
    for (let i = 0; i < MAX_PENDING_CONNECTIONS; i++) {
      const socket = connect(helper.pipe)
      socket.on('error', () => undefined)
      socket.on('close', () => closed.add(socket))
      await once(socket, 'connect')
      idle.push(socket)
    }
    await helper.connect()
    helper.send({ type: 'started', pid: LEADER.pid, created: LEADER.created, ...CONSOLE })
    await expect(pending).resolves.toBeDefined()
    // The helper's connection displaced the oldest idle one; the rest closed once it was accepted.
    expect(harness.log.events.filter((e) => e.detail?.['reason'] === 'too many connections are waiting to identify themselves')).toHaveLength(1)
    await vi.waitFor(() => expect(closed.size).toBe(MAX_PENDING_CONNECTIONS))
  })

  it('refuses a first line that is not valid UTF-8', async () => {
    const pending = start(harness.options())
    const helper = await waitForHelper()
    const intruder = connect(helper.pipe)
    intruder.on('error', () => undefined)
    await once(intruder, 'connect')
    intruder.write(Buffer.from([0x7b, 0xff, 0x7d, 0x0a]))
    await once(intruder, 'close')
    await helper.connect()
    helper.send({ type: 'started', pid: LEADER.pid, created: LEADER.created, ...CONSOLE })
    await expect(pending).resolves.toBeDefined()
    expect(harness.log.events.find((e) => e.event === 'process.helper-connection-refused')?.detail?.['reason']).toMatch(/not valid UTF-8/)
  })

  it('fails the start when the helper speaks another protocol version, and terminates it', async () => {
    const pending = start(harness.options())
    const helper = await waitForHelper()
    await helper.connect(JSON.stringify({ type: 'ready', version: PROTOCOL_VERSION + 1, token: await helper.token(), pid: HELPER_PID }))
    const error = await expectSpawnError(pending, /protocol version 3.*needs version 2/)
    expect(error.reason).toBe('other')
    expect(helper.kills).toEqual(['SIGKILL'])
    expect(helper.stdout.destroyed).toBe(true)
  })

  it('fails the start when the handshake names another process than the helper', async () => {
    const pending = start(harness.options())
    const helper = await waitForHelper()
    await helper.connect(JSON.stringify({ type: 'ready', version: PROTOCOL_VERSION, token: await helper.token(), pid: HELPER_PID + 4 }))
    await expectSpawnError(pending, /handshake names process 4244/)
    expect(helper.kills).toEqual(['SIGKILL'])
  })

  it('reports the helper error when the command could not be started', async () => {
    const pending = start(harness.options())
    const helper = await waitForHelper()
    await helper.connect()
    helper.send({ type: 'error', message: 'CreateProcess failed: the system cannot find the file specified' })
    await helper.exit(1)
    await expectSpawnError(pending, `Could not start ${plan.file}: CreateProcess failed: the system cannot find the file specified`)
  })

  it('reports a refused run request, which the helper sends as an error line after ready', async () => {
    const pending = start(harness.options())
    const helper = await waitForHelper()
    await helper.connect()
    helper.send({ type: 'error', message: 'the run request has an unknown key at offset 1' })
    await helper.exit(1)
    await expectSpawnError(pending, `Could not start ${plan.file}: the run request has an unknown key at offset 1`)
    expect(harness.log.events.filter((e) => e.event === 'process.helper-failed')).toHaveLength(1)
  })

  it('keeps the helper error that arrived just before the helper exited', async () => {
    const pending = start(harness.options())
    const helper = await waitForHelper()
    // The exit is reported before Veydr has accepted, let alone read, the helper's connection, as
    // a named pipe allows: the helper connects, writes its error, and exits at once.
    helper.exited = true
    helper.emit('exit', 1, null)
    await helper.connect()
    helper.send({ type: 'error', message: 'access denied' })
    helper.socket?.end()
    await expectSpawnError(pending, /access denied/)
  })

  it('fails the start when the helper exits without connecting', async () => {
    const pending = start(harness.options({ drainTimeoutMs: 50 }))
    const helper = await waitForHelper()
    await helper.exit(2)
    await expectSpawnError(pending, /exited unexpectedly \(exit code 2\)/)
  })

  it('fails the start when the helper does not report the command in time', async () => {
    const pending = start(harness.options({ startTimeoutMs: 300 }))
    const helper = await waitForHelper()
    await helper.connect()
    await expectSpawnError(pending, /did not start the command within 300 ms/)
    expect(helper.kills).toEqual(['SIGKILL'])
  })

  it('fails the start when the helper cannot be spawned', async () => {
    await expectSpawnError(
      startHelperRun(plan, harness.options({ spawnHelper: () => { throw new TypeError('bad argument') } })),
      `Could not start the Windows helper ${HELPER}: bad argument`,
    )
    const missing = Object.assign(new EventEmitter(), { pid: undefined, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() })
    setImmediate(() => missing.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })))
    await expectSpawnError(startHelperRun(plan, harness.options({ spawnHelper: () => missing as unknown as ChildProcess })), /spawn ENOENT/)
    expect(missing.stdout.destroyed).toBe(true)
  })

  it('terminates a helper started without pipes and releases the pipe', async () => {
    const pipe = harness.nextPipe()
    const kills: unknown[] = []
    const noPipes = Object.assign(new EventEmitter(), { pid: HELPER_PID, stdin: null, stdout: new PassThrough(), stderr: new PassThrough(), kill: (s: unknown) => kills.push(s) })
    await expectSpawnError(startHelperRun(plan, harness.options({ pipePath: () => pipe, spawnHelper: () => noPipes as unknown as ChildProcess })), /without pipes/)
    expect(kills).toEqual(['SIGKILL'])
    const probe = connect(pipe)
    const [error] = (await once(probe, 'error')) as [NodeJS.ErrnoException]
    expect(['ENOENT', 'ECONNREFUSED']).toContain(error.code)
  })

  it('fails the start, spawning nothing, when the pipe name is taken', async () => {
    const taken = harness.nextPipe()
    const squatter = createServer()
    await new Promise<void>((resolve) => squatter.listen(taken, resolve))
    try {
      await expectSpawnError(startHelperRun(plan, harness.options({ pipePath: () => taken })), /control channel could not be created/)
      expect(harness.spawnCalls).toHaveLength(0)
    } finally {
      squatter.close()
    }
  })
})

describe('a running command', () => {
  it('reports descendants, excluding the leader, only when they change', async () => {
    const { run, helper } = await startedRun()
    const reports: number[][] = []
    run.onDescendantsChange((d) => reports.push(d.map((i) => i.pid)))
    helper.send(
      { type: 'members', answer: false, members: [LEADER] },
      { type: 'members', answer: false, members: [LEADER, CHILD] },
      { type: 'members', answer: false, members: [CHILD, LEADER] },
      { type: 'members', answer: false, members: [LEADER, CHILD, GRANDCHILD] },
      { type: 'members', answer: false, members: [GRANDCHILD] },
    )
    await vi.waitFor(() => expect(reports).toEqual([[CHILD.pid], [CHILD.pid, GRANDCHILD.pid], [GRANDCHILD.pid]]))
    const late = await new Promise((resolve) => run.onDescendantsChange(resolve))
    expect(late).toEqual([{ pid: GRANDCHILD.pid, token: GRANDCHILD.created }])
  })

  it('reports descendants once to a listener registered while they are being reported', async () => {
    const { run, helper } = await startedRun()
    const late: number[][] = []
    let registered = false
    run.onDescendantsChange(() => {
      if (registered) return
      registered = true
      run.onDescendantsChange((d) => late.push(d.map((i) => i.pid)))
    })
    helper.send({ type: 'members', answer: false, members: [LEADER, CHILD] })
    await vi.waitFor(() => expect(late).toEqual([[CHILD.pid]]))
    await new Promise((resolve) => setImmediate(resolve))
    expect(late).toEqual([[CHILD.pid]])
  })

  it('names a member whose image could not be read by its PID', async () => {
    const { run, helper } = await startedRun()
    const remaining = run.remaining()
    await helper.receivedCount(1)
    helper.send({ type: 'members', answer: true, members: [{ ...CHILD, image: '' }] })
    await expect(remaining).resolves.toEqual([{ pid: CHILD.pid, name: `PID ${CHILD.pid}`, commandLine: '' }])
  })

  it('keeps reporting to other listeners when one throws', async () => {
    const { run, helper } = await startedRun()
    run.onDescendantsChange(() => {
      throw new Error('listener bug')
    })
    const seen = new Promise((resolve) => run.onDescendantsChange(resolve))
    helper.send({ type: 'members', answer: false, members: [LEADER, CHILD] })
    await expect(seen).resolves.toHaveLength(1)
    expect(harness.log.events.map((e) => e.event)).toContain('process.descendants-listener-failed')
  })

  it('answers remaining and attributed from a list sent after the call, shared by concurrent callers', async () => {
    const { run, helper } = await startedRun()
    const remaining = run.remaining()
    const attributed = run.attributed()
    await helper.receivedCount(1)
    // A change event that was already under way does not answer the request.
    helper.send({ type: 'members', answer: false, members: [LEADER] })
    await new Promise((resolve) => setImmediate(resolve))
    let settled = false
    void remaining.then(() => (settled = true))
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    helper.send({ type: 'members', answer: true, members: [CHILD, LEADER] })
    await expect(remaining).resolves.toEqual([
      { pid: LEADER.pid, name: 'node.exe', commandLine: LEADER.image },
      { pid: CHILD.pid, name: 'cmd.exe', commandLine: CHILD.image },
    ])
    await expect(attributed).resolves.toEqual([
      { pid: CHILD.pid, token: CHILD.created },
      { pid: LEADER.pid, token: LEADER.created },
    ])
    expect(helper.received).toEqual([{ type: 'list' }])
  })

  it('answers requests in the order they were sent', async () => {
    const { run, helper } = await startedRun()
    const first = run.attributed()
    await helper.receivedCount(1)
    const second = run.attributed()
    await helper.receivedCount(2)
    helper.send({ type: 'members', answer: true, members: [LEADER] }, { type: 'members', answer: true, members: [LEADER, CHILD] })
    await expect(first).resolves.toHaveLength(1)
    await expect(second).resolves.toHaveLength(2)
  })

  it('ends cleanly when the channel stays open after the helper exited', async () => {
    const { run, helper } = await startedRun({ drainTimeoutMs: 50 })
    helper.send({ type: 'exited', code: 0, forced: false })
    await exitOf(run)
    // Something else still holds the client end of the pipe: the helper exits, the channel does not close.
    helper.exited = true
    helper.emit('exit', 0, null)
    await expect(run.stop({ graceMs: 60_000 })).resolves.toEqual({ graceful: 'yes', forced: false, survivors: [] })
    expect(helper.kills).toEqual([])
  })

  it('reports the leader exit once, also to late listeners', async () => {
    const { run, helper } = await startedRun()
    const exit = exitOf(run)
    helper.send({ type: 'exited', code: 0xc000013a, forced: false })
    await expect(exit).resolves.toEqual({ code: 0xc000013a, signal: null, forced: false })
    await expect(exitOf(run)).resolves.toEqual({ code: 0xc000013a, signal: null, forced: false })
  })

  it('ends cleanly when the helper exits with 0 after the command and its job ended', async () => {
    const { run, helper } = await startedRun()
    helper.send({ type: 'exited', code: 1, forced: false }, { type: 'members', answer: false, members: [] })
    await exitOf(run)
    await helper.exit(0)
    await expect(run.remaining()).resolves.toEqual([])
    await expect(run.attributed()).resolves.toEqual([])
    await expect(run.stop({ graceMs: 1000 })).resolves.toEqual({ graceful: 'yes', forced: false, survivors: [] })
    expect(helper.received).toEqual([])
    expect(helper.kills).toEqual([])
  })
})

describe('stopping', () => {
  it('sends one stop for concurrent calls and reports the helper result', async () => {
    const { run, helper } = await startedRun()
    const a = run.stop({ graceMs: 5000 })
    const b = run.stop({ graceMs: 100 })
    await helper.receivedCount(1)
    expect(helper.received).toEqual([{ type: 'stop', graceMs: 5000 }])
    const exit = exitOf(run)
    helper.send({ type: 'exited', code: 1, forced: true }, { type: 'stopped', graceful: 'no', forced: true, survivors: [GRANDCHILD] })
    const expected = { graceful: 'no', forced: true, survivors: [{ pid: GRANDCHILD.pid, name: 'esbuild.exe', commandLine: GRANDCHILD.image }] }
    await expect(a).resolves.toEqual(expected)
    await expect(b).resolves.toEqual(expected)
    await expect(exit).resolves.toEqual({ code: 1, signal: null, forced: true })
    expect(harness.log.events.map((e) => e.event)).toContain('process.survivors')
  })

  it('reports a graceful stop', async () => {
    const { run, helper } = await startedRun()
    const stop = run.stop({ graceMs: 5000 })
    await helper.receivedCount(1)
    helper.send({ type: 'exited', code: 0xc000013a, forced: false }, { type: 'stopped', graceful: 'yes', forced: false, survivors: [] })
    await expect(stop).resolves.toEqual({ graceful: 'yes', forced: false, survivors: [] })
  })

  it('waits for the longest grace period without failing the helper', async () => {
    const { run, helper } = await startedRun()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const stop = run.stop({ graceMs: MAX_GRACE_MS })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(helper.kills).toEqual([])
    vi.useRealTimers()
    await helper.receivedCount(1)
    helper.send({ type: 'exited', code: 1, forced: false }, { type: 'stopped', graceful: 'yes', forced: false, survivors: [] })
    await expect(stop).resolves.toMatchObject({ graceful: 'yes' })
  })

  it('answers requests while a long stop is under way', async () => {
    const { run, helper } = await startedRun({ requestTimeoutMs: 200 })
    const stop = run.stop({ graceMs: 60_000 })
    await helper.receivedCount(1)
    const remaining = run.remaining()
    await helper.receivedCount(2)
    expect(helper.received).toEqual([{ type: 'stop', graceMs: 60_000 }, { type: 'list' }])
    helper.send({ type: 'members', answer: true, members: [LEADER, CHILD] })
    await expect(remaining).resolves.toHaveLength(2)
    helper.send({ type: 'exited', code: 1, forced: false }, { type: 'stopped', graceful: 'yes', forced: false, survivors: [] })
    await expect(stop).resolves.toMatchObject({ graceful: 'yes' })
    expect(helper.kills).toEqual([])
  })

  it('rejects a grace period the helper cannot take, without remembering it', async () => {
    const { run, helper } = await startedRun()
    await expect(run.stop({ graceMs: -1 })).rejects.toThrow(RangeError)
    const stop = run.stop({ graceMs: 10 })
    await helper.receivedCount(1)
    expect(helper.received).toEqual([{ type: 'stop', graceMs: 10 }])
    helper.send({ type: 'exited', code: 1, forced: false }, { type: 'stopped', graceful: 'yes', forced: false, survivors: [] })
    await expect(stop).resolves.toMatchObject({ graceful: 'yes' })
  })

  it('finds nothing left when the stop crosses the helper ending normally', async () => {
    const { run, helper } = await startedRun()
    helper.send({ type: 'exited', code: 0, forced: false })
    await exitOf(run)
    const stop = run.stop({ graceMs: 5000 })
    await helper.exit(0)
    await expect(stop).resolves.toEqual({ graceful: 'yes', forced: false, survivors: [] })
  })
})

describe('helper failures', () => {
  /** Expects the run to have failed: the helper terminated, the exit reported, operations rejected. */
  async function expectFailed(run: ManagedProcess, helper: FakeHelper, text: string | RegExp, exit: Promise<ExitInfo>): Promise<void> {
    await expect(exit).resolves.toEqual({ code: null, signal: null, forced: true })
    expect(helper.kills).toEqual(['SIGKILL'])
    await expect(run.stop({ graceMs: 1000 })).rejects.toThrow(text)
    await expect(run.remaining()).rejects.toThrow(text)
    await expect(run.attributed()).rejects.toThrow(text)
    expect(harness.log.events.find((e) => e.event === 'process.helper-failed')?.detail?.['message']).toMatch(text)
  }

  const cases: [string, (helper: FakeHelper) => void, RegExp][] = [
    ['a malformed line', (h) => h.sendRaw('{"type":"members"\n'), /Not a JSON line/],
    ['an unknown message', (h) => h.send({ type: 'progress', percent: 50 }), /Unknown message type "progress"/],
    ['an invalid field', (h) => h.send({ type: 'members', answer: false, members: [{ ...CHILD, pid: -1 }] }), /Malformed members message/],
    ['a second started', (h) => h.send({ type: 'started', pid: LEADER.pid, created: LEADER.created, ...CONSOLE }), /unexpected started message/],
    ['an answer without a request', (h) => h.send({ type: 'members', answer: true, members: [] }), /unexpected members message/],
    ['a stop result without a stop', (h) => h.send({ type: 'stopped', graceful: 'yes', forced: false, survivors: [] }), /unexpected stopped message/],
    ['a line beyond the size limit', (h) => h.sendRaw('x'.repeat(1024 * 1024 + 1)), /exceeds/],
    ['an error report', (h) => h.send({ type: 'error', message: 'completion port failed' }), /The Windows helper failed: completion port failed/],
  ]
  for (const [what, provoke, text] of cases) {
    it(`terminates the helper on ${what}`, async () => {
      const { run, helper } = await startedRun()
      const exit = exitOf(run)
      provoke(helper)
      await expectFailed(run, helper, text, exit)
    })
  }

  it('treats a channel closed before the command exited as a failure', async () => {
    const { run, helper } = await startedRun()
    const exit = exitOf(run)
    const stop = run.stop({ graceMs: 5000 })
    await helper.receivedCount(1)
    helper.socket?.end()
    await expect(stop).rejects.toThrow(/closed its control channel before the command exited/)
    await expectFailed(run, helper, /closed its control channel/, exit)
  })

  it('treats a helper that ends abnormally as a failure, and reports the exit only once it is gone', async () => {
    const { run, helper } = await startedRun()
    const exits: { exit: ExitInfo; helperGone: boolean }[] = []
    run.onExit((exit) => exits.push({ exit, helperGone: helper.exited }))
    helper.socket?.destroy()
    await vi.waitFor(() => expect(exits).toHaveLength(1))
    expect(helper.kills).toEqual(['SIGKILL'])
    expect(exits).toEqual([{ exit: { code: null, signal: null, forced: true }, helperGone: true }])
  })

  it('treats a helper exit other than 0 after the command exited as a failure', async () => {
    const { run, helper } = await startedRun()
    helper.send({ type: 'exited', code: 0, forced: false })
    const exit = await exitOf(run)
    await helper.exit(3)
    expect(exit).toEqual({ code: 0, signal: null, forced: false })
    await expect(run.remaining()).rejects.toThrow(/exited unexpectedly \(exit code 3\)/)
  })

  it('treats a complete stop reported before the command exited as a failure', async () => {
    const { run, helper } = await startedRun()
    const stop = run.stop({ graceMs: 5000 })
    await helper.receivedCount(1)
    helper.send({ type: 'stopped', graceful: 'yes', forced: false, survivors: [] })
    await expect(stop).rejects.toThrow(/complete stop before the command exited/)
  })

  it('terminates a helper that does not answer a request in time', async () => {
    const { run, helper } = await startedRun({ requestTimeoutMs: 50 })
    await expect(run.remaining()).rejects.toThrow(/did not answer within 50 ms/)
    expect(helper.kills).toEqual(['SIGKILL'])
  })

  it('terminates a helper that does not report the stop in time', async () => {
    const { run, helper } = await startedRun({ stopMarginMs: 0 })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const stop = run.stop({ graceMs: 100 })
    const rejected = expect(stop).rejects.toThrow(/did not report the stop within 1100 ms/)
    await vi.advanceTimersByTimeAsync(1100)
    await rejected
    expect(helper.kills).toEqual(['SIGKILL'])
  })

  it('rejects with a protocol error type that callers can recognise', async () => {
    const { run, helper } = await startedRun()
    helper.sendRaw('nonsense\n')
    const error = await run.remaining().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProtocolError)
  })
})

describe('the run request (protocol version 2)', () => {
  const CMD = 'C:\\Windows\\System32\\cmd.exe'

  it('refuses a batch file without a planned command line before creating the pipe or the helper', async () => {
    let pipes = 0
    const options = harness.options({ pipePath: () => (pipes++, harness.nextPipe()) })
    const pending = startHelperRun({ ...plan, file: 'C:\\tools\\build.bat', args: ['release'] }, options)
    const refused = await expectSpawnError(pending, 'The batch file "C:\\\\tools\\\\build.bat" can only run through cmd.exe, with a command line built for it')
    expect(refused).toBeInstanceOf(CommandLineError)
    expect(pipes).toBe(0)
    expect(harness.spawnCalls).toEqual([])
  })

  it('sends a planned command line unchanged, with the program it starts', async () => {
    const commandLine = shellCommandLine(CMD, 'npm run dev && echo %USERNAME% ^& done')
    const pending = startHelperRun({ ...plan, file: CMD, args: [], commandLine }, harness.options())
    const helper = await waitForHelper()
    expect(await helper.request()).toEqual({ application: CMD, commandLine })
    await helper.connect()
    helper.send({ type: 'started', pid: LEADER.pid, created: LEADER.created, ...CONSOLE })
    await expect(pending).resolves.toBeDefined()
  })

  it('reports the console the command was given, and logs one that is not UTF-8', async () => {
    const { run } = await startedRun()
    expect((run as WindowsManagedProcess).console).toEqual({ utf8: true, ansiCodePage: 1252 })
    expect(run.outputFallbackEncoding).toBe('windows-1252')
    expect(harness.log.events.find((e) => e.event === 'process.windows-console-not-utf8')).toBeUndefined()

    const pending = start(harness.options())
    const helper = await waitForHelper(1)
    await helper.connect()
    const reason = "could not attach to the command's console: The handle is invalid. (error 6)"
    helper.send({ type: 'started', pid: 5000, created: LEADER.created, utf8Console: false, ansiCodePage: 932, consoleError: reason })
    const second = (await pending) as WindowsManagedProcess
    expect(second.console).toEqual({ utf8: false, ansiCodePage: 932 })
    // Still the ANSI label: console programs then write OEM bytes, which no decoder covers (design D5).
    expect(second.outputFallbackEncoding).toBe('shift_jis')
    expect(harness.log.events.filter((e) => e.event === 'process.windows-console-not-utf8')).toEqual([
      { level: 'warn', event: 'process.windows-console-not-utf8', detail: { leader: 5000, ansiCodePage: 932, reason } },
    ])
  })

  it('fails the start on a started line without the console fields, as a version 1 helper would send', async () => {
    const pending = start(harness.options())
    const helper = await waitForHelper()
    await helper.connect()
    helper.send({ type: 'started', pid: LEADER.pid, created: LEADER.created })
    await expectSpawnError(pending, /Malformed started message/)
    expect(helper.kills).toEqual(['SIGKILL'])
  })
})

describe('with a real helper process', () => {
  // A Node stand-in for the helper, to check the token travels over a real stdin and the run ends
  // cleanly once the helper exits with 0.
  const script = `
    const net = require('node:net')
    const [pipe] = process.argv.slice(1)
    let input = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => (input += d))
    process.stdin.on('end', () => {
      const [token, request] = input.split('\\n')
      const s = net.connect(pipe, () => {
        const send = (m) => s.write(JSON.stringify(m) + '\\n')
        send({ type: 'ready', version: 2, token, pid: process.pid })
        send({ type: 'started', pid: process.pid, created: '134067012345678901', utf8Console: false, ansiCodePage: 1252, consoleError: 'no console in the test' })
        process.stdout.write('request:' + request + ' cwd-env:' + process.env.VEYDR_TEST_MARK + '\\n')
        send({ type: 'members', answer: false, members: [] })
        send({ type: 'exited', code: 0, forced: false })
        s.end(() => process.exit(0))
      })
    })
  `

  it('completes a run end to end', async () => {
    const log = harness.log
    const run = await startHelperRun(
      { file: process.execPath, args: ['a b', '"q"'], cwd: process.cwd(), env: { ...process.env, VEYDR_TEST_MARK: 'marked' } },
      {
        helperPath: process.execPath,
        pipePath: () => sockets.next(),
        // `run` is the first argument; the stand-in skips it and reads the pipe after it.
        spawnHelper: (file, args, options) => spawn(file, ['-e', script, '--', ...args.slice(1)], options),
        log,
      },
    )
    let output = ''
    run.stdout.setEncoding('utf8')
    run.stdout.on('data', (d: string) => (output += d))
    await expect(exitOf(run)).resolves.toEqual({ code: 0, signal: null, forced: false })
    await vi.waitFor(async () => expect(await run.remaining()).toEqual([]))
    await expect(run.stop({ graceMs: 1000 })).resolves.toEqual({ graceful: 'yes', forced: false, survivors: [] })
    const commandLine = `"${process.execPath}" "a b" "\\"q\\""`
    expect(output).toBe(`request:${JSON.stringify({ application: process.execPath, commandLine })} cwd-env:marked\n`)
    expect(run.console).toEqual({ utf8: false, ansiCodePage: 1252 })
    expect(log.events.find((e) => e.event === 'process.windows-console-not-utf8')).toEqual({
      level: 'warn',
      event: 'process.windows-console-not-utf8',
      detail: { leader: run.pid, ansiCodePage: 1252, reason: 'no console in the test' },
    })
  })
})
