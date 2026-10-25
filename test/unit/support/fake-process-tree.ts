import { PassThrough } from 'node:stream'
import type { ExitInfo, ManagedProcess, ProcInfo, ProcessIdentity, ProcessTree, SpawnPlan, StopResult } from '../../../src/main/platform/types'

/** How the next spawned fake process behaves. */
export interface FakeBehavior {
  /** Rejects the spawn with this error instead of starting a process. */
  readonly spawnError: Error | null
  readonly spawnDelayMs: number
  readonly stopDelayMs: number
  /** The tree ignores the graceful request; stops report `forced`. */
  readonly uncooperative: boolean
  /** Descendants that survive a forced stop (reported as survivors). */
  readonly survivors: number
  /** Descendants left running when the leader exits on its own. */
  readonly leftovers: number
  /** `stop()` rejects with this error (the processes stay as they are). */
  readonly stopError?: Error
  /** `remaining()` rejects with this error. */
  readonly remainingError?: Error
}

export const cooperative: FakeBehavior = {
  spawnError: null,
  spawnDelayMs: 0,
  stopDelayMs: 0,
  uncooperative: false,
  survivors: 0,
  leftovers: 0,
}

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/** A fake run: a leader plus a count of live descendants. */
export class FakeProcess implements ManagedProcess {
  readonly identity
  readonly sessionId: number
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  leaderAlive = true
  descendants: number
  stopCalls = 0
  stopGraceMs: number[] = []
  private exitInfo: ExitInfo | null = null
  private readonly listeners: ((e: ExitInfo) => void)[] = []
  private readonly descendantListeners: ((d: readonly ProcessIdentity[]) => void)[] = []
  private stopping: Promise<StopResult> | null = null

  constructor(
    readonly pid: number,
    readonly plan: SpawnPlan,
    readonly behavior: FakeBehavior,
    /** Descendants started with the leader. */
    descendants = 2,
  ) {
    this.identity = { pid, token: `fake:${pid}` }
    this.sessionId = pid
    this.descendants = descendants
  }

  get alive(): boolean {
    return this.leaderAlive || this.descendants > 0
  }

  onExit(cb: (e: ExitInfo) => void): void {
    if (this.exitInfo !== null) {
      const info = this.exitInfo
      queueMicrotask(() => cb(info))
      return
    }
    this.listeners.push(cb)
  }

  onDescendantsChange(cb: (d: readonly ProcessIdentity[]) => void): void {
    this.descendantListeners.push(cb)
  }

  /** Simulates an observation that found `descendants`. */
  observeDescendants(descendants: readonly ProcessIdentity[]): void {
    for (const cb of this.descendantListeners) cb(descendants)
  }

  /** The leader exits on its own, leaving `behavior.leftovers` descendants. */
  exit(code: number | null, signal: string | null = null): void {
    if (!this.leaderAlive) return
    this.descendants = Math.min(this.descendants, this.behavior.leftovers)
    this.leaderDied({ code, signal, forced: false })
  }

  remaining(): Promise<readonly ProcInfo[]> {
    if (this.behavior.remainingError !== undefined) return Promise.reject(this.behavior.remainingError)
    return Promise.resolve(this.live())
  }

  attributed(): Promise<readonly ProcessIdentity[]> {
    return Promise.resolve(this.live().map(({ pid }) => ({ pid, token: `fake:${pid}` })))
  }

  stop({ graceMs }: { graceMs: number }): Promise<StopResult> {
    this.stopping ??= (async () => {
      this.stopCalls++
      this.stopGraceMs.push(graceMs)
      await delay(this.behavior.stopDelayMs)
      if (this.behavior.stopError !== undefined) {
        this.stopping = null
        throw this.behavior.stopError
      }
      const forced = this.behavior.uncooperative
      this.descendants = forced ? this.behavior.survivors : 0
      if (this.leaderAlive) this.leaderDied({ code: null, signal: forced ? 'SIGKILL' : 'SIGTERM', forced })
      const survivors = this.live()
      this.stopping = null
      return { graceful: forced ? 'no' : 'yes', forced, survivors }
    })()
    return this.stopping
  }

  private live(): ProcInfo[] {
    const leader = this.leaderAlive ? [{ pid: this.pid, name: 'leader', commandLine: this.plan.file }] : []
    const rest = Array.from({ length: this.descendants }, (_, i) => ({ pid: this.pid * 100 + i, name: 'child', commandLine: 'child' }))
    return [...leader, ...rest]
  }

  private leaderDied(info: ExitInfo): void {
    this.leaderAlive = false
    this.exitInfo = info
    for (const cb of this.listeners.splice(0)) queueMicrotask(() => cb(info))
  }
}

export class FakeProcessTree implements Pick<ProcessTree, 'spawn'> {
  behavior: FakeBehavior = cooperative
  readonly spawned: FakeProcess[] = []
  /** Spawn calls, including failed ones. */
  spawnCalls = 0
  private nextPid = 1000

  async spawn(plan: SpawnPlan): Promise<ManagedProcess> {
    const behavior = this.behavior
    this.spawnCalls++
    await delay(behavior.spawnDelayMs)
    if (behavior.spawnError !== null) throw behavior.spawnError
    const process = new FakeProcess(this.nextPid++, plan, behavior)
    this.spawned.push(process)
    return process
  }

  get last(): FakeProcess {
    const last = this.spawned.at(-1)
    if (last === undefined) throw new Error('nothing spawned')
    return last
  }

  /** Spawned processes whose leader is alive. */
  liveLeaders(): FakeProcess[] {
    return this.spawned.filter((p) => p.leaderAlive)
  }
}
