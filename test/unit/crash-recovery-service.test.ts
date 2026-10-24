import { describe, expect, it } from 'vitest'
import type { LedgerEntry, StopResult, Survivor } from '../../src/main/platform/types'
import { createCrashRecovery } from '../../src/main/supervisor/recovery'
import type { Notice } from '../../src/shared/api'
import { quietLog } from './support/config'

// Task 5.3: survivors of an earlier session are shown and terminated only on request.

const entry = (runId: string): LedgerEntry => ({ commandId: `cmd-${runId}`, runId, leader: { pid: 1, token: 't' }, sessionId: 1, descendants: [] })

const survivor = (runId: string, pid: number): Survivor => ({
  commandId: `cmd-${runId}`,
  runId,
  identity: { pid, token: `t${pid}` },
  info: { pid, name: `p${pid}`, commandLine: `/bin/p${pid} --serve` },
})

function setup(found: Survivor[] | Error, terminate: (s: readonly Survivor[]) => Promise<StopResult> = () => Promise.resolve({ graceful: 'yes', forced: false, survivors: [] })) {
  const removed: string[] = []
  const shown: Notice[] = []
  const withdrawn: string[] = []
  const terminated: number[][] = []
  let next = 1
  const recovery = createCrashRecovery({
    processTree: {
      findSurvivors: () => (found instanceof Error ? Promise.reject(found) : Promise.resolve(found)),
      terminateSurvivors: (s) => {
        terminated.push(s.map((x) => x.identity.pid))
        return terminate(s)
      },
    },
    ledger: { remove: (runId) => removed.push(runId) },
    notices: {
      add: (notice) => {
        const recorded = { ...notice, id: `notice-${next++}` }
        shown.push(recorded)
        return recorded
      },
      withdraw: (id) => withdrawn.push(id),
    },
    log: quietLog(),
  })
  return { recovery, removed, shown, withdrawn, terminated }
}

describe('crash recovery', () => {
  it('[spec:process-supervision/survivors-after-crash] shows survivors with name and command line and forgets runs with nothing alive, signalling nothing', async () => {
    const h = setup([survivor('a', 10), survivor('a', 11)])
    await h.recovery.check([entry('a'), entry('b')])
    expect(h.removed).toEqual(['b'])
    expect(h.terminated).toEqual([])
    expect(h.shown).toEqual([
      {
        id: 'notice-1',
        kind: 'crash-survivors',
        severity: 'warning',
        message: '2 processes started by Veydr in an earlier session are still running. Nothing was restarted.',
        files: [],
        processes: [
          { pid: 10, name: 'p10', commandLine: '/bin/p10 --serve' },
          { pid: 11, name: 'p11', commandLine: '/bin/p11 --serve' },
        ],
      },
    ])
  })

  it('shows nothing and forgets every run when nothing survived', async () => {
    const h = setup([])
    await h.recovery.check([entry('a')])
    expect(h.removed).toEqual(['a'])
    expect(h.shown).toEqual([])
    expect(await h.recovery.resolve('terminate')).toEqual([])
    expect(h.terminated).toEqual([])
  })

  it('does nothing for an empty ledger', async () => {
    const h = setup(new Error('must not be called'))
    await h.recovery.check([])
    expect(h.shown).toEqual([])
  })

  it('keeps the runs and reports a problem when the check fails', async () => {
    const h = setup(new Error('EMFILE'))
    await h.recovery.check([entry('a')])
    expect(h.removed).toEqual([])
    expect(h.shown).toMatchObject([{ kind: 'ledger-problem', message: expect.stringContaining('EMFILE') as unknown }])
  })

  it('terminates on request, forgets the runs, and withdraws the notice', async () => {
    const h = setup([survivor('a', 10)])
    await h.recovery.check([entry('a')])
    expect(await h.recovery.resolve('terminate')).toEqual([])
    expect(h.terminated).toEqual([[10]])
    expect(h.removed).toEqual(['a'])
    expect(h.withdrawn).toEqual(['notice-1'])
    expect(h.shown).toHaveLength(1)
    // Resolved: a repeated request does nothing.
    expect(await h.recovery.resolve('terminate')).toEqual([])
    expect(h.terminated).toHaveLength(1)
  })

  it('reports survivors that could not be terminated as a new notice and keeps their runs', async () => {
    const h = setup([survivor('a', 10), survivor('b', 20)], () =>
      Promise.resolve({ graceful: 'no', forced: true, survivors: [{ pid: 20, name: 'p20', commandLine: '/bin/p20 --serve' }] }),
    )
    await h.recovery.check([entry('a'), entry('b')])
    expect(await h.recovery.resolve('terminate')).toEqual([{ pid: 20, name: 'p20' }])
    expect(h.removed).toEqual(['a'])
    expect(h.withdrawn).toEqual(['notice-1'])
    expect(h.shown.at(-1)).toMatchObject({
      id: 'notice-2',
      kind: 'crash-survivors',
      message: '1 process from an earlier session could not be terminated.',
      processes: [{ pid: 20 }],
    })
    // The remaining one can be terminated again.
    await h.recovery.resolve('terminate')
    expect(h.terminated).toEqual([[10, 20], [20]])
  })

  it('treats every survivor as still running when terminating fails', async () => {
    const h = setup([survivor('a', 10)], () => Promise.reject(new Error('boot ID unreadable')))
    await h.recovery.check([entry('a')])
    expect(await h.recovery.resolve('terminate')).toEqual([{ pid: 10, name: 'p10' }])
    expect(h.removed).toEqual([])
  })

  it('leaves survivors running on dismiss and forgets them', async () => {
    const h = setup([survivor('a', 10)])
    await h.recovery.check([entry('a')])
    expect(await h.recovery.resolve('dismiss')).toEqual([])
    expect(h.terminated).toEqual([])
    expect(h.removed).toEqual(['a'])
    expect(h.withdrawn).toEqual(['notice-1'])
  })

  it('handles concurrent requests one at a time', async () => {
    let release: () => void = () => undefined
    const h = setup([survivor('a', 10)], () => new Promise((done) => (release = () => done({ graceful: 'yes', forced: false, survivors: [] }))))
    await h.recovery.check([entry('a')])
    const first = h.recovery.resolve('terminate')
    const second = h.recovery.resolve('dismiss')
    await new Promise((done) => setTimeout(done, 5))
    release()
    expect(await first).toEqual([])
    expect(await second).toEqual([])
    expect(h.terminated).toEqual([[10]])
    expect(h.removed).toEqual(['a'])
  })
})
