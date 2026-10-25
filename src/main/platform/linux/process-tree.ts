import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { SpawnError } from '../errors'
import type { ExitInfo, ManagedProcess, PlatformLog, ProcInfo, ProcessIdentity, ProcessTree, SpawnPlan, StopResult } from '../types'
import { createCleanSpawner, findExecutable, spawnChildDirectly, type CleanSpawner, type SpawnChild } from './executable'
import { createProcReader, type ProcReader } from './proc-reader'
import { displayName, isLive, linuxIdentity, type ProcStat } from './procfs'

export interface LinuxProcessTreeOptions {
  readonly proc?: ProcReader
  /** Sends a signal (`process.kill`); a negative target is a process group. */
  readonly kill?: (target: number, signal: NodeJS.Signals) => void
  /** Spawns the exec wrapper (or the program itself where the wrapper is unavailable). */
  readonly spawnChild?: SpawnChild
  /** Attribution scan interval while runs are active (design D8: 2 s). */
  readonly scanIntervalMs?: number
  /** Poll interval while waiting for a stopped tree to end (design D8: 100 ms). */
  readonly pollIntervalMs?: number
  /** How long to wait after SIGKILL before reporting survivors (design D8: 1 s). */
  readonly killWaitMs?: number
  readonly log?: PlatformLog
}

export const SCAN_INTERVAL_MS = 2_000
export const POLL_INTERVAL_MS = 100
export const KILL_WAIT_MS = 1_000

type StopSignal = 'SIGTERM' | 'SIGKILL'

/** One read of every process in /proc; `seq` orders reads by when they started. */
interface Scan {
  readonly seq: number
  readonly stats: readonly ProcStat[]
}

interface TreeContext {
  readonly proc: ProcReader
  /** Reads /proc; concurrent reads may finish in any order, so results carry a sequence number. */
  readonly scan: () => Promise<Scan>
  readonly kill: (target: number, signal: NodeJS.Signals) => void
  readonly pollIntervalMs: number
  readonly killWaitMs: number
  readonly log: PlatformLog | undefined
  readonly scanner: Scanner
}

interface Scanner {
  add(run: LinuxRun): void
  remove(run: LinuxRun): void
  /** Lets every run observe one /proc read that starts after this call. */
  observeNow(): Promise<void>
}

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/**
 * Linux process trees (design D8). Each command runs in its own session (`detached: true` makes
 * libuv call `setsid()`), so the leader's PID is also its process group and session ID. A run's
 * attribution set is every live process in that session plus every descendant observed through
 * parent links (tracked by PID and start time), which catches descendants that later change
 * group or session while Veydr watched.
 */
