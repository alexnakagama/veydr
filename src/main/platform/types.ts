import type { Readable } from 'node:stream'
import type { PlatformName } from '../../shared/api'

/** Environment as an opaque map; key comparison is platform-defined. */
export type Env = Readonly<Record<string, string>>

/** Opaque, platform-defined identity of an OS process (e.g. PID + start time). */
export interface ProcessIdentity {
  readonly pid: number
  readonly token: string
}

export interface ProcInfo {
  readonly pid: number
  readonly name: string
  readonly commandLine: string
}

export interface SpawnPlan {
  readonly file: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Env
}

export interface ExitInfo {
  readonly code: number | null
  readonly signal: string | null
  readonly forced: boolean
}

export interface StopResult {
  readonly graceful: 'yes' | 'no' | 'unsupported'
  readonly forced: boolean
  readonly survivors: readonly ProcInfo[]
}

/** A started command: its leader process and every process attributed to it. */
export interface ManagedProcess {
  /** PID of the leader. */
  readonly pid: number
  readonly identity: ProcessIdentity
  readonly stdout: Readable
  readonly stderr: Readable
  /** `cb` runs once when the leader exits, or soon after registration if it already has. */
  onExit(cb: (e: ExitInfo) => void): void
  /** Attributed processes still alive, including the leader until it has exited. */
  remaining(): Promise<readonly ProcInfo[]>
  /**
   * Terminates every attributed process: graceful request, then forced after `graceMs`.
   * Resolves once nothing attributed is alive (the leader's exit has been observed) or the forced
   * stop gave up; concurrent calls share one stop.
   */
  stop(opts: { graceMs: number }): Promise<StopResult>
}

export interface LedgerEntry {
  readonly commandId: string
  readonly runId: string
  readonly leader: ProcessIdentity
  readonly sessionId: number | null
  readonly descendants: readonly ProcessIdentity[]
}

export interface Survivor {
  readonly commandId: string
  readonly runId: string
  readonly identity: ProcessIdentity
  readonly info: ProcInfo
}

export interface CommandSpec {
  readonly mode: 'direct' | 'shell'
  readonly file: string
  readonly args: readonly string[]
  readonly script: string
  readonly shellPath: string | null
  readonly projectRoot: string
  readonly cwd: string
}

export type ResolveResult =
  | { readonly ok: true; readonly plan: SpawnPlan }
  | { readonly ok: false; readonly diagnostics: readonly string[] }

export interface PortOwnerKnown {
  readonly kind: 'known'
  readonly pid: number
  readonly name: string
}
export type PortOwner = PortOwnerKnown | { readonly kind: 'restricted' } | { readonly kind: 'unknown' }

export interface ListeningPort {
  readonly protocol: 'tcp' | 'tcp6'
  readonly address: string
  readonly port: number
  readonly owner: PortOwner
}

export interface PortSnapshot {
  readonly takenAt: number
  readonly ports: readonly ListeningPort[]
}

export interface ProcessTree {
  /** Starts `plan`; rejects with `SpawnError` (and creates no process) if it cannot be started. */
  spawn(plan: SpawnPlan): Promise<ManagedProcess>
  launchDetached(plan: SpawnPlan): void
  findSurvivors(entries: readonly LedgerEntry[]): Promise<Survivor[]>
  terminateSurvivors(s: readonly Survivor[]): Promise<StopResult>
}

export interface CommandResolver {
  resolve(spec: CommandSpec, env: Env): ResolveResult
}

export interface EnvProvider {
  base(): Promise<{ env: Env; warnings: string[] }>
}

export interface PortInspector {
  list(): Promise<PortSnapshot>
}

/** Diagnostic sink for platform implementations (structurally the application diagnostic log). */
export interface PlatformLog {
  record(level: 'info' | 'warn' | 'error', event: string, detail?: Record<string, unknown>): void
}

/** Everything platform-dependent, selected once by the composition root. */
export interface Platform {
  readonly name: PlatformName
  readonly supported: boolean
  readonly processTree: ProcessTree
  readonly commandResolver: CommandResolver
  readonly envProvider: EnvProvider
  readonly portInspector: PortInspector
}
