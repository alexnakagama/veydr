import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { VeydrApi } from '../../src/shared/api'
import type { Config } from '../../src/shared/config'
import { fixture, killTagged, TAG_VARIABLE } from '../support/proc'
import { expect, expectNoOutboundConnections, launchVeydr, test, type VeydrApp } from '../e2e/support/fixtures'
import { seed } from '../e2e/support/seed'

// Performance scenarios P1–P4 (design D14, task 7.7), measured in the real application with the
// services in the main process. The thresholds below are those of design D14, fixed here before the
// first run; they are never relaxed to make a run pass (task 7.8: a failure goes to gate G-2).

const MB = 1_000_000

/** Design D14 thresholds. "MB" is read as 10^6 bytes (the stricter reading). */
const THRESHOLDS = {
  /** Main event-loop delay, 99th percentile over the flood. */
  loopDelayP99Ms: 50,
  /** Renderer → main → renderer round trip of a trivial operation (`app.getInfo`), 95th percentile. */
  ipcPingP95Ms: 50,
  heapMaxBytes: { P1: 150 * MB, P2: 200 * MB },
  /** Main heap growth per 10 s over the last 30 s of the flood. */
  heapGrowthPer10sBytes: 1 * MB,
  /** Longest renderer long task during the flood. */
  longTaskMaxMs: 200,
  /** Lines a producer gets out under Veydr ÷ lines it gets out into `| cat > /dev/null`, same time. */
  throughputRatio: 0.8,
  /** P4: keystroke in the output filter → the filtered view rendered, 95th percentile. */
  keystrokeP95Ms: 100,
} as const

/*
 * Methods (fixed with the thresholds):
 * - The flooded command is selected, so its output view is shown and follows the output.
 * - Event-loop delay and heap come from a probe preloaded into main (`support/main-probe.cjs`):
 *   `monitorEventLoopDelay` at 10 ms resolution, and `heapUsed` sampled every 100 ms.
 * - Heap growth: the last 30 s of samples are split into six 5 s windows; the minimum of each
 *   window (the heap after garbage collection) is fitted with least squares; growth = slope × 10 s.
 * - IPC ping: the window calls `app.getInfo` every 100 ms and measures the round trip.
 * - Long tasks: a `longtask` PerformanceObserver in the window.
 * - Throughput: `lines.mjs` paces its output (lines per second) and blocks on a full pipe, so
 *   lines written in the fixed duration measure how much a reader let through. The baseline is
 *   the same producer (or producers, for P2) piped to `cat > /dev/null`.
 */

const PROBE = resolve(__dirname, 'support/main-probe.cjs')
const PROJECT_ID = '7a2e9b5d-4d2f-4f66-8b8c-1e7e2a3c0b12'
const LINE_BYTES = 100
const commandId = (n: number): string => `6f1f8a4c-3c1e-4e55-9a7b-${String(n).padStart(12, '0')}`

interface Producer {
  readonly rate: number
  readonly seconds: number
}

interface MainProbe {
  readonly loopDelayP99Ms: number
  readonly loopDelayMaxMs: number
  readonly loopDelayMeanMs: number
  readonly heap: readonly { readonly t: number; readonly heap: number }[]
}

interface WindowProbe {
  readonly pings: readonly number[]
  readonly longTasks: readonly number[]
}

const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN
}

/** Least-squares slope of the 5 s window minima over the last 30 s, as bytes per 10 s. */
function heapGrowthPer10s(samples: MainProbe['heap']): number {
  const end = samples.at(-1)?.t ?? 0
  const points: [number, number][] = []
  for (let w = 0; w < 6; w++) {
    const from = end - 30_000 + w * 5_000
    const window = samples.filter((s) => s.t >= from && s.t < from + 5_000)
    if (window.length === 0) continue
    const min = window.reduce((a, b) => (b.heap < a.heap ? b : a))
    points.push([min.t, min.heap])
  }
  const n = points.length
  const mx = points.reduce((a, [x]) => a + x, 0) / n
  const my = points.reduce((a, [, y]) => a + y, 0) / n
  const slope = points.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0) / points.reduce((a, [x]) => a + (x - mx) ** 2, 0)
  return slope * 10_000
}

/** Runs `count` producers piped to `cat > /dev/null` at once; returns the lines each wrote. */
async function baseline(dir: string, producer: Producer, count: number): Promise<number[]> {
  const reports = Array.from({ length: count }, (_, i) => join(dir, `baseline-${i}.json`))
  await Promise.all(
    reports.map(
      (report) =>
        new Promise<void>((done, fail) => {
          const shell = spawn(
            '/bin/sh',
            ['-c', `"$0" "$1" --rate ${producer.rate} --seconds ${producer.seconds} --line-bytes ${LINE_BYTES} --report "$2" | cat > /dev/null`, process.execPath, fixture('lines'), report],
            { stdio: 'ignore' },
          )
          shell.once('error', fail)
          shell.once('exit', () => done())
        }),
    ),
  )
  return reports.map((report) => (JSON.parse(readFileSync(report, 'utf8')) as { lines: number }).lines)
}

