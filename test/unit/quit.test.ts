import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQuitOrchestrator, QUIT_DEADLINE_MARGIN_MS, SIGNAL_CHECK_RESERVE_MS, type QuitChoice } from '../../src/main/app/quit'
import type { LedgerEntry, Survivor } from '../../src/main/platform/types'
import type { ActiveRun } from '../../src/main/supervisor/supervisor'
import { quietLog } from './support/config'

// Tasks 5.4 and 5.5: quit orchestration (design D10) against fakes; the real app is covered by
// test/e2e/quit.spec.ts.

const entry = (runId: string): LedgerEntry => ({ commandId: `cmd-${runId}`, runId, leader: { pid: 1, token: 't' }, sessionId: 1, descendants: [] })
const survivor = (runId: string, pid: number): Survivor => ({ commandId: `cmd-${runId}`, runId, identity: { pid, token: `t${pid}` }, info: { pid, name: `p${pid}`, commandLine: '' } })

afterEach(() => {
  vi.useRealTimers()
})

interface Options {
  readonly active?: ActiveRun[]
  readonly entries?: LedgerEntry[]
  /** How stopAll behaves: resolves after `ms`, never, or rejects. */
  readonly stopAll?: { ms: number } | 'never' | Error
  /** Survivors found by each successive check (the last one repeats). */
  readonly checks?: (Survivor[] | Error)[]
  readonly answers?: QuitChoice[]
}

function setup(options: Options = {}) {
  const entries = new Map((options.entries ?? []).map((e) => [e.runId, e]))
  const calls: string[] = []
  const confirmed: number[][] = []
  const checks = [...(options.checks ?? [[]])]
  const answers = [...(options.answers ?? [])]
  let active = options.active ?? []
  const orchestrator = createQuitOrchestrator({
    supervisor: {
      stopAll: () => {
        calls.push('stopAll')
        const behavior = options.stopAll ?? { ms: 0 }
        if (behavior === 'never') return new Promise(() => undefined)
        if (behavior instanceof Error) return Promise.reject(behavior)
        return new Promise((done) =>
          setTimeout(() => {
            active = []
            done()
          }, behavior.ms),
        )
      },
      active: () => active,
    },
    ledger: {
      sessionEntries: () => [...entries.values()],
      remove: (runId) => {
        calls.push(`remove ${runId}`)
        entries.delete(runId)
      },
      flush: () => {
        calls.push('flush')
        return Promise.resolve()
      },
    },
    processTree: {
      findSurvivors: () => {
        calls.push('check')
        const result = checks.length > 1 ? checks.shift() : checks[0]
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result ?? [])
      },
      terminateSurvivors: (s) => {
        calls.push(`terminate ${s.map((x) => x.identity.pid).join(',')}`)
        return Promise.resolve({ graceful: 'yes', forced: false, survivors: [] })
      },
    },
    showProgress: () => calls.push('progress'),
    confirm: (survivors) => {
      calls.push('confirm')
      confirmed.push(survivors.map((s) => s.identity.pid))
      return Promise.resolve(answers.shift() ?? 'quit')
    },
    log: quietLog(),
  })
  return { orchestrator, calls, confirmed, entries }
}

