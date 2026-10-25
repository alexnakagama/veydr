import { describe, expect, it } from 'vitest'
import { createLogStore, DEFAULT_RETENTION, RunBuffer } from '../../src/main/logs/buffer'
import { GLOBAL_MAX_BYTES, RUN_MAX_BYTES, RUN_MAX_LINES } from '../../src/shared/logs/limits'

const ids = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function fill(buffer: RunBuffer, count: number, bytes = 1): void {
  for (let i = 0; i < count; i++) buffer.append('stdout', i, 'x'.repeat(bytes), false, bytes)
}

describe('run buffer', () => {
  it('uses the documented default limits', () => {
    expect(DEFAULT_RETENTION).toEqual({ runMaxLines: RUN_MAX_LINES, runMaxBytes: RUN_MAX_BYTES, totalMaxBytes: GLOBAL_MAX_BYTES })
    expect([RUN_MAX_LINES, RUN_MAX_BYTES, GLOBAL_MAX_BYTES]).toEqual([10_000, 8 * 1024 * 1024, 64 * 1024 * 1024])
  })

  it('numbers lines consecutively across both streams and reads them back by seq', () => {
    const b = new RunBuffer('c', ids(1), 10, 1000)
    b.append('stdout', 1, 'a', false, 1)
    b.append('stderr', 2, 'b', false, 1)
    b.append('stdout', 3, 'c', true, 1)
    expect(b.read(1, 10)).toEqual([
      { seq: 1, stream: 'stdout', at: 1, text: 'a', truncated: false },
      { seq: 2, stream: 'stderr', at: 2, text: 'b', truncated: false },
      { seq: 3, stream: 'stdout', at: 3, text: 'c', truncated: true },
    ])
    expect(b.read(2, 1).map((l) => l.seq)).toEqual([2])
    expect(b.read(4, 10)).toEqual([])
    expect([b.firstSeq, b.nextSeq, b.length, b.bytes, b.discarded]).toEqual([1, 4, 3, 3, 0])
  })

  it('[spec:process-logs/retention-limit-reached] keeps only the newest lines within the line limit and counts the discarded ones', () => {
    const b = new RunBuffer('c', ids(1), 5, 1000)
    fill(b, 12)
    expect(b.read(1, 100).map((l) => l.seq)).toEqual([8, 9, 10, 11, 12])
    expect([b.firstSeq, b.nextSeq, b.length, b.discarded]).toEqual([8, 13, 5, 7])
  })

  it('keeps only the newest lines within the byte limit', () => {
    const b = new RunBuffer('c', ids(1), 100, 10)
    fill(b, 3, 4) // 12 bytes > 10: the first line goes
    expect(b.read(1, 100).map((l) => l.seq)).toEqual([2, 3])
    expect(b.bytes).toBe(8)
    b.append('stdout', 0, '', false, 0)
    b.append('stdout', 0, 'xxxxxxxxxx', false, 10)
    // An empty line costs no bytes, so it stays (the line limit still bounds such lines).
    expect(b.read(1, 100).map((l) => l.seq)).toEqual([4, 5])
    expect([b.bytes, b.discarded]).toEqual([10, 3])
  })

  it('[spec:process-logs/clear] clears retained lines; capture continues with the next seq', () => {
    const b = new RunBuffer('c', ids(1), 5, 1000)
    fill(b, 7)
    expect(b.clear()).toEqual({ clearedThroughSeq: 7, freed: 5 })
    expect([b.firstSeq, b.nextSeq, b.length, b.bytes, b.discarded]).toEqual([null, 8, 0, 0, 0])
    b.append('stdout', 0, 'y', false, 1)
    expect(b.read(1, 10).map((l) => l.seq)).toEqual([8])
    expect(new RunBuffer('c', ids(2), 5, 5).clear()).toEqual({ clearedThroughSeq: 0, freed: 0 })
  })
})