interface Session {
  readonly veydr: VeydrApp
  readonly window: Page
  readonly dir: string
  readonly reports: readonly string[]
  readonly tag: string
}

/** Launches Veydr (with the main probe) configured with `count` producer commands. */
async function withSession(producer: Producer, count: number, run: (s: Session) => Promise<void>): Promise<void> {
  const tag = crypto.randomUUID()
  const dir = mkdtempSync(join(tmpdir(), 'veydr-perf-'))
  const reports = Array.from({ length: count }, (_, i) => join(dir, `veydr-${i}.json`))
  const config: Config = {
    schemaVersion: 1,
    projects: [
      {
        id: PROJECT_ID,
        name: 'perf',
        path: dir,
        commands: reports.map((report, i) => ({
          id: commandId(i + 1),
          name: `producer-${i + 1}`,
          execution: {
            mode: 'direct' as const,
            file: process.execPath,
            args: [fixture('lines'), '--rate', String(producer.rate), '--seconds', String(producer.seconds), '--line-bytes', String(LINE_BYTES), '--report', report],
          },
          cwd: '.',
          env: [{ key: TAG_VARIABLE, value: tag, secret: false }],
          stopTimeoutMs: 2000,
        })),
      },
    ],
    settings: { editor: null },
  }
  const seeded = seed({ 'config.json': JSON.stringify(config) })
  const veydr = await launchVeydr({ configHome: seeded.configHome, preloads: [PROBE] })
  try {
    await run({ veydr, window: veydr.window, dir, reports, tag })
    expectNoOutboundConnections(await veydr.close())
  } finally {
    await veydr.app.close().catch(() => undefined)
    killTagged(tag)
    rmSync(veydr.workDir, { recursive: true, force: true })
    rmSync(seeded.root, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Starts the window-side probes: IPC ping every 100 ms and the long-task observer. */
async function startWindowProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (globalThis as unknown as { veydr: VeydrApi }).veydr
    const probe = { pings: [] as number[], longTasks: [] as number[], stop: false }
    ;(globalThis as unknown as { __perf: typeof probe }).__perf = probe
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) probe.longTasks.push(entry.duration)
    }).observe({ type: 'longtask' })
    const ping = async (): Promise<void> => {
      while (!probe.stop) {
        const started = performance.now()
        await api.app.getInfo()
        probe.pings.push(performance.now() - started)
        await new Promise((done) => setTimeout(done, 100))
      }
    }
    void ping()
  })
  // Calibration: the observer must see a deliberate 80 ms task, or a result of "no long tasks"
  // would mean nothing. It runs as a page task (`setTimeout`): work done directly by
  // `page.evaluate` is not reported as a long task. The entry is removed before measuring.
  await page.evaluate(() => {
    setTimeout(() => {
      const until = performance.now() + 80
      while (performance.now() < until) {
        // busy
      }
    }, 0)
  })
  await expect
    .poll(() => page.evaluate(() => (globalThis as unknown as { __perf: { longTasks: number[] } }).__perf.longTasks.length), { message: 'the long-task observer works' })
    .toBeGreaterThan(0)
  await page.evaluate(() => {
    ;(globalThis as unknown as { __perf: { longTasks: number[] } }).__perf.longTasks.length = 0
  })
}

async function stopWindowProbe(page: Page): Promise<WindowProbe> {
  return page.evaluate(() => {
    const probe = (globalThis as unknown as { __perf: { pings: number[]; longTasks: number[]; stop: boolean } }).__perf
    probe.stop = true
    return { pings: probe.pings, longTasks: probe.longTasks }
  })
}

const startMainProbe = (veydr: VeydrApp): Promise<void> => veydr.app.evaluate(() => (globalThis as unknown as { __veydrPerf: { start(): void } }).__veydrPerf.start())
const stopMainProbe = (veydr: VeydrApp): Promise<MainProbe> => veydr.app.evaluate(() => (globalThis as unknown as { __veydrPerf: { stop(): MainProbe } }).__veydrPerf.stop())

async function startCommand(window: Page, n: number): Promise<void> {
  const row = window.locator(`[data-command-id="${commandId(n)}"]`)
  await row.getByRole('button', { name: `Start producer-${n}`, exact: true }).click()
  await expect(row.getByTestId('command-status')).toHaveText('Running')
}

