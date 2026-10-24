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
  /** Session the run's processes belong to (Linux: the leader's PID); `null` where the platform has none. */
  readonly sessionId: number | null
  readonly stdout: Readable
  readonly stderr: Readable
  /** `cb` runs once when the leader exits, or soon after registration if it already has. */
  onExit(cb: (e: ExitInfo) => void): void
  /**
   * `cb` runs with every observed descendant (not the leader) each time an observation changes
   * that set, and soon after registration if descendants were observed before it (for the
   * crash-recovery ledger, design D9).
   */
  onDescendantsChange(cb: (descendants: readonly ProcessIdentity[]) => void): void
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
  /**
   * Starts `plan` unsupervised (e.g. an editor): never tracked, signalled, or stopped by Veydr, and
   * it keeps running when Veydr quits. Resolves once started; rejects with `SpawnError` otherwise.
   */
  launchDetached(plan: SpawnPlan): Promise<void>
  /**
   * Processes of recorded runs that are still alive, each verified to be the recorded process
   * (design D9). Runs recorded during another boot have none. Nothing is signalled.
   */
  findSurvivors(entries: readonly LedgerEntry[]): Promise<Survivor[]>
  /**
   * Terminates survivors found by `findSurvivors`: graceful request, then forced; each process is
   * re-verified before every signal. `survivors` of the result are those still alive afterwards.
   */
  terminateSurvivors(s: readonly Survivor[]): Promise<StopResult>
}

export interface CommandResolver {
  /** How to start `spec` with `env`, or why it cannot start (diagnostics meant for the user). */
  resolve(spec: CommandSpec, env: Env): Promise<ResolveResult>
}

export interface EnvProvider {
  /**
   * The environment commands start from (the user's login environment without Veydr's runtime
   * variables), resolved anew on every call; `warnings` explain a fallback.
   */
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