export function createLinuxProcessTree(options: LinuxProcessTreeOptions = {}): Pick<ProcessTree, 'spawn' | 'launchDetached'> {
  const proc = options.proc ?? createProcReader()
  const spawner = createCleanSpawner(options.spawnChild ?? spawnChildDirectly, () =>
    options.log?.record('warn', 'process.exec-wrapper-unavailable', { reason: 'bash or env not found; nothing is started' }),
  )
  let scans = 0
  const scan = async (): Promise<Scan> => {
    const seq = ++scans
    return { seq, stats: await proc.scan() }
  }
  const ctx: TreeContext = {
    proc,
    scan,
    kill: options.kill ?? ((target, signal) => process.kill(target, signal)),
    pollIntervalMs: options.pollIntervalMs ?? POLL_INTERVAL_MS,
    killWaitMs: options.killWaitMs ?? KILL_WAIT_MS,
    log: options.log,
    scanner: createScanner(scan, options.scanIntervalMs ?? SCAN_INTERVAL_MS, options.log),
  }

  return {
    async spawn(plan) {
      // Everything that can fail without a process is done before one exists.
      const file = await checkLaunch(plan)
      let bootId: string
      try {
        bootId = proc.bootId()
      } catch (error) {
        throw new SpawnError('other', `Could not start ${plan.file}: ${messageOf(error)}`)
      }
      const child = await spawnChecked(spawner, file, plan, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })

      const pid = child.pid
      if (pid === undefined) {
        // No process was created; Node reports why with an `error` event.
        const [error] = (await once(child, 'error')) as [unknown]
        child.stdout?.destroy()
        child.stderr?.destroy()
        throw await spawnFailure(error, plan)
      }

      // libuv returns only after the leader has exec'd (or failed to), and it reaps children on
      // the event loop, which has not run since: the leader cannot have been reaped yet.
      const leader = proc.stat(pid)
      if (leader === null || leader.session !== pid) {
        // Cannot happen on a working /proc; without an identity the run could not be stopped safely.
        safeKill(ctx, -pid, 'SIGKILL')
        safeKill(ctx, pid, 'SIGKILL')
        child.stdout?.destroy()
        child.stderr?.destroy()
        throw new SpawnError('other', `Could not verify the started process ${pid} (/proc unreadable)`)
      }
      return new LinuxRun(child, leader, bootId, ctx)
    },

    async launchDetached(plan) {
      const file = await checkLaunch(plan)
      // Its own session and no pipes: the program is neither tracked nor signalled by Veydr and
      // keeps running when Veydr quits.
      const child = await spawnChecked(spawner, file, plan, { detached: true, stdio: 'ignore' })
      if (child.pid === undefined) {
        const [error] = (await once(child, 'error')) as [unknown]
        throw await spawnFailure(error, plan)
      }
      child.on('error', (error) => ctx.log?.record('warn', 'process.detached-error', { message: error.message }))
      child.unref()
    },
  }
}

/** Checks the working directory and the executable of `plan`; returns the executable's absolute path. */
async function checkLaunch(plan: SpawnPlan): Promise<string> {
  await checkWorkingDirectory(plan.cwd)
  return findExecutable(plan.file, plan.cwd, plan.env)
}

/** Spawns through the exec wrapper; invalid arguments are rejected by Node before any process exists. */
async function spawnChecked(
  spawner: CleanSpawner,
  file: string,
  plan: SpawnPlan,
  options: { readonly detached: true; readonly stdio: 'ignore' | ['ignore', 'pipe', 'pipe'] },
): Promise<ChildProcess> {
  try {
    return await spawner.spawn(file, plan.args, { cwd: plan.cwd, env: { ...plan.env }, shell: false, ...options })
  } catch (error) {
    if (error instanceof SpawnError) throw error
    throw new SpawnError('other', `Could not start ${plan.file}: ${messageOf(error)}`)
  }
}

