import type { LogBatch, LogLine } from '../../shared/api'
import { BATCH_INTERVAL_MS, BATCH_MAX_BYTES, BATCH_MAX_LINES, MAX_UNACKED_BATCHES } from '../../shared/logs/limits'

/** Where batches go: the renderer documents subscribed to `logs.onBatch`. */
export interface BatchDelivery {
  /** True while at least one document is subscribed. */
  readonly active: () => boolean
  readonly send: (batch: LogBatch) => void
}

export interface BatcherLimits {
  readonly intervalMs: number
  readonly maxLines: number
  readonly maxBytes: number
  readonly maxUnacked: number
}

export const DEFAULT_BATCHER_LIMITS: BatcherLimits = {
  intervalMs: BATCH_INTERVAL_MS,
  maxLines: BATCH_MAX_LINES,
  maxBytes: BATCH_MAX_BYTES,
  maxUnacked: MAX_UNACKED_BATCHES,
}

/** Counters for tests and diagnostics: every added line is delivered, skipped, or dropped. */
export interface BatcherStats {
  readonly deliveredLines: number
  readonly skippedLines: number
  /** Lines nobody was subscribed for, or that were cleared before delivery. */
  readonly droppedLines: number
  readonly batches: number
  readonly unacked: number
}

export interface Batcher {
  /** Queues a captured line (`bytes`: UTF-8 size of its text) for live delivery. */
  add(commandId: string, runId: string, line: LogLine, bytes: number): void
  /** The renderer processed `batchId`; unknown or repeated IDs are ignored. */
  ack(batchId: number): void
  /** A document subscribed: batches sent before will never be acknowledged. */
  reset(): void
  /** The run's lines up to `throughSeq` were cleared: they are no longer delivered or reported as skipped. */
  discard(runId: string, throughSeq: number): void
  stats(): BatcherStats
  dispose(): void
}

interface RunQueue {
  readonly commandId: string
  readonly runId: string
  /** Lines left out of live delivery, all before `pending`. */
  skipped: { fromSeq: number; toSeq: number } | null
  pending: LogLine[]
  pendingBytes: number
}

/**
 * Live delivery of captured lines (design D11). Lines are sent per run in batches: at the latest
 * `intervalMs` after a line is queued, or at once when a batch reaches `maxLines` or `maxBytes`.
 * At most `maxUnacked` batches may wait for the renderer's acknowledgement; meanwhile each run
 * keeps at most one batch worth of lines. When that is full, its queued lines and every further
 * line become a skipped range, which the next batch of the run reports (spec: slow view) and which
 * the renderer can fetch with `logs.read`. A run's lines are never delayed behind its skipped
 * range, and every line is either delivered or covered by exactly one reported range, unless
 * nobody is subscribed or it is cleared first.
 *
 * Output is never paused: this only decides what is sent.
 */
export function createBatcher(delivery: BatchDelivery, limits: BatcherLimits = DEFAULT_BATCHER_LIMITS): Batcher {
  const queues = new Map<string, RunQueue>()
  /** Runs whose batch is due, in the order they became due. */
  const due = new Set<string>()
  const unacked = new Set<number>()
  let nextBatchId = 1
  let timer: NodeJS.Timeout | null = null
  let deliveredLines = 0
  let skippedLines = 0
  let droppedLines = 0
  let batches = 0

  const queuedLines = (queue: RunQueue): number => queue.pending.length + (queue.skipped === null ? 0 : queue.skipped.toSeq - queue.skipped.fromSeq + 1)

  /** Nobody can receive batches: forget everything (a new document reads retained lines instead). */
  const dropAll = (): void => {
    for (const queue of queues.values()) droppedLines += queuedLines(queue)
    queues.clear()
    due.clear()
    unacked.clear()
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  const send = (queue: RunQueue): void => {
    due.delete(queue.runId)
    queues.delete(queue.runId)
    const last = queue.pending.at(-1)?.seq ?? queue.skipped?.toSeq
    if (last === undefined) return
    const batchId = nextBatchId++
    unacked.add(batchId)
    batches++
    deliveredLines += queue.pending.length
    if (queue.skipped !== null) skippedLines += queue.skipped.toSeq - queue.skipped.fromSeq + 1
    delivery.send({ commandId: queue.commandId, runId: queue.runId, seq: last, batchId, lines: queue.pending, skipped: queue.skipped })
  }

  const pump = (): void => {
    if (!delivery.active()) return dropAll()
    for (const runId of due) {
      if (unacked.size >= limits.maxUnacked) return
      const queue = queues.get(runId)
      if (queue === undefined) due.delete(runId)
      else send(queue)
    }
  }

  const onTimer = (): void => {
    timer = null
    for (const runId of queues.keys()) due.add(runId)
    pump()
  }

  const schedule = (): void => {
    if (timer === null) timer = setTimeout(onTimer, limits.intervalMs)
  }

  const full = (queue: RunQueue, bytes: number): boolean =>
    queue.pending.length >= limits.maxLines || (queue.pending.length > 0 && queue.pendingBytes + bytes > limits.maxBytes)

  return {
    add(commandId, runId, line, bytes) {
      if (!delivery.active()) {
        dropAll()
        droppedLines++
        return
      }
      let queue = queues.get(runId)
      if (queue === undefined) {
        queue = { commandId, runId, skipped: null, pending: [], pendingBytes: 0 }
        queues.set(runId, queue)
      }
      if (full(queue, bytes)) {
        if (unacked.size < limits.maxUnacked) {
          send(queue)
          queue = { commandId, runId, skipped: null, pending: [], pendingBytes: 0 }
          queues.set(runId, queue)
        } else {
          // The renderer is behind and this run's batch is full: its queued lines and this one
          // are skipped (the range stays consecutive and before any later queued line).
          const fromSeq = queue.skipped?.fromSeq ?? queue.pending[0]?.seq ?? line.seq
          queue.skipped = { fromSeq, toSeq: line.seq }
          queue.pending = []
          queue.pendingBytes = 0
          due.add(runId)
          return
        }
      }
      queue.pending.push(line)
      queue.pendingBytes += bytes
      if (!full(queue, 0)) schedule()
      else if (unacked.size < limits.maxUnacked) send(queue)
      // Sent as soon as an acknowledgement allows.
      else due.add(runId)
    },

    ack(batchId) {
      if (!unacked.delete(batchId)) return
      pump()
    },

    reset() {
      unacked.clear()
      pump()
    },

    discard(runId, throughSeq) {
      const queue = queues.get(runId)
      if (queue === undefined) return
      const kept = queue.pending.filter((line) => line.seq > throughSeq)
      if (kept.length !== queue.pending.length) {
        droppedLines += queue.pending.length - kept.length
        queue.pending = kept
        queue.pendingBytes = kept.reduce((sum, line) => sum + Buffer.byteLength(line.text, 'utf8'), 0)
      }
      if (queue.skipped !== null && queue.skipped.fromSeq <= throughSeq) {
        const toSeq = queue.skipped.toSeq
        droppedLines += Math.min(toSeq, throughSeq) - queue.skipped.fromSeq + 1
        queue.skipped = toSeq > throughSeq ? { fromSeq: throughSeq + 1, toSeq } : null
      }
      if (queue.pending.length === 0 && queue.skipped === null) {
        queues.delete(runId)
        due.delete(runId)
      }
    },

    stats: () => ({ deliveredLines, skippedLines, droppedLines, batches, unacked: unacked.size }),

    dispose() {
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
  }
}
