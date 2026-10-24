import type { Notice, NoticeProcess, ProcessInfo, ResolveSurvivorsRequest } from '../../shared/api'
import type { NoticeCenter } from '../app/notices'
import type { LedgerEntry, PlatformLog, ProcessTree, Survivor } from '../platform/types'
import type { RunLedger } from './ledger'

export interface CrashRecoveryDeps {
  readonly processTree: Pick<ProcessTree, 'findSurvivors' | 'terminateSurvivors'>
  readonly ledger: Pick<RunLedger, 'remove'>
  readonly notices: Pick<NoticeCenter, 'add' | 'withdraw'>
  readonly log: PlatformLog
}

/**
 * Processes that outlived an abnormal end of the previous session (design D9, spec: crash
 * recovery). They are shown to the user and terminated only on the user's explicit request;
 * nothing is restarted.
 */
export interface CrashRecovery {
  /**
   * Checks the runs the previous session left in the ledger, once at startup before the window
   * opens. Runs with nothing alive are removed from the ledger; survivors are shown as a
   * `crash-survivors` notice. Nothing is signalled.
   */
  check(entries: readonly LedgerEntry[]): Promise<void>
  /**
   * `terminate` ends the survivors and returns those still alive afterwards (shown again as a new
   * notice); `dismiss` leaves them running and forgets them. Requests are handled one at a time.
   */
  resolve(action: ResolveSurvivorsRequest['action']): Promise<ProcessInfo[]>
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

const noticeProcesses = (survivors: readonly Survivor[]): NoticeProcess[] =>
  survivors.map(({ info }) => ({ pid: info.pid, name: info.name, commandLine: info.commandLine }))

export function createCrashRecovery(deps: CrashRecoveryDeps): CrashRecovery {
  let pending: readonly Survivor[] = []
  let noticeId: string | null = null
  let tail: Promise<unknown> = Promise.resolve()

  const show = (survivors: readonly Survivor[], message: string): void => {
    if (noticeId !== null) deps.notices.withdraw(noticeId)
    noticeId = null
    pending = survivors
    if (survivors.length === 0) return
    const notice: Omit<Notice, 'id'> = { kind: 'crash-survivors', severity: 'warning', message, files: [], processes: noticeProcesses(survivors) }
    noticeId = deps.notices.add(notice).id
  }

  /** Removes from the ledger every run of `resolved` that has no process in `remaining`. */
  const forgetRuns = (resolved: readonly Survivor[], remaining: readonly Survivor[]): void => {
    const keep = new Set(remaining.map((s) => s.runId))
    for (const runId of new Set(resolved.map((s) => s.runId))) if (!keep.has(runId)) deps.ledger.remove(runId)
  }

  const resolve = async (action: ResolveSurvivorsRequest['action']): Promise<ProcessInfo[]> => {
    const survivors = pending
    if (survivors.length === 0) return []
    if (action === 'dismiss') {
      deps.log.record('info', 'recovery.dismissed', { pids: survivors.map((s) => s.identity.pid) })
      forgetRuns(survivors, [])
      show([], '')
      return []
    }
    let alive: ReadonlySet<number>
    try {
      const result = await deps.processTree.terminateSurvivors(survivors)
      alive = new Set(result.survivors.map((s) => s.pid))
    } catch (error) {
      // Nothing could be verified: every survivor counts as still running.
      deps.log.record('error', 'recovery.terminate-failed', { message: messageOf(error) })
      alive = new Set(survivors.map((s) => s.identity.pid))
    }
    const remaining = survivors.filter((s) => alive.has(s.identity.pid))
    forgetRuns(survivors, remaining)
    show(remaining, `${plural(remaining.length, 'process', 'processes')} from an earlier session could not be terminated.`)
    deps.log.record('info', 'recovery.terminated', { terminated: survivors.length - remaining.length, remaining: remaining.map((s) => s.identity.pid) })
    return remaining.map(({ info }) => ({ pid: info.pid, name: info.name }))
  }

  return {
    async check(entries) {
      if (entries.length === 0) return
      let survivors: Survivor[]
      try {
        survivors = await deps.processTree.findSurvivors(entries)
      } catch (error) {
        // The runs stay in the ledger, so the next launch checks them again.
        deps.log.record('error', 'recovery.check-failed', { message: messageOf(error) })
        deps.notices.add({
          kind: 'ledger-problem',
          severity: 'warning',
          message: `Veydr could not check whether processes it started in an earlier session are still running (${messageOf(error)}).`,
          files: [],
        })
        return
      }
      const withSurvivors = new Set(survivors.map((s) => s.runId))
      for (const entry of entries) if (!withSurvivors.has(entry.runId)) deps.ledger.remove(entry.runId)
      deps.log.record('info', 'recovery.checked', { runs: entries.length, survivors: survivors.map((s) => s.identity.pid) })
      show(
        survivors,
        `${plural(survivors.length, 'process', 'processes')} started by Veydr in an earlier session ${survivors.length === 1 ? 'is' : 'are'} still running. Nothing was restarted.`,
      )
    },

    resolve(action) {
      const result = tail.then(() => resolve(action))
      tail = result.catch(() => undefined)
      return result
    },
  }
}