async function checkWorkingDirectory(cwd: string): Promise<void> {
  let info
  try {
    info = await stat(cwd)
  } catch (error) {
    const code = errnoOf(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new SpawnError('cwd-missing', `Working directory does not exist: ${cwd}`)
    if (code === 'EACCES') throw new SpawnError('cwd-inaccessible', `Working directory is not accessible: ${cwd}`)
    throw new SpawnError('other', `Working directory cannot be checked: ${cwd} (${code ?? messageOf(error)})`)
  }
  if (!info.isDirectory()) throw new SpawnError('cwd-not-directory', `Working directory is not a directory: ${cwd}`)
  try {
    await access(cwd, constants.X_OK)
  } catch {
    throw new SpawnError('cwd-inaccessible', `Working directory is not accessible: ${cwd}`)
  }
}

/** Maps a failed spawn to the reason shown to the user. */
async function spawnFailure(error: unknown, plan: SpawnPlan): Promise<SpawnError> {
  // libuv reports a failed chdir with the same codes as a failed exec. The directory was checked
  // before spawning; if it changed since, report the directory.
  const directoryFailure = await checkWorkingDirectory(plan.cwd).then(
    () => null,
    (failure: unknown) => failure as SpawnError,
  )
  if (directoryFailure !== null) return directoryFailure
  const where = plan.file.includes('/') ? plan.file : `${plan.file} (searched PATH)`
  switch (errnoOf(error)) {
    case 'ENOENT':
    case 'ENOTDIR':
      return new SpawnError('executable-not-found', `Executable not found: ${where}`)
    case 'EACCES':
    case 'EPERM':
      return new SpawnError('not-executable', `Permission denied: ${plan.file} is not executable`)
    case 'ENOEXEC':
      return new SpawnError('not-executable', `${plan.file} is not a valid executable`)
    case 'E2BIG':
      return new SpawnError('other', `Could not start ${plan.file}: the arguments and environment are too large`)
    default:
      return new SpawnError('other', `Could not start ${plan.file}: ${messageOf(error)}`)
  }
}

function safeKill(ctx: Pick<TreeContext, 'kill' | 'log'>, target: number, signal: NodeJS.Signals): void {
  try {
    ctx.kill(target, signal)
  } catch (error) {
    const code = errnoOf(error)
    if (code === 'ESRCH') return
    // EPERM (e.g. a setuid descendant): the process is reported as a survivor if it stays alive.
    ctx.log?.record('warn', 'process.signal-failed', { target, signal, code: code ?? messageOf(error) })
  }
}

function createScanner(read: () => Promise<Scan>, intervalMs: number, log: PlatformLog | undefined): Scanner {
  const runs = new Set<LinuxRun>()
  let timer: NodeJS.Timeout | null = null
  let scanning = false
  let fresh: Promise<void> | null = null

  // One /proc read serves every active run. A periodic scan is skipped while one is in flight.
  const scan = async (periodic: boolean): Promise<void> => {
    if (periodic && scanning) return
    scanning = true
    try {
      const result = await read()
      for (const run of [...runs]) run.observe(result)
    } catch (error) {
      log?.record('warn', 'process.scan-failed', { message: messageOf(error) })
    } finally {
      scanning = false
    }
  }

  return {
    add(run) {
      runs.add(run)
      if (timer === null) {
        timer = setInterval(() => void scan(true), intervalMs)
        timer.unref()
      }
      // Also scan right away, even if a periodic scan is in flight (it may have started before
      // this run existed): descendants are attributed from the first moment possible.
      void scan(false)
    },
    remove(run) {
      runs.delete(run)
      if (runs.size === 0 && timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
    observeNow() {
      // Requests made before the read starts share it; it starts after all of them.
      fresh ??= Promise.resolve().then(() => {
        fresh = null
        return scan(false)
      })
      return fresh
    },
  }
}

class LinuxRun implements ManagedProcess {
  readonly pid: number
  readonly identity: ProcessIdentity
  readonly sessionId: number
  readonly stdout: Readable
  readonly stderr: Readable
  /** Start time of the leader; nothing attributed to the run can be older. */
  private readonly startTime: number
  /** Observed descendants (PID → start time), kept while they live even if they leave the session. */
  private readonly tracked = new Map<number, number>()
  /** The attribution set at the last observation (live processes only, leader included). */
  private members = new Map<number, ProcStat>()
  /** `seq` of the scan `members` comes from; older scans that finish later are ignored. */
  private observedSeq = 0
  private exitInfo: ExitInfo | null = null
  private readonly exitListeners: ((e: ExitInfo) => void)[] = []
  private readonly descendantListeners: ((descendants: readonly ProcessIdentity[]) => void)[] = []
  private forced = false
  private stopping: Promise<StopResult> | null = null
  /** Processes (`pid:starttime`) and whether the group/leader already received each signal. */
  private readonly sent: Record<StopSignal, { group: boolean; processes: Set<string> }> = {
    SIGTERM: { group: false, processes: new Set() },
    SIGKILL: { group: false, processes: new Set() },
  }

  constructor(
    child: ChildProcess,
    leader: ProcStat,
    private readonly bootId: string,
    private readonly ctx: TreeContext,
  ) {
    if (child.stdout === null || child.stderr === null) throw new Error('spawned without output pipes')
    this.pid = leader.pid
    this.identity = linuxIdentity(bootId, leader)
    // `detached: true` made the leader a session leader (checked in `spawn`).
    this.sessionId = leader.pid
    this.startTime = leader.starttime
    this.stdout = child.stdout
    this.stderr = child.stderr
    this.members.set(leader.pid, leader)
    child.on('error', (error) => ctx.log?.record('warn', 'process.child-error', { pid: this.pid, message: error.message }))
    child.once('exit', (code, signal) => {
      // Node emits `exit` in the same callback in which libuv reaped the leader.
      const info: ExitInfo = { code, signal, forced: this.forced }
      this.exitInfo = info
      for (const cb of this.exitListeners.splice(0)) cb(info)
    })
    ctx.scanner.add(this)
  }

  onExit(cb: (e: ExitInfo) => void): void {
    const info = this.exitInfo
    if (info === null) this.exitListeners.push(cb)
    else queueMicrotask(() => cb(info))
  }

  onDescendantsChange(cb: (descendants: readonly ProcessIdentity[]) => void): void {
    this.descendantListeners.push(cb)
    // The scan started at spawn may already have observed descendants.
    if (this.tracked.size > 0) queueMicrotask(() => this.report(cb))
  }

  async remaining(): Promise<readonly ProcInfo[]> {
    await this.refresh()
    return this.liveInfo()
  }

  /**
   * One /proc read serves every run asked at the same time. If it fails, the last observation is
   * used (like `remaining`).
   */
  async attributed(): Promise<readonly ProcessIdentity[]> {
    await this.ctx.scanner.observeNow()
    return [...this.members.values()].map((s) => linuxIdentity(this.bootId, s))
  }

  stop({ graceMs }: { graceMs: number }): Promise<StopResult> {
    // A failed stop is not remembered, so it can be retried.
    this.stopping ??= this.terminate(graceMs).catch((error: unknown) => {
      this.stopping = null
      throw error
    })
    return this.stopping
  }

  /**
   * Updates the attribution set from one /proc scan: session members (only descendants can be in
   * the leader's session, and its ID cannot be reused while a member exists), still-valid tracked
   * descendants, and all their descendants by parent link. Tracked entries whose PID is gone or
   * now has another start time are dropped, never signalled.
   */
  observe({ seq, stats }: Scan): void {
    // Scans run concurrently (periodic, at spawn, during a stop). An older scan finishing after a
    // newer one would drop descendants only the newer one saw.
    if (seq <= this.observedSeq) return
    this.observedSeq = seq
    const byPid = new Map<number, ProcStat>()
    const children = new Map<number, ProcStat[]>()
    const members = new Map<number, ProcStat>()
    for (const s of stats) {
      byPid.set(s.pid, s)
      if (!isLive(s)) continue
      const siblings = children.get(s.ppid)
      if (siblings === undefined) children.set(s.ppid, [s])
      else siblings.push(s)
      if (s.session === this.pid && s.starttime >= this.startTime) members.set(s.pid, s)
    }
    let changed = false
    for (const [pid, starttime] of this.tracked) {
      const s = byPid.get(pid)
      if (s === undefined || s.starttime !== starttime || !isLive(s)) {
        this.tracked.delete(pid)
        changed = true
      } else members.set(pid, s)
    }
    const queue = [...members.values()]
    for (let parent = queue.pop(); parent !== undefined; parent = queue.pop()) {
      for (const child of children.get(parent.pid) ?? []) {
        // A child cannot be older than its parent; if it seems to be, the parent's PID was reused.
        if (child.starttime < parent.starttime || members.has(child.pid)) continue
        members.set(child.pid, child)
        queue.push(child)
      }
    }
    for (const s of members.values()) {
      if (s.pid === this.pid || this.tracked.get(s.pid) === s.starttime) continue
      this.tracked.set(s.pid, s.starttime)
      changed = true
    }
    this.members = members
    if (changed) this.notifyDescendants()
    if (this.finished()) this.ctx.scanner.remove(this)
  }

  private notifyDescendants(): void {
    for (const cb of this.descendantListeners) this.report(cb)
  }

  private report(cb: (descendants: readonly ProcessIdentity[]) => void): void {
    try {
      cb([...this.tracked].map(([pid, starttime]) => linuxIdentity(this.bootId, { pid, starttime })))
    } catch (error) {
      this.ctx.log?.record('error', 'process.descendants-listener-failed', { leader: this.pid, message: messageOf(error) })
    }
  }

  /**
   * Observes a fresh scan. If /proc cannot be read (e.g. EMFILE), the last observation stays in
   * effect: signals still go to known processes (each re-verified), and a stop that cannot verify
   * the end reports the last known processes as survivors instead of claiming success.
   */
  private async refresh(): Promise<void> {
    try {
      this.observe(await this.ctx.scan())
    } catch (error) {
      this.ctx.log?.record('warn', 'process.scan-failed', { leader: this.pid, message: messageOf(error) })
    }
  }

  /** Nothing attributed is alive and the leader has been reaped. */
  private finished(): boolean {
    return this.exitInfo !== null && this.members.size === 0
  }

  private async terminate(graceMs: number): Promise<StopResult> {
    // Scan at stop start, so descendants that appeared since the last periodic scan are included.
    await this.refresh()
    if (this.finished()) return { graceful: 'yes', forced: false, survivors: [] }
    this.signal('SIGTERM')
    if (await this.waitUntilFinished(graceMs, 'SIGTERM')) return { graceful: 'yes', forced: false, survivors: [] }
    this.forced = true
    this.signal('SIGKILL')
    if (await this.waitUntilFinished(this.ctx.killWaitMs, 'SIGKILL')) return { graceful: 'no', forced: true, survivors: [] }
    const survivors = this.liveInfo()
    this.ctx.log?.record('warn', 'process.survivors', { leader: this.pid, pids: survivors.map((s) => s.pid) })
    return { graceful: 'no', forced: true, survivors }
  }

  /** Polls until finished or `ms` elapsed; processes that appear meanwhile receive `signal` too. */
  private async waitUntilFinished(ms: number, signal: StopSignal): Promise<boolean> {
    const deadline = Date.now() + ms
    do {
      await delay(Math.max(0, Math.min(this.ctx.pollIntervalMs, deadline - Date.now())))
      await this.refresh()
      if (this.finished()) return true
      this.signal(signal)
    } while (Date.now() < deadline)
    return false
  }

  /**
   * Sends `signal` to the run. The process group and the unreaped leader are signalled once; every
   * other attributed process once per identity, after re-reading its start time immediately before
   * the signal (a residual race until `kill` remains; Node has no pidfd API).
   */
  private signal(signal: StopSignal): void {
    const sent = this.sent[signal]
    if (!sent.group) {
      sent.group = true
      // The group ID is the leader's PID. It cannot have been reused while the leader is unreaped
      // or while a live member of the group is known. `members` is fresh here: every caller
      // refreshes right before signalling.
      const groupExists = this.exitInfo === null || [...this.members.values()].some((s) => s.pgrp === this.pid)
      if (groupExists) safeKill(this.ctx, -this.pid, signal)
      // An unreaped direct child is the one process that may be signalled by PID alone.
      if (this.exitInfo === null) safeKill(this.ctx, this.pid, signal)
    }
    for (const s of this.members.values()) {
      if (s.pid === this.pid) continue
      const key = `${s.pid}:${s.starttime}`
      if (sent.processes.has(key)) continue
      const current = this.ctx.proc.stat(s.pid)
      if (current === null || current.starttime !== s.starttime || !isLive(current)) continue
      sent.processes.add(key)
      safeKill(this.ctx, s.pid, signal)
    }
  }

  /** The live attributed processes, the unreaped leader first. */
  private liveInfo(): ProcInfo[] {
    const info = (pid: number, comm: string): ProcInfo => {
      const args = this.ctx.proc.commandLine(pid)
      return { pid, name: displayName({ comm }, args), commandLine: args.join(' ') }
    }
    const list = [...this.members.values()].filter((s) => s.pid !== this.pid).map((s) => info(s.pid, s.comm))
    if (this.exitInfo === null) list.unshift(info(this.pid, this.members.get(this.pid)?.comm ?? this.ctx.proc.stat(this.pid)?.comm ?? ''))
    return list
  }
}
