import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createProcReader, type ProcReader } from '../../src/main/platform/linux/proc-reader'
import { createLinuxProcessTree } from '../../src/main/platform/linux/process-tree'
import type { SpawnPlan } from '../../src/main/platform/types'
import { fixture, REPETITIONS, scenario, startSentinel, taggedProcesses, treeSize, waitForLedger, type Scenario, type Sentinel } from '../support/proc'

// Signal safety with real processes and the real `kill` (task 4.7). Run under VEYDR_STRESS=1 for
// 50 repetitions. The sentinels are started by the test runner without `detached`, so they share
// the runner's process group and session: a wrong group signal would reach them.

let sentinel: Sentinel
beforeAll(async () => {
  sentinel = await startSentinel()
})
afterAll(() => {
  sentinel.stop()
})

const scenarios: Scenario[] = []
afterEach(() => {
  for (const s of scenarios.splice(0)) s.cleanup()
})

function track(): Scenario {
  const s = scenario()
  scenarios.push(s)
  return s
}

const plan = (s: Scenario, script: string, args: readonly string[]): SpawnPlan => ({
  file: process.execPath,
  args: [script, '--ledger', s.ledger, ...args],
  cwd: s.dir,
  env: s.env,
})

const timeout = (perRepetitionMs: number): number => 10_000 + REPETITIONS * perRepetitionMs

describe('signal safety', () => {
  it(
    '[spec:process-supervision/unrelated-process-untouched] never signals a process outside the started trees',
    async () => {
      const tree = createLinuxProcessTree({ scanIntervalMs: 100 })
      const shapes: readonly (readonly string[])[] = [
        ['--depth', '2', '--fanout', '2'],
        ['--depth', '1', '--fanout', '3', '--ignore-term'],
        ['--depth', '2', '--fanout', '2', '--setpgid', '--escape'],
      ]
      for (let i = 0; i < REPETITIONS; i++) {
        for (const shape of shapes) {
          const s = track()
          const run = await tree.spawn(plan(s, fixture('tree'), shape))
          await waitForLedger(s.ledger, treeSize(Number(shape[1]), Number(shape[3])))
          expect((await run.stop({ graceMs: 150 })).survivors).toEqual([])
          expect(taggedProcesses(s.tag)).toEqual([])
          expect(sentinel.alive(), `sentinel alive (repetition ${i})`).toBe(true)
          expect(sentinel.signals(), `sentinel signals (repetition ${i})`).toEqual([])
          s.cleanup()
        }
      }
    },
    timeout(3_000),
  )

  it(
    '[spec:process-supervision/pid-reused-by-unrelated-process] never signals a recorded PID whose start time no longer matches',
    async () => {
      for (let i = 0; i < REPETITIONS; i++) {
        const victim = await startSentinel()
        try {
          const s = track()
          // /proc scans report the unrelated victim as a descendant of the run with a stale start
          // time, as if the run's descendant had exited and the victim had received its PID.
          // Reads of the single process (done right before signalling) tell the truth.
          const real = createProcReader()
          let leaderPid = -1
          const lying: ProcReader = {
            ...real,
            scan: async () =>
              (await real.scan()).map((stat) =>
                stat.pid === victim.pid && leaderPid > 0 ? { ...stat, ppid: leaderPid, starttime: Number.MAX_SAFE_INTEGER } : stat,
              ),
          }
          const tree = createLinuxProcessTree({ proc: lying, killWaitMs: 200, scanIntervalMs: 50 })
          const run = await tree.spawn(plan(s, fixture('tree'), ['--depth', '1', '--fanout', '2']))
          leaderPid = run.pid
          await waitForLedger(s.ledger, treeSize(1, 2))
          const result = await run.stop({ graceMs: 100 })

          expect(victim.alive(), `victim alive (repetition ${i})`).toBe(true)
          expect(victim.signals(), `victim signals (repetition ${i})`).toEqual([])
          // The real tree is gone; the unverifiable record is reported, not claimed stopped.
          expect(taggedProcesses(s.tag)).toEqual([])
          expect(result.survivors.map((p) => p.pid)).toEqual([victim.pid])
          s.cleanup()
        } finally {
          victim.stop()
        }
      }
      expect(sentinel.alive()).toBe(true)
      expect(sentinel.signals()).toEqual([])
    },
    timeout(2_000),
  )
})
