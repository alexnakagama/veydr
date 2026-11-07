import { spawn as spawnChild, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server, type Socket } from 'node:net'
import type { Readable, Writable } from 'node:stream'
import { SpawnError } from '../errors'
import type { ExitInfo, ManagedProcess, PlatformLog, ProcInfo, ProcessIdentity, SpawnPlan, StopResult } from '../types'
import { helperLaunch } from './command-line'
import { windowsIdentity } from './identity'
import {
  encodeControlMessage,
  encodeRunRequest,
  LineReader,
  MAX_HANDSHAKE_BYTES,
  MAX_LINE_BYTES,
  parseHandshake,
  parseHelperMessage,
  ProtocolError,
  type HelperMember,
  type HelperMessage,
} from './protocol'

/** Starts the helper process; `child_process.spawn` outside tests. */
export type SpawnHelper = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export interface HelperClientOptions {
  /** Absolute path of `veydr-helper.exe`. */
  readonly helperPath: string
  readonly spawnHelper?: SpawnHelper
  /** A new, unused control-channel path for each run: a random named pipe outside tests. */
  readonly pipePath?: () => string
  /** How long the helper may take from spawn to `started` (design D2). */
  readonly startTimeoutMs?: number
  /** How long the helper may take to answer `list`; a helper that does not answer has failed. */
  readonly requestTimeoutMs?: number
  /** How long a stop may take beyond `graceMs` and the helper's own 1 s kill wait. */
  readonly stopMarginMs?: number
  /** How long a connection may take to send its first line. */
  readonly handshakeTimeoutMs?: number
  /** How long the channel may stay open after the helper exited. */
  readonly drainTimeoutMs?: number
  readonly log?: PlatformLog
}

export const START_TIMEOUT_MS = 10_000
export const REQUEST_TIMEOUT_MS = 10_000
export const STOP_MARGIN_MS = 5_000
/** The helper waits this long after `TerminateJobObject` before reporting survivors (design D3). */
export const HELPER_KILL_WAIT_MS = 1_000
/** Connections that may wait for their first line at once; beyond that the oldest is dropped. */
export const MAX_PENDING_CONNECTIONS = 16
/** How long a connection may take to send its first line before it is closed. */
export const HANDSHAKE_TIMEOUT_MS = 2_000
/** How long the control channel may stay open after the helper exited, to deliver its last lines. */
export const DRAIN_TIMEOUT_MS = 1_000
/** Largest delay `setTimeout` honours; longer ones fire at once. */
const MAX_TIMER_MS = 0x7fff_ffff

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)))

/** A fresh named pipe in the local namespace, named with 128 random bits (design D2). */
export const randomPipePath = (): string => `\\\\.\\pipe\\veydr-${randomBytes(16).toString('hex')}`

/** The image file name of a full Windows image path. */
export const imageName = (image: string): string => image.slice(Math.max(image.lastIndexOf('\\'), image.lastIndexOf('/')) + 1)

/** A job member as shown to the user; the image path stands in for the command line (design D4). */
export const procInfo = (m: HelperMember): ProcInfo => ({ pid: m.pid, name: imageName(m.image) || `PID ${m.pid}`, commandLine: m.image })

/** The console the helper gave the command (add-windows-environment-and-commands design D5). */
export interface WindowsConsole {
  /** Whether the console's output code page was set to UTF-8 (65001) before the command ran. */
  readonly utf8: boolean
  /** The system's ANSI code page, `GetACP()`. */
  readonly ansiCodePage: number
}

/** A command started through the helper. */
export interface WindowsManagedProcess extends ManagedProcess {
  readonly console: WindowsConsole
}

/**
 * Starts `plan` through `veydr-helper.exe run` (design D1, D2) and resolves once the helper reports
 * the started command. Rejects with `SpawnError` if the command was not started; every resource of
 * the attempt (the pipe, the helper) is released first. A plan whose command line cannot be built
 * (`helperLaunch`) is refused before anything is created.
 */
