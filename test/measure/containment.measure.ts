import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { release } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createLinuxProcessTree, SCAN_INTERVAL_MS } from '../../src/main/platform/linux/process-tree'
import { fixture, isAlive, scenario, taggedProcesses, waitForLedger, waitUntil, type Scenario } from '../support/proc'

// Measurements for task 4.9 and gate G-3 (`npm run measure`). Not part of `verify`: the numbers
// are recorded in tasks.md, and nothing here asserts a threshold. systemd is only exercised from
// this harness; no product code uses it (adopting it needs gate G-3 approval).

const TRIALS = Number(process.env['VEYDR_MEASURE_TRIALS'] ?? '50')

const scenarios: Scenario[] = []
afterEach(() => {
  for (const s of scenarios.splice(0)) s.cleanup()
})

function track(): Scenario {
  const s = scenario()
  scenarios.push(s)
  return s
}

const cgroupOf = (pid: number): string | null => {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim()
  } catch {
    return null
  }
}

const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN
}

const summary = (values: readonly number[]) => ({
  p50: Number(percentile(values, 50).toFixed(2)),
  p95: Number(percentile(values, 95).toFixed(2)),
  max: Number(Math.max(...values).toFixed(2)),
})

/** Milliseconds from spawn until the process has exited. */
async function spawnToExit(file: string, args: readonly string[]): Promise<number> {
  const started = performance.now()
  const child: ChildProcess = spawn(file, args, { stdio: 'ignore', detached: true })
  const code = await new Promise<number | null>((done) => child.once('exit', done))
  if (code !== 0) throw new Error(`${file} exited with ${code}`)
  return performance.now() - started
}

describe('containment measurements (task 4.9, gate G-3)', () => {
  it(
    'measures the unobserved-escape rate of the process-group strategy',
    async () => {
      const tree = createLinuxProcessTree()
      let escaped = 0
      for (let trial = 0; trial < TRIALS; trial++) {
        const s = track()
        // The middle process exits 0–50 ms after its child called setsid.
        const middleExitMs = Math.round((trial * 50) / Math.max(1, TRIALS - 1))
        const run = await tree.spawn({
          file: process.execPath,
          args: [fixture('escape'), '--ledger', s.ledger, '--middle-exit-ms', String(middleExitMs)],
          cwd: s.dir,
          env: s.env,
        })
        const entries = await waitForLedger(s.ledger, 3)
        const middle = entries.find((e) => e.role === 'middle')
        const escapee = entries.find((e) => e.role === 'escapee')
        if (middle === undefined || escapee === undefined) throw new Error('fixture incomplete')
        await waitUntil(() => !isAlive(middle.pid, middle.starttime), 'middle exit')
        await run.stop({ graceMs: 1_000 })
        if (isAlive(escapee.pid, escapee.starttime)) escaped++
        s.cleanup()
      }
      const result = { strategy: 'process group + session + observed descendants', scanIntervalMs: SCAN_INTERVAL_MS, trials: TRIALS, escaped, rate: escaped / TRIALS }
      console.info(`[measure] unobserved escape ${JSON.stringify(result)}`)
      expect(escaped).toBeLessThanOrEqual(TRIALS)
    },
    600_000,
  )

  it(
    'evaluates systemd-run --user --scope: containment of the same escape and spawn latency',
    async () => {
      const version = spawnSync('systemd-run', ['--version'], { encoding: 'utf8' })
      const userManager = spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' })
      if (version.status !== 0) {
        console.info('[measure] systemd-run unavailable on this machine')
        return
      }

      let contained = 0
      let cleaned = 0
      for (let trial = 0; trial < TRIALS; trial++) {
        const s = track()
        const unit = `veydr-measure-${randomUUID()}.scope`
        const middleExitMs = Math.round((trial * 50) / Math.max(1, TRIALS - 1))
        spawn(
          'systemd-run',
          ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, '--', process.execPath, fixture('escape'), '--ledger', s.ledger, '--middle-exit-ms', String(middleExitMs)],
          { env: s.env, stdio: 'ignore', detached: true },
        )
        const entries = await waitForLedger(s.ledger, 3)
        const leader = entries.find((e) => e.role === 'leader')
        const escapee = entries.find((e) => e.role === 'escapee')
        if (leader === undefined || escapee === undefined) throw new Error('fixture incomplete')
        // Contained: the escapee is still in the scope's cgroup, so stopping the unit reaches it.
        if (cgroupOf(escapee.pid) !== null && cgroupOf(escapee.pid) === cgroupOf(leader.pid)) contained++
        spawnSync('systemctl', ['--user', 'stop', unit])
        await waitUntil(() => taggedProcesses(s.tag).length === 0, 'scope stopped', 5_000).then(
          () => cleaned++,
          () => undefined,
        )
        s.cleanup()
      }

      const plain: number[] = []
      const scoped: number[] = []
      const veydrTree: number[] = []
      const tree = createLinuxProcessTree()
      for (let trial = 0; trial < TRIALS; trial++) {
        plain.push(await spawnToExit('/bin/true', []))
        scoped.push(await spawnToExit('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--', '/bin/true']))
        const started = performance.now()
        const run = await tree.spawn({ file: '/bin/true', args: [], cwd: '/', env: {} })
        await new Promise((done) => run.onExit(done))
        veydrTree.push(performance.now() - started)
      }

      const result = {
        systemd: version.stdout.split('\n')[0],
        userManager: userManager.stdout.trim(),
        kernel: release(),
        trials: TRIALS,
        escapeContained: contained,
        escapeContainedRate: contained / TRIALS,
        stopUnitCleanedAll: cleaned,
        spawnToExitMs: { plainSpawn: summary(plain), veydrLinuxTree: summary(veydrTree), systemdRunScope: summary(scoped) },
      }
      console.info(`[measure] systemd scope ${JSON.stringify(result)}`)
      expect(contained).toBeLessThanOrEqual(TRIALS)
    },
    600_000,
  )
})
