import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBatcher, type BatcherLimits } from '../../src/main/logs/batcher'
import { logBatchSchema, type LogBatch, type LogLine } from '../../src/shared/api'
import { BATCH_INTERVAL_MS, BATCH_MAX_BYTES, BATCH_MAX_LINES, MAX_UNACKED_BATCHES } from '../../src/shared/logs/limits'

const COMMAND = '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01'
const RUN_A = '00000000-0000-4000-8000-00000000000a'
const RUN_B = '00000000-0000-4000-8000-00000000000b'

const line = (seq: number, text = `line ${seq}`): LogLine => ({ seq, stream: 'stdout', at: seq, text, truncated: false })

function harness(limits: Partial<BatcherLimits> = {}) {
  const sent: LogBatch[] = []
  let active = true
  const batcher = createBatcher(
    { active: () => active, send: (batch) => sent.push(batch) },
    { intervalMs: BATCH_INTERVAL_MS, maxLines: BATCH_MAX_LINES, maxBytes: BATCH_MAX_BYTES, maxUnacked: MAX_UNACKED_BATCHES, ...limits },
  )
  const seqs = { [RUN_A]: 0, [RUN_B]: 0 }
  const acked = new Set<number>()
  const add = (runId: typeof RUN_A | typeof RUN_B, count = 1, text?: string): void => {
    for (let i = 0; i < count; i++) {
      const next = line(++seqs[runId], text)
      batcher.add(COMMAND, runId, next, Buffer.byteLength(next.text))
    }
  }
  const ack = (batchId: number): void => {
    acked.add(batchId)
    batcher.ack(batchId)
  }
  return {
    batcher,
    sent,
    add,
    seqs,
    ack,
    /** The oldest batch not acknowledged yet. */
    oldestUnacked: () => sent.find((batch) => !acked.has(batch.batchId)),
    ackAll: () => {
      for (const batch of [...sent]) if (!acked.has(batch.batchId)) ack(batch.batchId)
    },
    setActive: (value: boolean) => {
      active = value
    },
  }
}