async function waitExited(window: Page, count: number, timeout: number): Promise<void> {
  for (let n = 1; n <= count; n++) await expect(window.locator(`[data-command-id="${commandId(n)}"]`).getByTestId('command-status')).toHaveText('Exited', { timeout })
}

/** Writes measured values next to the test results (recorded as task notes). */
function record(name: string, values: Record<string, unknown>): void {
  mkdirSync('test-results', { recursive: true })
  writeFileSync(join('test-results', `perf-${name}.json`), JSON.stringify(values, null, 2))
  console.info(`[perf ${name}] ${JSON.stringify(values)}`)
}

async function floodScenario(name: 'P1' | 'P2', producer: Producer, count: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'veydr-perf-baseline-'))
  let base: number[]
  try {
    base = await baseline(dir, producer, count)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  await withSession(producer, count, async ({ veydr, window, reports }) => {
    await window.locator(`[data-command-id="${commandId(1)}"] .command-name`).click()
    await startWindowProbe(window)
    await startMainProbe(veydr)
    for (let n = 1; n <= count; n++) await startCommand(window, n)
    await waitExited(window, count, (producer.seconds + 30) * 1000)
    const main = await stopMainProbe(veydr)
    const view = await stopWindowProbe(window)
    const produced = reports.map((report) => (JSON.parse(readFileSync(report, 'utf8')) as { lines: number }).lines)
    const ratios = produced.map((lines, i) => lines / (base[i] ?? Number.NaN))

    const measured = {
      loopDelayP99Ms: main.loopDelayP99Ms,
      loopDelayMaxMs: main.loopDelayMaxMs,
      ipcPingP95Ms: percentile(view.pings, 95),
      ipcPings: view.pings.length,
      heapMaxBytes: Math.max(...main.heap.map((s) => s.heap)),
      heapGrowthPer10sBytes: heapGrowthPer10s(main.heap),
      longTaskMaxMs: Math.max(0, ...view.longTasks),
      longTasks: view.longTasks.length,
      baselineLines: base,
      veydrLines: produced,
      throughputRatioMin: Math.min(...ratios),
    }
    record(name, measured)

    expect(view.pings.length, 'pings were measured').toBeGreaterThan(producer.seconds * 5)
    expect(main.heap.length, 'heap was sampled').toBeGreaterThan(producer.seconds * 5)
    expect(measured.loopDelayP99Ms).toBeLessThanOrEqual(THRESHOLDS.loopDelayP99Ms)
    expect(measured.ipcPingP95Ms).toBeLessThanOrEqual(THRESHOLDS.ipcPingP95Ms)
    expect(measured.heapMaxBytes).toBeLessThanOrEqual(THRESHOLDS.heapMaxBytes[name])
    expect(measured.heapGrowthPer10sBytes).toBeLessThan(THRESHOLDS.heapGrowthPer10sBytes)
    expect(measured.longTaskMaxMs).toBeLessThanOrEqual(THRESHOLDS.longTaskMaxMs)
    expect(measured.throughputRatioMin).toBeGreaterThanOrEqual(THRESHOLDS.throughputRatio)
  })
}

test('P1 [spec:process-logs/memory-stays-bounded-under-flood] [spec:process-supervision/high-volume-output]: one producer, 50,000 lines/s × 100 B for 60 s', async () => {
  test.setTimeout(300_000)
  await floodScenario('P1', { rate: 50_000, seconds: 60 }, 1)
})

test('P2: ten producers, 5,000 lines/s each for 60 s', async () => {
  test.setTimeout(300_000)
  await floodScenario('P2', { rate: 5_000, seconds: 60 }, 10)
})

