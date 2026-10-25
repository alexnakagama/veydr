import type { ClearLogsResponse, LogStream, ReadLogsRequest, ReadLogsResponse } from '../../shared/api'
import type { CommandConfig } from '../../shared/config'
import { NotFoundError } from '../errors'
import type { OutputSink } from '../supervisor/supervisor'
import { createBatcher, DEFAULT_BATCHER_LIMITS, type BatchDelivery, type Batcher, type BatcherLimits } from './batcher'
import { createLogStore, DEFAULT_RETENTION, type LogStore, type RetentionLimits, type RunBuffer } from './buffer'
import { createRedactor, redactableSecrets, type Redactor } from './redactor'
import { createLineSplitter, type LineSplitter } from './splitter'

export interface LogServiceOptions {
  readonly delivery: BatchDelivery
  readonly retention?: RetentionLimits
  readonly batching?: BatcherLimits
  readonly now?: () => number
}

/**
 * The log pipeline of the main process (design D11). As the supervisor's `OutputSink` it turns a
 * run's output into lines; it answers `logs.read`, `logs.clear`, and `logs.ack`.
 */
export interface LogService extends OutputSink {
  read(request: ReadLogsRequest): ReadLogsResponse
  clear(runId: string): ClearLogsResponse
  ack(batchId: number): void
  /** A document subscribed to `logs.onBatch` (see `Batcher.reset`). */
  resetDelivery(): void
  readonly store: Pick<LogStore, 'totalBytes'>
  readonly batcher: Pick<Batcher, 'stats'>
  dispose(): void
}

interface CapturingRun {
  readonly buffer: RunBuffer
  readonly redactor: Redactor
  readonly splitters: Partial<Record<LogStream, LineSplitter>>
}

/**
 * Pipeline per run: stream bytes → `LineSplitter` (one per stream) → `Redactor` → `LogStore`
 * (retention) → `Batcher` (live delivery). Lines of both streams share one sequence, in the order
 * they were completed (capture order; across streams this order is best-effort). Nothing is
 * written to disk.
 */
export function createLogService(options: LogServiceOptions): LogService {
  const now = options.now ?? Date.now
  const store = createLogStore(options.retention ?? DEFAULT_RETENTION)
  const batcher = createBatcher(options.delivery, options.batching ?? DEFAULT_BATCHER_LIMITS)
  /** Runs whose output streams are still open. */
  const capturing = new Map<string, CapturingRun>()

  const capture = (run: CapturingRun, stream: LogStream, raw: string, cut: boolean): void => {
    const { text, truncated } = run.redactor.redact(raw, cut)
    const bytes = Buffer.byteLength(text, 'utf8')
    const line = store.append(run.buffer, stream, now(), text, truncated, bytes)
    // `null`: the run is no longer retained (its command has started two newer runs).
    if (line !== null) batcher.add(run.buffer.commandId, run.buffer.runId, line, bytes)
  }

  const retained = (runId: string): RunBuffer => {
    const run = store.get(runId)
    if (run === undefined) throw new NotFoundError('No output is retained for this run.')
    return run
  }

  return {
    open(commandId: string, runId: string, command: Pick<CommandConfig, 'env'>) {
      if (capturing.has(runId)) return
      const run: CapturingRun = { buffer: store.open(commandId, runId), redactor: createRedactor(redactableSecrets(command)), splitters: {} }
      const holdBack = (text: string): number => run.redactor.secretPrefixLength(text)
      run.splitters.stdout = createLineSplitter((text, truncated) => capture(run, 'stdout', text, truncated), { holdBack })
      run.splitters.stderr = createLineSplitter((text, truncated) => capture(run, 'stderr', text, truncated), { holdBack })
      capturing.set(runId, run)
    },

    write(_commandId, runId, stream, chunk) {
      capturing.get(runId)?.splitters[stream]?.write(chunk)
    },

    close(_commandId, runId, stream) {
      const run = capturing.get(runId)
      const splitter = run?.splitters[stream]
      if (run === undefined || splitter === undefined) return
      splitter.end()
      delete run.splitters[stream]
      if (run.splitters.stdout === undefined && run.splitters.stderr === undefined) capturing.delete(runId)
    },

    read({ runId, fromSeq, limit }) {
      const run = retained(runId)
      return { runId, lines: run.read(fromSeq, limit), firstRetainedSeq: run.firstSeq, nextSeq: run.nextSeq, discarded: run.discarded }
    },

    clear(runId) {
      const run = retained(runId)
      const clearedThroughSeq = store.clear(run)
      batcher.discard(runId, clearedThroughSeq)
      return { clearedThroughSeq }
    },

    ack: (batchId) => batcher.ack(batchId),
    resetDelivery: () => batcher.reset(),
    store,
    batcher,

    dispose() {
      for (const run of capturing.values()) for (const splitter of Object.values(run.splitters)) splitter.end()
      capturing.clear()
      batcher.dispose()
    },
  }
}