/** Every seq of the run, each exactly once, as delivered lines or reported skipped ranges, in order. */
function coverage(sent: readonly LogBatch[], runId: string): { delivered: number; skipped: number; seqs: number[] } {
  const seqs: number[] = []
  let delivered = 0
  let skipped = 0
  for (const batch of sent.filter((b) => b.runId === runId)) {
    expect(logBatchSchema.safeParse(batch).success).toBe(true)
    if (batch.skipped !== null) {
      for (let seq = batch.skipped.fromSeq; seq <= batch.skipped.toSeq; seq++) seqs.push(seq)
      skipped += batch.skipped.toSeq - batch.skipped.fromSeq + 1
    }
    for (const l of batch.lines) seqs.push(l.seq)
    delivered += batch.lines.length
    expect(batch.seq).toBe(batch.lines.at(-1)?.seq ?? batch.skipped?.toSeq)
  }
  return { delivered, skipped, seqs }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('log batcher', () => {
  it('sends a run’s lines as one batch at the latest after the batch interval', () => {
    const h = harness()
    h.add(RUN_A, 3)
    expect(h.sent).toEqual([])
    vi.advanceTimersByTime(BATCH_INTERVAL_MS)
    expect(h.sent).toEqual([{ commandId: COMMAND, runId: RUN_A, seq: 3, batchId: 1, lines: [line(1), line(2), line(3)], skipped: null }])
  })

  it('sends at once when a batch reaches the line or byte limit', () => {
    const h = harness({ maxLines: 3, maxBytes: 20 })
    h.add(RUN_A, 3)
    expect(h.sent.map((b) => b.lines.length)).toEqual([3])
    h.add(RUN_B, 3, 'x'.repeat(8)) // 24 bytes: the third line starts a new batch
    expect(h.sent.map((b) => [b.runId, b.lines.length])).toEqual([
      [RUN_A, 3],
      [RUN_B, 2],
    ])
  })

  it('[spec:process-logs/slow-view] skips lines while the renderer is behind and reports how many, exactly', () => {
    const h = harness({ maxLines: 10 })
    h.add(RUN_A, 40) // 4 full batches: none acknowledged yet
    expect(h.sent).toHaveLength(MAX_UNACKED_BATCHES)
    h.add(RUN_A, 10) // queued: one batch worth may wait
    // The queue is full: its lines and each further line become a skipped range, which grows
    // whenever the queue behind it fills up again (41–73 skipped, 74–75 queued).
    h.add(RUN_A, 25)
    vi.advanceTimersByTime(BATCH_INTERVAL_MS * 10)
    expect(h.sent).toHaveLength(MAX_UNACKED_BATCHES)

    h.ack(h.sent[0]?.batchId ?? 0)
    expect(h.sent).toHaveLength(MAX_UNACKED_BATCHES + 1)
    expect(h.sent.at(-1)).toMatchObject({ skipped: { fromSeq: 41, toSeq: 73 }, lines: [line(74), line(75)], seq: 75 })
    // Live delivery resumes after the marker.
    h.add(RUN_A, 2)
    h.ackAll()
    vi.advanceTimersByTime(BATCH_INTERVAL_MS)
    expect(h.sent.at(-1)).toMatchObject({ skipped: null, lines: [line(76), line(77)] })
    expect(coverage(h.sent, RUN_A)).toEqual({ delivered: 44, skipped: 33, seqs: Array.from({ length: 77 }, (_, i) => i + 1) })
    expect(h.batcher.stats()).toMatchObject({ deliveredLines: 44, skippedLines: 33, droppedLines: 0 })
  })

  it('ignores unknown and repeated acknowledgements', () => {
    const h = harness({ maxLines: 1 })
    h.add(RUN_A, 4)
    h.batcher.ack(99)
    h.batcher.ack(1)
    h.batcher.ack(1)
    expect(h.batcher.stats().unacked).toBe(3)
  })

  it('starts over when a new document subscribes: batches sent before are never acknowledged', () => {
    const h = harness({ maxLines: 1 })
    h.add(RUN_A, 4)
    h.add(RUN_A, 1)
    expect(h.sent).toHaveLength(4)
    h.batcher.reset()
    expect(h.sent).toHaveLength(5)
    expect(h.batcher.stats().unacked).toBe(1)
  })

  it('drops everything while nobody is subscribed', () => {
    const h = harness()
    h.add(RUN_A, 2)
    h.setActive(false)
    vi.advanceTimersByTime(BATCH_INTERVAL_MS)
    h.add(RUN_A, 1)
    expect(h.sent).toEqual([])
    expect(h.batcher.stats()).toMatchObject({ droppedLines: 3, unacked: 0 })
    h.setActive(true)
    h.add(RUN_A, 1)
    vi.advanceTimersByTime(BATCH_INTERVAL_MS)
    expect(h.sent.map((b) => b.lines.map((l) => l.seq))).toEqual([[4]])
  })

  it('forgets cleared lines that were not delivered yet, including skipped ones', () => {
    const h = harness({ maxLines: 2, maxUnacked: 1 })
    h.add(RUN_A, 2) // sent
    h.add(RUN_A, 5) // 3–5 skipped, 6–7 queued
    h.batcher.discard(RUN_A, 5)
    h.add(RUN_A, 1) // the queue is full: 6–8 skipped
    h.ackAll()
    expect(h.sent.at(-1)).toMatchObject({ skipped: { fromSeq: 6, toSeq: 8 }, lines: [] })
    h.batcher.discard(RUN_A, 100)
    expect(h.batcher.stats().droppedLines).toBe(3)
  })

  it('accounts for every line exactly under random load (three seeds)', () => {
    for (const seed of [1, 0xc0ffee, 20261024]) {
      let state = seed
      const random = (): number => {
        state = (state * 1103515245 + 12345) % 2 ** 31
        return state / 2 ** 31
      }
      const h = harness({ maxLines: 7, maxBytes: 64 })
      for (let step = 0; step < 2000; step++) {
        const r = random()
        if (r < 0.6) h.add(random() < 0.5 ? RUN_A : RUN_B, 1 + Math.floor(random() * 5), 'z'.repeat(Math.floor(random() * 12)))
        else if (r < 0.8) {
          const oldest = h.oldestUnacked()
          if (oldest !== undefined) h.ack(oldest.batchId)
        } else vi.advanceTimersByTime(Math.floor(random() * BATCH_INTERVAL_MS * 2))
        expect(h.batcher.stats().unacked).toBeLessThanOrEqual(MAX_UNACKED_BATCHES)
      }
      // Drain: acknowledge everything until nothing more is sent.
      for (let i = 0; i < 1000; i++) {
        h.ackAll()
        vi.advanceTimersByTime(BATCH_INTERVAL_MS)
      }
      expect(h.batcher.stats().unacked).toBe(0)
      for (const runId of [RUN_A, RUN_B] as const) {
        const { seqs } = coverage(h.sent, runId)
        expect(seqs, `seed ${seed}`).toEqual(Array.from({ length: h.seqs[runId] }, (_, i) => i + 1))
      }
      const stats = h.batcher.stats()
      expect(stats.droppedLines).toBe(0)
      expect(stats.deliveredLines + stats.skippedLines).toBe(h.seqs[RUN_A] + h.seqs[RUN_B])
      expect(stats.skippedLines, `seed ${seed}: the scenario must exercise skipping`).toBeGreaterThan(0)
    }
  })
})
