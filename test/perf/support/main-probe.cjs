'use strict'
// Test-only probe loaded into Veydr's main process with `-r` by the performance scenarios
// (design D14). It is never part of a build. `globalThis.__veydrPerf` is read and controlled by
// the tests through Playwright's `electronApp.evaluate`.
//
// - Event-loop delay: `perf_hooks.monitorEventLoopDelay` (10 ms resolution).
// - Heap: `process.memoryUsage().heapUsed`, sampled every 100 ms.
const { monitorEventLoopDelay } = require('node:perf_hooks')

const histogram = monitorEventLoopDelay({ resolution: 10 })
const samples = []
let timer = null

globalThis.__veydrPerf = {
  start() {
    histogram.reset()
    histogram.enable()
    samples.length = 0
    if (timer !== null) clearInterval(timer)
    timer = setInterval(() => samples.push({ t: performance.now(), heap: process.memoryUsage().heapUsed }), 100)
  },
  stop() {
    histogram.disable()
    if (timer !== null) clearInterval(timer)
    timer = null
    return {
      loopDelayP99Ms: histogram.percentile(99) / 1e6,
      loopDelayMaxMs: histogram.max / 1e6,
      loopDelayMeanMs: histogram.mean / 1e6,
      heap: samples.slice(),
    }
  },
}