export async function startHelperRun(plan: SpawnPlan, options: HelperClientOptions): Promise<WindowsManagedProcess> {
  // Veydr builds the whole command line, and the helper passes it on unchanged (design D1).
  const request = runRequest(plan)
  const token = randomBytes(32).toString('hex')
  const pipe = (options.pipePath ?? randomPipePath)()
  const server = createServer({ pauseOnConnect: false })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(pipe, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    server.close()
    throw new SpawnError('other', `Could not start ${plan.file}: the helper's control channel could not be created (${messageOf(error)})`)
  }

  let child: ChildProcess
  try {
    // The helper starts the command with its own working directory and environment (design D2).
    // Hidden, and never detached: libuv's job ends the helper if Veydr dies (design D1).
    // Only the pipe name is on the helper's command line; the command goes over stdin (design D1).
    child = (options.spawnHelper ?? spawnChild)(options.helperPath, ['run', pipe], {
      cwd: plan.cwd,
      env: { ...plan.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: false,
      shell: false,
    })
  } catch (error) {
    server.close()
    throw new SpawnError('other', `Could not start the Windows helper ${options.helperPath}: ${messageOf(error)}`)
  }
  if (child.pid === undefined) {
    // No process was created; Node reports why with an `error` event.
    const [error] = (await once(child, 'error')) as [unknown]
    server.close()
    child.stdout?.destroy()
    child.stderr?.destroy()
    throw new SpawnError('other', `Could not start the Windows helper ${options.helperPath}: ${messageOf(error)}`)
  }
  if (child.stdin === null || child.stdout === null || child.stderr === null) {
    child.kill('SIGKILL')
    server.close()
    throw new SpawnError('other', `Could not start the Windows helper ${options.helperPath}: it was started without pipes`)
  }
  return new HelperRun(child, { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr }, server, token, request, plan.file, options).started
}

/** The run request line for `plan`; a `SpawnError` (`CommandLineError`) if it cannot be built. */
function runRequest(plan: SpawnPlan): string {
  const launch = helperLaunch(plan)
  try {
    return encodeRunRequest(launch)
  } catch (error) {
    throw new SpawnError('other', `Could not start ${plan.file}: ${messageOf(error)}`)
  }
}

type Phase = 'starting' | 'running' | 'ended' | 'failed'

interface Waiter<T> {
  readonly resolve: (value: T) => void
  readonly reject: (error: Error) => void
}

/** One run: the helper process, its authenticated control connection, and the command it reports. */
class HelperRun implements WindowsManagedProcess {
  /** Resolves with this run once the helper reports `started`; rejects with `SpawnError` otherwise. */
  readonly started: Promise<WindowsManagedProcess>
  readonly stdout: Readable
  readonly stderr: Readable
  readonly sessionId = null
  private phase: Phase = 'starting'
  private leader: ProcessIdentity | null = null
  private startedConsole: WindowsConsole | null = null
  private settleStart!: Waiter<WindowsManagedProcess>
  private failure: Error | null = null
  private readonly pending = new Set<Socket>()
  private socket: Socket | null = null
  private readonly reader = new LineReader(MAX_LINE_BYTES)
  private startTimer: NodeJS.Timeout | null
  private helperExit: { readonly code: number | null } | null = null
  private channelClosed = false
  private exitInfo: ExitInfo | null = null
  private readonly exitListeners: ((e: ExitInfo) => void)[] = []
  private descendants: readonly ProcessIdentity[] = []
  /** Key of `descendants`, and of the set each listener was last given. */
  private descendantsKey = ''
  private readonly descendantListeners: { readonly cb: (descendants: readonly ProcessIdentity[]) => void; reported: string }[] = []
  private drainTimer: NodeJS.Timeout | null = null
  /** The drain after the helper's exit is over: nothing more is waited for. */
  private drained = false
  /** Callers waiting for a `list` not sent yet; they share the next one. */
  private batch: Waiter<readonly HelperMember[]>[] | null = null
  /** Sent `list` requests in order; each `members` answer settles the oldest. */
  private readonly inFlight: { readonly waiters: Waiter<readonly HelperMember[]>[]; readonly timer: NodeJS.Timeout }[] = []
  private stopping: Promise<StopResult> | null = null
  private stopWaiter: (Waiter<StopResult> & { readonly timer: NodeJS.Timeout }) | null = null

  constructor(
    private readonly child: ChildProcess,
    stdio: { readonly stdin: Writable; readonly stdout: Readable; readonly stderr: Readable },
    private readonly server: Server,
    private readonly token: string,
    request: string,
    private readonly file: string,
    private readonly options: HelperClientOptions,
  ) {
    this.stdout = stdio.stdout
    this.stderr = stdio.stderr
    this.started = new Promise((resolve, reject) => {
      this.settleStart = { resolve, reject }
    })
    // Handled in `fail`; a rejection nobody awaits yet must not be reported as unhandled.
    this.started.catch(() => undefined)

    const startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS
    this.startTimer = setTimeout(() => this.fail(new Error(`the Windows helper did not start the command within ${startTimeoutMs} ms`)), startTimeoutMs)

    server.on('connection', (socket) => this.accept(socket))
    server.on('error', (error) => this.log('warn', 'process.helper-pipe-error', { message: error.message }))
    child.on('error', (error) => this.log('warn', 'process.helper-error', { helper: child.pid, message: error.message }))
    child.once('exit', (code) => {
      this.helperExit = { code }
      this.settle()
    })
    // The token and the run request go only to the helper's stdin, never on a command line
    // (design D2; add-windows-environment-and-commands design D1). The helper reads the request
    // only after it has proven itself on the pipe.
    stdio.stdin.on('error', (error) => this.log('warn', 'process.helper-stdin-error', { helper: child.pid, message: error.message }))
    stdio.stdin.end(`${token}\n${request}`)
  }

  get pid(): number {
    return this.requireLeader().pid
  }

  get identity(): ProcessIdentity {
    return this.requireLeader()
  }

  get console(): WindowsConsole {
    if (this.startedConsole === null) throw new Error('the command has not started yet')
    return this.startedConsole
  }

  onExit(cb: (e: ExitInfo) => void): void {
    const info = this.exitInfo
    if (info === null) this.exitListeners.push(cb)
    else queueMicrotask(() => cb(info))
  }

  onDescendantsChange(cb: (descendants: readonly ProcessIdentity[]) => void): void {
    const listener = { cb, reported: '' }
    this.descendantListeners.push(listener)
    // Unless a change reports them first.
    if (this.descendants.length > 0) queueMicrotask(() => this.report(listener))
  }

  async remaining(): Promise<readonly ProcInfo[]> {
    const members = await this.observe()
    const leader = this.leader
    // The leader first while it is a member, as on Linux.
    const ordered = [...members].sort((a, b) => Number(isLeader(b, leader)) - Number(isLeader(a, leader)))
    return ordered.map(procInfo)
  }

  async attributed(): Promise<readonly ProcessIdentity[]> {
    return (await this.observe()).map((m) => windowsIdentity(m.pid, m.created))
  }

  stop({ graceMs }: { graceMs: number }): Promise<StopResult> {
    if (this.failure !== null) return Promise.reject(this.failure)
    if (this.phase === 'ended') return Promise.resolve({ graceful: 'yes', forced: false, survivors: [] })
    // Concurrent and later calls share the one stop the helper performs.
    this.stopping ??= new Promise<StopResult>((resolve, reject) => {
      const message = encodeControlMessage({ type: 'stop', graceMs })
      const deadline = Math.min(graceMs + HELPER_KILL_WAIT_MS + (this.options.stopMarginMs ?? STOP_MARGIN_MS), MAX_TIMER_MS)
      const timer = setTimeout(() => this.fail(new Error(`the Windows helper did not report the stop within ${deadline} ms`)), deadline)
      this.stopWaiter = { resolve, reject, timer }
      this.send(message)
    }).catch((error: unknown) => {
      // An invalid `graceMs` is not remembered; a failed helper keeps failing every call.
      if (this.failure === null) this.stopping = null
      throw error
    })
    return this.stopping
  }

  private requireLeader(): ProcessIdentity {
    if (this.leader === null) throw new Error('the command has not started yet')
    return this.leader
  }

  /** The members in the answer to a `list` sent after this call. */
  private observe(): Promise<readonly HelperMember[]> {
    if (this.failure !== null) return Promise.reject(this.failure)
    if (this.phase === 'ended') return Promise.resolve([])
    return new Promise<readonly HelperMember[]>((resolve, reject) => {
      if (this.batch === null) {
        const batch: Waiter<readonly HelperMember[]>[] = []
        this.batch = batch
        // Callers in the same tick share one request.
        queueMicrotask(() => {
          this.batch = null
          if (this.failure !== null) return rejectAll(batch, this.failure)
          if (this.phase === 'ended') return resolveAll(batch, [])
          const timeoutMs = this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
          const timer = setTimeout(() => this.fail(new Error(`the Windows helper did not answer within ${timeoutMs} ms`)), timeoutMs)
          this.inFlight.push({ waiters: batch, timer })
          this.send(encodeControlMessage({ type: 'list' }))
        })
      }
      this.batch.push({ resolve, reject })
    })
  }

  private send(line: string): void {
    const socket = this.socket
    if (socket === null || socket.destroyed) return this.fail(new Error('the control channel to the Windows helper is closed'))
    socket.write(line)
  }

  /** A new connection to the pipe: only this run's helper, proven by the token, is accepted. */
  private accept(socket: Socket): void {
    socket.on('error', () => undefined)
    if (this.socket !== null || this.phase !== 'starting') {
      socket.destroy()
      return
    }
    const refuse = (reason: string): void => {
      this.log('warn', 'process.helper-connection-refused', { reason })
      socket.destroy()
    }
    // Each connection gets little memory and little time, and when too many wait, the oldest is
    // dropped: the helper sends its first line as soon as it connects, so idle connections cannot
    // keep it out. The token still guards the channel (design D2).
    if (this.pending.size >= MAX_PENDING_CONNECTIONS) {
      const [oldest] = this.pending
      this.log('warn', 'process.helper-connection-refused', { reason: 'too many connections are waiting to identify themselves' })
      if (oldest !== undefined) {
        // Removed at once, so a burst of connections in one turn evicts a different one each time.
        this.pending.delete(oldest)
        oldest.destroy()
      }
    }
    this.pending.add(socket)
    const handshakeTimeoutMs = this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS
    const timer = setTimeout(() => refuse(`no first line within ${handshakeTimeoutMs} ms`), handshakeTimeoutMs)
    socket.once('close', () => {
      clearTimeout(timer)
      // A helper that exited may have connected, written its last lines, and gone (see `settle`).
      if (this.pending.delete(socket)) this.settle()
    })
    // Until it has proven itself, a connection may send one short line and nothing else is read.
    let received = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk])
      const end = received.indexOf(0x0a)
      if (end === -1) {
        if (received.length > MAX_HANDSHAKE_BYTES) refuse('the first line is too long')
        return
      }
      if (end > MAX_HANDSHAKE_BYTES) return refuse('the first line is too long')
      socket.off('data', onData)
      clearTimeout(timer)
      let helperPid: number
      try {
        const first = new TextDecoder('utf-8', { fatal: true }).decode(received.subarray(0, end))
        helperPid = parseHandshake(first, this.token).pid
      } catch (error) {
        if (error instanceof TypeError) return refuse('the first line is not valid UTF-8')
        if (error instanceof ProtocolError && error.kind === 'bad-token') return refuse(error.message)
        // The right token from the wrong helper (another protocol version, a malformed line).
        return this.fail(asError(error))
      }
      if (helperPid !== this.child.pid) {
        return this.fail(new ProtocolError('malformed', `the handshake names process ${helperPid}, not the helper ${String(this.child.pid)}`))
      }
      this.authenticated(socket, received.subarray(end + 1))
    }
    socket.on('data', onData)
  }

  private authenticated(socket: Socket, rest: Buffer): void {
    this.pending.delete(socket)
    this.socket = socket
    // Exactly one connection per run: no one else may connect, and pending ones are dropped.
    this.server.close()
    for (const other of this.pending) other.destroy()
    this.pending.clear()
    socket.once('close', () => {
      this.channelClosed = true
      this.settle()
    })
    socket.on('data', (chunk: Buffer) => this.receive(chunk))
    if (rest.length > 0) this.receive(rest)
  }

  private receive(chunk: Buffer): void {
    let lines: string[]
    try {
      lines = this.reader.push(chunk)
    } catch (error) {
      return this.fail(asError(error))
    }
    for (const line of lines) {
      if (!this.handleLine(line)) return
    }
  }

  /** Handles one line; `false` once the run has failed and further lines are to be ignored. */
  private handleLine(line: string): boolean {
    if (this.failure !== null) return false
    let message: HelperMessage
    try {
      message = parseHelperMessage(line)
    } catch (error) {
      this.fail(asError(error))
      return false
    }
    this.handle(message)
    return this.failure === null
  }

  private handle(message: HelperMessage): void {
    const unexpected = (): void => this.fail(new ProtocolError('malformed', `unexpected ${message.type} message`))
    switch (message.type) {
      case 'started': {
        if (this.phase !== 'starting') return unexpected()
        this.leader = windowsIdentity(message.pid, message.created)
        this.startedConsole = { utf8: message.utf8Console, ansiCodePage: message.ansiCodePage }
        if (!message.utf8Console) {
          // Console programs then write in the OEM code page, which no decoder covers (design D5).
          this.log('warn', 'process.windows-console-not-utf8', { leader: message.pid, ansiCodePage: message.ansiCodePage, reason: message.consoleError })
        }
        this.phase = 'running'
        this.clearStartTimer()
        this.settleStart.resolve(this)
        return
      }
      case 'members': {
        if (this.phase !== 'running') return unexpected()
        let answered: (typeof this.inFlight)[number] | undefined
        if (message.answer) {
          answered = this.inFlight.shift()
          if (answered === undefined) return unexpected()
          clearTimeout(answered.timer)
        }
        this.updateMembers(message.members)
        if (answered !== undefined) resolveAll(answered.waiters, message.members)
        return
      }
      case 'exited': {
        if (this.phase !== 'running' || this.exitInfo !== null) return unexpected()
        this.setExit({ code: message.code, signal: null, forced: message.forced })
        return
      }
      case 'stopped': {
        const waiter = this.stopWaiter
        if (this.phase !== 'running' || waiter === null) return unexpected()
        // The helper reports `exited` before `stopped` whenever the leader has ended.
        if (message.survivors.length === 0 && this.exitInfo === null) {
          return this.fail(new ProtocolError('malformed', 'the helper reported a complete stop before the command exited'))
        }
        this.stopWaiter = null
        clearTimeout(waiter.timer)
        this.updateMembers(message.survivors)
        const survivors = message.survivors.map(procInfo)
        if (survivors.length > 0) this.log('warn', 'process.survivors', { leader: this.leader?.pid, pids: survivors.map((s) => s.pid) })
        waiter.resolve({ graceful: message.graceful, forced: message.forced, survivors })
        return
      }
      case 'error': {
        const prefix = this.phase === 'starting' ? `Could not start ${this.file}` : 'The Windows helper failed'
        this.fail(new Error(`${prefix}: ${message.message}`))
        return
      }
    }
  }

  private updateMembers(members: readonly HelperMember[]): void {
    const leader = this.leader
    const descendants = members.filter((m) => !isLeader(m, leader)).map((m) => windowsIdentity(m.pid, m.created))
    const key = descendants.map((d) => `${d.pid}:${d.token}`).sort().join(',')
    if (key === this.descendantsKey) return
    this.descendants = descendants
    this.descendantsKey = key
    for (const listener of this.descendantListeners) this.report(listener)
  }

  /** Gives `listener` the current descendants, unless it already has them. */
  private report(listener: (typeof this.descendantListeners)[number]): void {
    if (listener.reported === this.descendantsKey) return
    listener.reported = this.descendantsKey
    try {
      listener.cb(this.descendants)
    } catch (error) {
      this.log('error', 'process.descendants-listener-failed', { leader: this.leader?.pid, message: messageOf(error) })
    }
  }

  private setExit(info: ExitInfo): void {
    this.exitInfo = info
    for (const cb of this.exitListeners.splice(0)) {
      try {
        cb(info)
      } catch (error) {
        this.log('error', 'process.exit-listener-failed', { leader: this.leader?.pid, message: messageOf(error) })
      }
    }
  }

  /**
   * Called when the channel closes or the helper exits. A run ends cleanly once the command has
   * exited, the channel is closed, and the helper exited with 0: the helper exits only when its job
   * is empty (design D1). Anything else after the helper started is a failure.
   */
  private settle(): void {
    if (this.phase === 'failed') {
      // The helper is gone, and with it its job and every process in it (design D1).
      if (this.helperExit !== null && this.exitInfo === null) this.setExit({ code: null, signal: null, forced: true })
      return
    }
    if (this.phase === 'ended') return
    if (this.helperExit === null) {
      if (this.channelClosed && this.exitInfo === null) {
        this.fail(new Error('the Windows helper closed its control channel before the command exited'))
      }
      return
    }
    // The channel, or a connection not yet read, still delivers what the helper wrote before it
    // exited (e.g. its `error`). Before `started`, its connection may not even be accepted yet: a
    // named pipe reports the client connected before the server sees it, so the exit can come
    // first. The helper's handles are not inherited (design D2), so its end closes with it; should
    // something else hold it open, it is closed after a short drain.
    const channelOpen = (this.socket !== null && !this.channelClosed) || this.pending.size > 0
    const mayDeliver = channelOpen || (this.phase === 'starting' && this.socket === null)
    if (mayDeliver && !this.drained) {
      this.drainTimer ??= setTimeout(() => {
        this.drained = true
        for (const socket of this.pending) socket.destroy()
        this.socket?.destroy()
        this.settle()
      }, this.options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS)
      return
    }
    // Sockets destroyed by the drain settle again once closed.
    if (channelOpen) return
    if (this.exitInfo === null || this.helperExit.code !== 0) {
      return this.fail(new Error(`the Windows helper exited unexpectedly (exit code ${String(this.helperExit.code)})`))
    }
    this.phase = 'ended'
    this.cleanup()
    // A stop or request that crossed the helper's normal end finds nothing left.
    const waiter = this.stopWaiter
    this.stopWaiter = null
    if (waiter !== null) {
      clearTimeout(waiter.timer)
      waiter.resolve({ graceful: 'yes', forced: false, survivors: [] })
    }
    for (const request of this.inFlight.splice(0)) {
      clearTimeout(request.timer)
      resolveAll(request.waiters, [])
    }
  }

  /**
   * The helper failed (design D2): it is terminated, which closes its job and so ends the command's
   * tree, and the run reports every pending and later operation as failed. `onExit` fires once the
   * helper is gone.
   */
  private fail(error: Error): void {
    if (this.phase === 'failed' || this.phase === 'ended') return
    const starting = this.phase === 'starting'
    this.phase = 'failed'
    this.failure = error
    this.log('error', 'process.helper-failed', { helper: this.child.pid, leader: this.leader?.pid, message: error.message })
    this.cleanup()
    if (this.helperExit === null) {
      try {
        this.child.kill('SIGKILL')
      } catch (killError) {
        this.log('error', 'process.helper-kill-failed', { helper: this.child.pid, message: messageOf(killError) })
      }
    }
    if (starting) {
      this.stdout.destroy()
      this.stderr.destroy()
      this.settleStart.reject(error instanceof SpawnError ? error : new SpawnError('other', spawnMessage(error, this.file)))
    }
    const waiter = this.stopWaiter
    this.stopWaiter = null
    if (waiter !== null) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    for (const request of this.inFlight.splice(0)) {
      clearTimeout(request.timer)
      rejectAll(request.waiters, error)
    }
    this.settle()
  }

  private cleanup(): void {
    this.clearStartTimer()
    if (this.drainTimer !== null) clearTimeout(this.drainTimer)
    this.server.close()
    for (const socket of this.pending) socket.destroy()
    this.pending.clear()
    this.socket?.destroy()
  }

  private clearStartTimer(): void {
    if (this.startTimer !== null) clearTimeout(this.startTimer)
    this.startTimer = null
  }

  private log(level: 'info' | 'warn' | 'error', event: string, detail: Record<string, unknown>): void {
    this.options.log?.record(level, event, detail)
  }
}

const isLeader = (member: HelperMember, leader: ProcessIdentity | null): boolean =>
  leader !== null && member.pid === leader.pid && member.created === leader.token

const spawnMessage = (error: Error, file: string): string =>
  error.message.startsWith(`Could not start ${file}`) ? error.message : `Could not start ${file}: ${error.message}`

function resolveAll<T>(waiters: readonly Waiter<T>[], value: T): void {
  for (const w of waiters) w.resolve(value)
}

function rejectAll<T>(waiters: readonly Waiter<T>[], error: Error): void {
  for (const w of waiters) w.reject(error)
}