test('P3 [spec:process-logs/slow-view]: with the window blocked for 2 s mid-stream, delivered + declared skipped = produced, exactly', async () => {
  test.setTimeout(180_000)
  const producer = { rate: 50_000, seconds: 20 }
  await withSession(producer, 1, async ({ window, reports }) => {
    await window.locator(`[data-command-id="${commandId(1)}"] .command-name`).click()
    // An extra listener counts every batch the window receives (the application's own store acknowledges them).
    await window.evaluate(() => {
      const count = { lines: [] as number[], ranges: [] as [number, number][] }
      ;(globalThis as unknown as { __count: typeof count }).__count = count
      ;(globalThis as unknown as { veydr: VeydrApi }).veydr.logs.onBatch((batch) => {
        for (const line of batch.lines) count.lines.push(line.seq)
        if (batch.skipped !== null) count.ranges.push([batch.skipped.fromSeq, batch.skipped.toSeq])
      })
    })
    await startCommand(window, 1)
    await window.waitForTimeout(8_000)
    await window.evaluate(() => {
      const until = Date.now() + 2_000
      while (Date.now() < until) {
        // blocked
      }
    })
    await waitExited(window, 1, 60_000)
    const produced = (JSON.parse(readFileSync(reports[0] ?? '', 'utf8')) as { lines: number }).lines
    // The last batch is sent at most 50 ms after the stream ended; give it time to arrive.
    await expect.poll(() => window.evaluate(() => (globalThis as unknown as { __count: { lines: number[] } }).__count.lines.at(-1)), { timeout: 10_000 }).toBe(produced)
    const result = await window.evaluate((total) => {
      const { lines, ranges } = (globalThis as unknown as { __count: { lines: number[]; ranges: [number, number][] } }).__count
      const seen = new Uint8Array(total + 2)
      let duplicates = 0
      let outside = 0
      const mark = (seq: number): void => {
        if (seq < 1 || seq > total) outside++
        else if (seen[seq] === 1) duplicates++
        else seen[seq] = 1
      }
      for (const seq of lines) mark(seq)
      let skipped = 0
      for (const [from, to] of ranges) {
        skipped += to - from + 1
        for (let seq = from; seq <= to; seq++) mark(seq)
      }
      let missing = 0
      for (let seq = 1; seq <= total; seq++) if (seen[seq] !== 1) missing++
      return { delivered: lines.length, skipped, ranges: ranges.length, duplicates, outside, missing }
    }, produced)
    record('P3', { produced, ...result })
    expect(result.skipped, 'the blocked window made Veydr skip lines').toBeGreaterThan(0)
    expect(result).toMatchObject({ duplicates: 0, outside: 0, missing: 0 })
    expect(result.delivered + result.skipped).toBe(produced)
  })
})

test('P4 [spec:process-logs/interaction-during-flood]: typing in the output filter during a P1 flood', async () => {
  test.setTimeout(180_000)
  const producer = { rate: 50_000, seconds: 40 }
  await withSession(producer, 1, async ({ window }) => {
    await window.locator(`[data-command-id="${commandId(1)}"] .command-name`).click()
    await startCommand(window, 1)
    await window.waitForTimeout(10_000)
    const filter = window.getByLabel('Filter output', { exact: true })
    await window.evaluate(() => {
      const probe = { pending: [] as { value: string; t: number }[], latencies: [] as number[], measuring: false }
      ;(globalThis as unknown as { __p4: typeof probe }).__p4 = probe
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Filter output"]')
      const list = document.querySelector<HTMLElement>('[data-testid="log-scroll"]')
      if (input === null || list === null) throw new Error('log view missing')
      let keydownAt = 0
      input.addEventListener('keydown', (event) => (keydownAt = event.timeStamp), true)
      input.addEventListener('input', () => {
        if (probe.measuring) probe.pending.push({ value: input.value, t: keydownAt })
      })
      // A keystroke counts as rendered once the list shows a filter that includes it, at the next frame.
      new MutationObserver(() => {
        const applied = list.dataset['appliedFilter'] ?? ''
        requestAnimationFrame(() => {
          const now = performance.now()
          probe.pending = probe.pending.filter((p) => {
            if (!applied.startsWith(p.value)) return true
            probe.latencies.push(now - p.t)
            return false
          })
        })
      }).observe(list, { attributes: true, attributeFilter: ['data-applied-filter'] })
    })
    // Every retained line contains "x" and starts with "000" (fewer than a million lines), so
    // each filter keeps the whole list: the most work per keystroke.
    const measuring = (on: boolean): Promise<void> =>
      window.evaluate((value) => {
        const probe = (globalThis as unknown as { __p4: { measuring: boolean; pending: unknown[] } }).__p4
        probe.measuring = value
        if (!value) probe.pending = []
      }, on)
    for (const text of ['xxxx', '00000', 'xxxxx', '0000']) {
      await measuring(true)
      await filter.pressSequentially(text, { delay: 100 })
      await window.waitForTimeout(500)
      await measuring(false)
      await filter.fill('')
      await window.waitForTimeout(300)
    }
    const { latencies } = await window.evaluate(() => (globalThis as unknown as { __p4: { latencies: number[] } }).__p4)
    const measured = { keystrokes: latencies.length, keystrokeP95Ms: percentile(latencies, 95), keystrokeMaxMs: Math.max(...latencies) }
    record('P4', measured)
    // Every typed character was rendered (18 keystrokes).
    expect(latencies.length).toBe(18)
    expect(measured.keystrokeP95Ms).toBeLessThanOrEqual(THRESHOLDS.keystrokeP95Ms)
  })
})
