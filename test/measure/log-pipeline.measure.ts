import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLogService } from '../../src/main/logs/service'
import { createLinuxProcessTree } from '../../src/main/platform/linux/process-tree'
import { createLinuxCommandResolver } from '../../src/main/platform/linux/resolver'
import { withoutRuntimeVariables } from '../../src/main/platform/runtime-env'
import { createPlanner } from '../../src/main/supervisor/plan'
import { createProcessStateRegistry } from '../../src/main/supervisor/state'
import { createSupervisor, type LaunchTarget } from '../../src/main/supervisor/supervisor'
import type { ProcessStateEvent } from '../../src/shared/api'
import { MAX_UNACKED_BATCHES } from '../../src/shared/logs/limits'
import { command, project, quietLog } from '../unit/support/config'
import { fixture, scenario, TAG_VARIABLE, waitUntil, type Scenario } from '../support/proc'

// Capacity of the complete log pipeline (task 7.10, docs/logs.md "Throughput tolerance"): an
// unpaced producer writes 100-byte lines as fast as it can, read by the supervisor and processed
// by the real log service (splitting, redaction, retention, batching) with a window that never
// acknowledges. Compared with the same producer piped to `cat > /dev/null`. Recorded as a task
// note; nothing here asserts a threshold (the D14 thresholds are verified by `npm run test:perf`).

const BYTES = 256 * 1024 * 1024
const TRIALS = 3

const scenarios: Scenario[] = []
afterEach(() => {
  for (const s of scenarios.splice(0)) s.cleanup()
})

describe('log pipeline capacity (task 7.10)', () => {
  it(
    'measures how fast an unpaced producer gets 100-byte lines through Veydr',
    async () => {
      const s = scenario()
      scenarios.push(s)
      const report = join(s.dir, 'report.json')
      const throughput = (): number => {
        const { bytes, ms } = JSON.parse(readFileSync(report, 'utf8')) as { bytes: number; ms: number }
        expect(bytes).toBe(BYTES)
        return bytes / ms / 1000 // MB/s
      }

      let sent = 0
      const logs = createLogService({ delivery: { active: () => true, send: () => void sent++ } })
      const events: ProcessStateEvent[] = []
      const config = command({
        execution: { mode: 'direct', file: process.execPath, args: [fixture('flood'), '--bytes', String(BYTES), '--report', report] },
        env: [{ key: TAG_VARIABLE, value: s.tag, secret: false }, { key: 'TOKEN', value: 'not-in-output', secret: true }],
      })
      const target: LaunchTarget = { project: project({ path: s.dir, commands: [config] }), command: config }
      const supervisor = createSupervisor({
        processTree: createLinuxProcessTree(),
        states: createProcessStateRegistry((event) => events.push(event)),
        lookup: (id) => (id === config.id ? target : null),
        plan: createPlanner({
          resolver: createLinuxCommandResolver(),
          environment: { base: () => Promise.resolve({ env: withoutRuntimeVariables(process.env), warnings: [] }) },
          envNames: 'exact',
        }),
        output: logs,
        log: quietLog(),
      })

      const baseline: number[] = []
      const veydr: number[] = []
      for (let trial = 0; trial < TRIALS; trial++) {
        const shell = spawn('/bin/sh', ['-c', `"$0" "$1" --bytes ${BYTES} --report "$2" | cat > /dev/null`, process.execPath, fixture('flood'), report], { stdio: 'ignore' })
        await new Promise((done) => shell.once('exit', done))
        baseline.push(throughput())

        const exitedBefore = events.filter((e) => e.status === 'exited').length
        await supervisor.start(config.id)
        await waitUntil(() => events.filter((e) => e.status === 'exited').length > exitedBefore, 'flood exit', 120_000)
        veydr.push(throughput())
      }
      logs.dispose()

      const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0
      const result = {
        baselineMBps: Number(median(baseline).toFixed(1)),
        veydrMBps: Number(median(veydr).toFixed(1)),
        veydrLinesPerSecond: Math.round((median(veydr) * 1e6) / 100),
        ratio: Number((median(veydr) / median(baseline)).toFixed(3)),
        batchesSent: sent,
      }
      console.info(`[log-pipeline] ${JSON.stringify(result)}`)
      // The window never acknowledged: only the first batches were sent, everything else was skipped.
      expect(sent).toBe(MAX_UNACKED_BATCHES)
    },
    600_000,
  )
})