describe('interactive quit', () => {
  it('quits at once when nothing runs and nothing is recorded, still refusing starts first (stop-all)', async () => {
    const h = setup()
    await h.orchestrator.quit()
    expect(h.calls).toEqual(['stopAll', 'flush'])
  })

  it('stops a start that is still in flight (active, but not recorded yet) and waits for its stop timeout', async () => {
    vi.useFakeTimers()
    const h = setup({ active: [{ commandId: 'a', graceMs: 4000 }], stopAll: { ms: 3000 }, checks: [[]] })
    let done = false
    void h.orchestrator.quit().then(() => (done = true))
    await vi.advanceTimersByTimeAsync(2999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
    expect(h.calls).toEqual(['progress', 'stopAll', 'flush'])
  })

  it('shows progress, stops everything, verifies nothing survived, and leaves no run of this session in the ledger', async () => {
    const h = setup({ active: [{ commandId: 'a', graceMs: 5000 }], entries: [entry('r1'), entry('r2')], checks: [[]] })
    await h.orchestrator.quit()
    expect(h.calls).toEqual(['progress', 'stopAll', 'check', 'remove r1', 'remove r2', 'flush'])
    expect(h.entries.size).toBe(0)
  })

  it('also checks runs that ended with survivors earlier in the session', async () => {
    const h = setup({ entries: [entry('r1')], checks: [[survivor('r1', 7)], []], answers: ['retry'] })
    await h.orchestrator.quit()
    expect(h.calls).toEqual(['progress', 'stopAll', 'check', 'confirm', 'terminate 7', 'check', 'remove r1', 'flush'])
  })

  it('[spec:process-supervision/stop-failures-on-quit] lists what survived; retry terminates it and checks again; quit anyway keeps only those runs', async () => {
    const h = setup({
      active: [{ commandId: 'a', graceMs: 100 }],
      entries: [entry('r1'), entry('r2')],
      checks: [[survivor('r1', 7)], [survivor('r1', 7)]],
      answers: ['retry', 'quit'],
    })
    await h.orchestrator.quit()
    expect(h.confirmed).toEqual([[7], [7]])
    expect(h.calls).toEqual(['progress', 'stopAll', 'check', 'confirm', 'terminate 7', 'check', 'confirm', 'remove r2', 'flush'])
    expect([...h.entries.keys()]).toEqual(['r1'])
  })

  it('waits at most the longest stop timeout + 2 s for the stops, then checks what is alive', async () => {
    vi.useFakeTimers()
    const h = setup({ active: [{ commandId: 'a', graceMs: 1000 }, { commandId: 'b', graceMs: 3000 }], entries: [entry('r1')], stopAll: 'never', checks: [[survivor('r1', 7)]] })
    let done = false
    void h.orchestrator.quit().then(() => (done = true))
    await vi.advanceTimersByTimeAsync(3000 + QUIT_DEADLINE_MARGIN_MS - 1)
    expect(h.calls).toEqual(['progress', 'stopAll'])
    await vi.advanceTimersByTimeAsync(1)
    expect(h.calls).toEqual(['progress', 'stopAll', 'check', 'confirm', 'flush'])
    expect(done).toBe(true)
    // Quit anyway with a run still being stopped: its entry stays for the next launch.
    expect([...h.entries.keys()]).toEqual(['r1'])
  })

  it('asks (with nothing listed) and keeps every run when survivors cannot be checked', async () => {
    const h = setup({ active: [{ commandId: 'a', graceMs: 100 }], entries: [entry('r1')], checks: [new Error('EMFILE')] })
    await h.orchestrator.quit()
    expect(h.confirmed).toEqual([[]])
    expect(h.calls).toEqual(['progress', 'stopAll', 'check', 'confirm', 'flush'])
    expect(h.entries.size).toBe(1)
  })

  it('shares one quit between repeated requests', async () => {
    const h = setup({ active: [{ commandId: 'a', graceMs: 100 }], entries: [entry('r1')], stopAll: { ms: 10 } })
    await Promise.all([h.orchestrator.quit(), h.orchestrator.quit()])
    expect(h.calls.filter((c) => c === 'stopAll')).toHaveLength(1)
    expect(h.calls.filter((c) => c === 'progress')).toHaveLength(1)
  })

  it('still verifies when stop-all fails', async () => {
    const h = setup({ active: [{ commandId: 'a', graceMs: 100 }], entries: [entry('r1')], stopAll: new Error('boom'), checks: [[]] })
    await h.orchestrator.quit()
    expect(h.calls).toEqual(['progress', 'stopAll', 'check', 'remove r1', 'flush'])
  })
})

describe('shutdown on a signal or fatal error', () => {
  it('also runs stop-all when nothing seems to run, so a start in flight cannot begin after it', async () => {
    const h = setup()
    await h.orchestrator.shutdown(10_000)
    expect(h.calls).toEqual(['stopAll', 'flush'])
  })

  it('stops everything without asking and clears the verified runs', async () => {
    const h = setup({ active: [{ commandId: 'a', graceMs: 5000 }], entries: [entry('r1')], checks: [[]] })
    await h.orchestrator.shutdown(10_000)
    expect(h.calls).toEqual(['progress', 'stopAll', 'check', 'remove r1', 'flush'])
  })

  it('keeps survivors in the ledger and never asks', async () => {
    const h = setup({ active: [{ commandId: 'a', graceMs: 5000 }], entries: [entry('r1'), entry('r2')], checks: [[survivor('r2', 9)]] })
    await h.orchestrator.shutdown(10_000)
    expect(h.calls).not.toContain('confirm')
    expect([...h.entries.keys()]).toEqual(['r2'])
  })

  it('gives up waiting for the stops so that the whole shutdown fits the deadline', async () => {
    vi.useFakeTimers()
    const h = setup({ active: [{ commandId: 'a', graceMs: 60_000 }], entries: [entry('r1')], stopAll: 'never', checks: [[survivor('r1', 3)]] })
    let done = false
    void h.orchestrator.shutdown(10_000).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(10_000 - SIGNAL_CHECK_RESERVE_MS - 1)
    expect(h.calls).toEqual(['progress', 'stopAll'])
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
    expect(h.calls).toEqual(['progress', 'stopAll', 'check', 'flush'])
    expect([...h.entries.keys()]).toEqual(['r1'])
  })

  it('shares the stop-all of an interactive quit already in progress', async () => {
    const h = setup({ active: [{ commandId: 'a', graceMs: 100 }], entries: [entry('r1')], stopAll: { ms: 20 }, checks: [[]] })
    const quit = h.orchestrator.quit()
    await h.orchestrator.shutdown(10_000)
    await quit
    expect(h.calls.filter((c) => c === 'stopAll')).toHaveLength(1)
  })
})
