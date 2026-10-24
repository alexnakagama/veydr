import type { PlatformLog, ProcessTree, Survivor } from '../platform/types'
import type { RunLedger } from '../supervisor/ledger'
import type { Supervisor } from '../supervisor/supervisor'

/** Overall deadline when Veydr is told to exit by a signal (design D9). */
export const SIGNAL_DEADLINE_MS = 10_000
/** Added to the longest stop timeout for the interactive quit deadline (design D10). */
export const QUIT_DEADLINE_MARGIN_MS = 2_000
/** Part of the signal deadline kept for checking and recording what survived. */
export const SIGNAL_CHECK_RESERVE_MS = 1_000

export type QuitChoice = 'retry' | 'quit'

export interface QuitDeps {
  readonly supervisor: Pick<Supervisor, 'stopAll' | 'active'>
  readonly ledger: Pick<RunLedger, 'sessionEntries' | 'remove' | 'flush'>
  readonly processTree: Pick<ProcessTree, 'findSurvivors' | 'terminateSurvivors'>
  /** Shows that commands are being stopped (the stopping overlay). */
  readonly showProgress: () => void
  /**
   * Lists what could not be verified as stopped and asks whether to retry or quit anyway.
   * `survivors` is empty if the check itself failed.
   */
  readonly confirm: (survivors: readonly Survivor[]) => Promise<QuitChoice>
  readonly log: PlatformLog
}

export interface QuitOrchestrator {
  /**
   * Quit requested by the user (design D10): stops every running command in parallel, waiting at
   * most the longest stop timeout + 2 s, then checks what is still alive. Anything left is listed
   * with Retry / Quit anyway. Resolves when Veydr may exit; repeated calls share one quit.
   */
  quit(): Promise<void>
  /**
   * Quit without asking (a signal such as SIGTERM, or a fatal error): the same stop-all, bounded
   * by `deadlineMs` overall. Resolves when Veydr should exit.
   */
  shutdown(deadlineMs: number): Promise<void>
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Resolves with `p`'s outcome, or with `onTimeout` after `ms`; never rejects if `p` does not. */
async function within<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<T>((done) => {
    timer = setTimeout(() => done(onTimeout), Math.max(0, ms))
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Quit orchestration. In the ledger, a run of this session stays only while something of it is
 * still alive (or could not be checked), so the next launch reports exactly that; after a clean
 * quit the ledger holds no run of this session. Runs inherited from an earlier session that the
 * user has not resolved are left as they are.
 */
export function createQuitOrchestrator(deps: QuitDeps): QuitOrchestrator {
  let stopping: Promise<boolean> | null = null
  let quitting: Promise<void> | null = null

  /** One stop-all for the whole quit; `false` if it failed. */
  const stopAll = (): Promise<boolean> =>
    (stopping ??= deps.supervisor.stopAll().then(
      () => true,
      (error: unknown) => {
        deps.log.record('error', 'quit.stop-all-failed', { message: messageOf(error) })
        return false
      },
    ))

  /** Survivors of this session's runs; `null` if they could not be determined. */
  const check = async (): Promise<Survivor[] | null> => {
    const entries = deps.ledger.sessionEntries()
    if (entries.length === 0) return []
    try {
      return await deps.processTree.findSurvivors(entries)
    } catch (error) {
      deps.log.record('error', 'quit.check-failed', { message: messageOf(error) })
      return null
    }
  }

  /** Keeps only runs with survivors (all runs if unknown) and writes the ledger. */
  const record = async (survivors: readonly Survivor[] | null): Promise<void> => {
    if (survivors !== null) {
      const keep = new Set(survivors.map((s) => s.runId))
      for (const entry of deps.ledger.sessionEntries()) if (!keep.has(entry.runId)) deps.ledger.remove(entry.runId)
    }
    await deps.ledger.flush()
  }

  /** Something may be running or survived (`active()` includes runs still being started). */
  const anythingToStop = (): boolean => deps.supervisor.active().length > 0 || deps.ledger.sessionEntries().length > 0

  // Stop-all always runs, also when nothing seems to run: it refuses starts from then on, and a
  // start requested just before is stopped once it has spawned.
  const quit = async (): Promise<void> => {
    const active = deps.supervisor.active()
    if (anythingToStop()) deps.showProgress()
    const deadline = Math.max(0, ...active.map((run) => run.graceMs)) + QUIT_DEADLINE_MARGIN_MS
    deps.log.record('info', 'quit.stopping', { commands: active.map((run) => run.commandId), deadlineMs: deadline })
    await within(stopAll(), deadline, false)
    for (;;) {
      const survivors = await check()
      if (survivors !== null && survivors.length === 0) return record(survivors)
      deps.log.record('warn', 'quit.not-verified', { pids: survivors?.map((s) => s.identity.pid) ?? null })
      if ((await deps.confirm(survivors ?? [])) === 'quit') {
        deps.log.record('warn', 'quit.anyway', { pids: survivors?.map((s) => s.identity.pid) ?? null })
        return record(survivors)
      }
      if (survivors !== null && survivors.length > 0) {
        await deps.processTree.terminateSurvivors(survivors).catch((error: unknown) => {
          deps.log.record('error', 'quit.terminate-failed', { message: messageOf(error) })
        })
      }
      // Stops still in progress after the deadline get another chance to finish.
      await within(stopAll(), QUIT_DEADLINE_MARGIN_MS, false)
    }
  }

  const shutdown = async (deadlineMs: number): Promise<void> => {
    const deadlineAt = Date.now() + deadlineMs
    if (anythingToStop()) deps.showProgress()
    deps.log.record('info', 'quit.shutdown', { commands: deps.supervisor.active().map((run) => run.commandId), deadlineMs })
    await within(stopAll(), deadlineAt - Date.now() - SIGNAL_CHECK_RESERVE_MS, false)
    const survivors = await within(check(), deadlineAt - Date.now(), null)
    if (survivors === null || survivors.length > 0) deps.log.record('warn', 'quit.not-verified', { pids: survivors?.map((s) => s.identity.pid) ?? null })
    await within(record(survivors), deadlineAt - Date.now(), undefined)
  }

  return {
    quit: () => (quitting ??= quit()),
    shutdown,
  }
}