describe('log store', () => {
  it('keeps the current and the previous run of a command only', () => {
    const store = createLogStore({ runMaxLines: 10, runMaxBytes: 100, totalMaxBytes: 1000 })
    const first = store.open('c', ids(1))
    store.append(first, 'stdout', 0, 'one', false, 3)
    const second = store.open('c', ids(2))
    expect(store.get(ids(1))).toBe(first)
    const third = store.open('c', ids(3))
    expect(store.get(ids(1))).toBeUndefined()
    expect([store.get(ids(2)), store.get(ids(3))]).toEqual([second, third])
    expect(store.totalBytes()).toBe(0)
    // Late output of a run that is no longer retained is not kept.
    expect(store.append(first, 'stdout', 0, 'late', false, 4)).toBeNull()
    expect(store.totalBytes()).toBe(0)
    // Opening a run twice returns it.
    expect(store.open('c', ids(3))).toBe(third)
  })

  it('[spec:process-logs/memory-stays-bounded-under-flood] evicts the oldest lines of previous runs first, largest previous run first, then of the largest current run', () => {
    const store = createLogStore({ runMaxLines: 100, runMaxBytes: 100, totalMaxBytes: 50 })
    const aOld = store.open('a', ids(1))
    for (let i = 0; i < 10; i++) store.append(aOld, 'stdout', 0, 'xx', false, 2) // 20 bytes
    const bOld = store.open('b', ids(2))
    for (let i = 0; i < 10; i++) store.append(bOld, 'stdout', 0, 'xxx', false, 3) // 30 bytes → total 50
    const aNew = store.open('a', ids(3))
    const bNew = store.open('b', ids(4))
    expect(store.totalBytes()).toBe(50)

    // Over the total: previous runs lose their oldest lines, the largest (b's) first.
    store.append(aNew, 'stdout', 0, 'xxxx', false, 4)
    expect([bOld.firstSeq, bOld.bytes, aOld.length]).toEqual([3, 24, 10])
    for (let i = 0; i < 12; i++) store.append(bNew, 'stdout', 0, 'xxxx', false, 4)
    expect(aOld.length + bOld.length).toBe(0)
    // Then the largest current run (b's) gives up its oldest lines.
    expect(store.totalBytes()).toBeLessThanOrEqual(50)
    expect(aNew.length).toBe(1)
    expect(bNew.firstSeq).toBeGreaterThan(1)
    expect(bNew.discarded).toBeGreaterThan(0)
    expect(store.totalBytes()).toBe(aNew.bytes + bNew.bytes)
  })

  it('stays within the total limit over a long flood of many runs', () => {
    const limits = { runMaxLines: 50, runMaxBytes: 400, totalMaxBytes: 1000 }
    const store = createLogStore(limits)
    let peak = 0
    for (let run = 1; run <= 40; run++) {
      const buffer = store.open(`cmd-${run % 7}`, ids(run))
      for (let i = 0; i < 200; i++) {
        store.append(buffer, i % 2 === 0 ? 'stdout' : 'stderr', i, 'y'.repeat(i % 9), false, i % 9)
        peak = Math.max(peak, store.totalBytes())
      }
    }
    expect(peak).toBeLessThanOrEqual(limits.totalMaxBytes)
  })

  it('subtracts a cleared run from the total', () => {
    const store = createLogStore({ runMaxLines: 10, runMaxBytes: 100, totalMaxBytes: 1000 })
    const run = store.open('c', ids(1))
    store.append(run, 'stdout', 0, 'abc', false, 3)
    expect(store.clear(run)).toBe(1)
    expect(store.totalBytes()).toBe(0)
  })

  it('stays within the default 64 MiB total under a flood of maximum-length lines from ten commands (L6-08)', () => {
    const store = createLogStore()
    const line = 'z'.repeat(16 * 1024)
    let peak = 0
    const started = performance.now()
    // Two runs per command (current and previous) of ten commands: 160 MiB offered in total.
    for (let run = 1; run <= 20; run++) {
      const buffer = store.open(`cmd-${run % 10}`, ids(run))
      for (let i = 0; i < 512; i++) {
        store.append(buffer, 'stdout', i, line, false, line.length)
        peak = Math.max(peak, store.totalBytes())
      }
    }
    expect(peak).toBeLessThanOrEqual(GLOBAL_MAX_BYTES)
    expect(store.totalBytes()).toBe(GLOBAL_MAX_BYTES)
    console.info(`[retention] 10,240 appends at the 64 MiB limit in ${(performance.now() - started).toFixed(0)} ms`)
  })
})
