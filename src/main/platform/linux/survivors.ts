import { DEFAULT_STOP_TIMEOUT_MS } from '../../../shared/config'
import type { LedgerEntry, PlatformLog, ProcInfo, ProcessIdentity, ProcessTree, StopResult, Survivor } from '../types'
import { createProcReader, type ProcReader } from './proc-reader'
import { KILL_WAIT_MS, POLL_INTERVAL_MS } from './process-tree'
import { displayName, isLive, linuxIdentity, parseLinuxIdentity, type ProcStat } from './procfs'

export interface LinuxSurvivorOptions {
  readonly proc?: ProcReader
  /** Sends a signal (`process.kill`); only positive PIDs are used here. */
  readonly kill?: (target: number, signal: NodeJS.Signals) => void
  /** Time survivors get to end after SIGTERM (the default stop timeout, 5 s). */
  readonly graceMs?: number
  readonly pollIntervalMs?: number
  readonly killWaitMs?: number
  /** This process; never reported or signalled. */
  readonly selfPid?: number
  readonly log?: PlatformLog
}

type StopSignal = 'SIGTERM' | 'SIGKILL'

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/**
 * Crash recovery on Linux (design D9). A process of a recorded run survives if it is alive and is
 * the recorded process: same boot, same PID, same start time. Besides the recorded leader and
 * descendants, the live members of the recorded session started no earlier than the leader count,
 * unless the leader's PID now belongs to another process (then the session ID may have been
 * reused, and its members are not ours). Linux does not reuse a PID while it is still the ID of a
 * live process's session, so with the leader gone the session's members are still the run's.
 */
export function createLinuxSurvivors(options: LinuxSurvivorOptions = {}): Pick<ProcessTree, 'findSurvivors' | 'terminateSurvivors'> {
  const proc = options.proc ?? createProcReader()
  const kill = options.kill ?? ((target, signal) => process.kill(target, signal))
  const graceMs = options.graceMs ?? DEFAULT_STOP_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
  const killWaitMs = options.killWaitMs ?? KILL_WAIT_MS
  const selfPid = options.selfPid ?? process.pid

  const info = (stat: Pick<ProcStat, 'pid' | 'comm'>): ProcInfo => {
    const args = proc.commandLine(stat.pid)
    return { pid: stat.pid, name: displayName(stat, args), commandLine: args.join(' ') }
  }

  const safeKill = (pid: number, signal: StopSignal): void => {
    try {
      kill(pid, signal)
    } catch (error) {
      const code = errnoOf(error)
      if (code === 'ESRCH') return
      // EPERM: reported as a survivor if it stays alive.
      options.log?.record('warn', 'process.signal-failed', { target: pid, signal, code: code ?? messageOf(error) })
    }
  }

  return {
    async findSurvivors(entries: readonly LedgerEntry[]): Promise<Survivor[]> {
      if (entries.length === 0) return []
      const bootId = proc.bootId()
      const byPid = new Map<number, ProcStat>()
      for (const s of await proc.scan()) byPid.set(s.pid, s)

      /** The live process `identity` names, if it is still that process. */
      const verified = (identity: ProcessIdentity): ProcStat | null => {
        const parsed = parseLinuxIdentity(identity)
        if (parsed === null || parsed.bootId !== bootId) return null
        const s = byPid.get(identity.pid)
        return s !== undefined && isLive(s) && s.starttime === parsed.starttime ? s : null
      }

      const found = new Map<number, Survivor>()
      for (const entry of entries) {
        const leader = parseLinuxIdentity(entry.leader)
        // Recorded during another boot: none of its processes can exist any more.
        if (leader === null || leader.bootId !== bootId) continue
        const add = (s: ProcStat): void => {
          if (s.pid === selfPid || found.has(s.pid)) return
          found.set(s.pid, { commandId: entry.commandId, runId: entry.runId, identity: linuxIdentity(bootId, s), info: info(s) })
        }
        for (const identity of [entry.leader, ...entry.descendants]) {
          const s = verified(identity)
          if (s !== null) add(s)
        }
        if (entry.sessionId === null) continue
        const holder = byPid.get(entry.sessionId)
        if (holder !== undefined && holder.starttime !== leader.starttime) continue
        for (const s of byPid.values()) {
          if (s.session === entry.sessionId && s.starttime >= leader.starttime && isLive(s)) add(s)
        }
      }
      return [...found.values()]
    },

    async terminateSurvivors(survivors: readonly Survivor[]): Promise<StopResult> {
      if (survivors.length === 0) return { graceful: 'yes', forced: false, survivors: [] }
      const bootId = proc.bootId()
      /** PID → start time of every process to end: the survivors and descendants they start meanwhile. */
      const targets = new Map<number, number>()
      for (const survivor of survivors) {
        const parsed = parseLinuxIdentity(survivor.identity)
        if (parsed !== null && parsed.bootId === bootId && survivor.identity.pid !== selfPid) targets.set(survivor.identity.pid, parsed.starttime)
      }
      const sent: Record<StopSignal, Set<string>> = { SIGTERM: new Set(), SIGKILL: new Set() }

      /** Adds live children of targets (a child is never older than its parent). */
      const refresh = async (): Promise<void> => {
        let stats: ProcStat[]
        try {
          stats = await proc.scan()
        } catch (error) {
          options.log?.record('warn', 'process.scan-failed', { message: messageOf(error) })
          return
        }
        const live = stats.filter(isLive)
        const byPid = new Map(live.map((s) => [s.pid, s]))
        for (let added = true; added; ) {
          added = false
          for (const s of live) {
            const parentStart = targets.get(s.ppid)
            // The parent must still be the target itself, not a process that reused its PID.
            if (parentStart === undefined || byPid.get(s.ppid)?.starttime !== parentStart) continue
            if (targets.has(s.pid) || s.starttime < parentStart || s.pid === selfPid) continue
            targets.set(s.pid, s.starttime)
            added = true
          }
        }
      }

      /** Live targets, each re-read now. */
      const alive = (): ProcStat[] => {
        const list: ProcStat[] = []
        for (const [pid, starttime] of targets) {
          const s = proc.stat(pid)
          if (s !== null && s.starttime === starttime && isLive(s)) list.push(s)
        }
        return list
      }

      // Every target is re-verified immediately before its signal; it may have ended and its PID been reused.
      const signal = (sig: StopSignal): void => {
        for (const s of alive()) {
          const key = `${s.pid}:${s.starttime}`
          if (sent[sig].has(key)) continue
          sent[sig].add(key)
          safeKill(s.pid, sig)
        }
      }

      const waitUntilGone = async (ms: number, sig: StopSignal): Promise<boolean> => {
        const deadline = Date.now() + ms
        do {
          await delay(Math.max(0, Math.min(pollIntervalMs, deadline - Date.now())))
          await refresh()
          if (alive().length === 0) return true
          signal(sig)
        } while (Date.now() < deadline)
        return false
      }

      await refresh()
      signal('SIGTERM')
      if (await waitUntilGone(graceMs, 'SIGTERM')) return { graceful: 'yes', forced: false, survivors: [] }
      signal('SIGKILL')
      if (await waitUntilGone(killWaitMs, 'SIGKILL')) return { graceful: 'no', forced: true, survivors: [] }
      const left = alive().map(info)
      options.log?.record('warn', 'process.survivors', { pids: left.map((s) => s.pid) })
      return { graceful: 'no', forced: true, survivors: left }
    },
  }
}
