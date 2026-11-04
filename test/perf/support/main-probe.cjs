'use strict'
// Test-only probe loaded into Veydr's main process with `-r` by the performance scenarios
// (design D14). It is never part of a build. `globalThis.__veydrPerf` is read and controlled by
// the tests through Playwright's `electronApp.evaluate`.
//
// - Event-loop delay: `perf_hooks.monitorEventLoopDelay` (10 ms resolution).
// - Heap: `process.memoryUsage().heapUsed`, sampled every 100 ms, and read again after each major
//   (mark-compact) garbage collection, which is the heap still in use: the growth measurement.
const { constants, monitorEventLoopDelay, PerformanceObserver } = require('node:perf_hooks')

const histogram = monitorEventLoopDelay({ resolution: 10 })
const samples = []
const afterMajorGc = []
let timer = null
// Entries arrive shortly after the collection, so the heap is read then: at most what JavaScript
// allocated in between is added, never garbage the collection left.
const gcObserver = new PerformanceObserver((list) => {
  if (list.getEntries().some((entry) => entry.detail?.kind === constants.NODE_PERFORMANCE_GC_MAJOR)) {
    afterMajorGc.push({ t: performance.now(), heap: process.memoryUsage().heapUsed })
  }
})

globalThis.__veydrPerf = {
  start() {
    histogram.reset()
    histogram.enable()
    samples.length = 0
    afterMajorGc.length = 0
    gcObserver.observe({ entryTypes: ['gc'] })
    if (timer !== null) clearInterval(timer)
    timer = setInterval(() => samples.push({ t: performance.now(), heap: process.memoryUsage().heapUsed }), 100)
  },
  stop() {
    histogram.disable()
    gcObserver.disconnect()
    if (timer !== null) clearInterval(timer)
    timer = null
    return {
      loopDelayP99Ms: histogram.percentile(99) / 1e6,
      loopDelayMaxMs: histogram.max / 1e6,
      loopDelayMeanMs: histogram.mean / 1e6,
      heap: samples.slice(),
      heapAfterMajorGc: afterMajorGc.slice(),
    }
  },
}
