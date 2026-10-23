import { z } from 'zod'
import { eventEnvelopeSchema, runIdSchema } from './processes'

/** Upper bound for one `logs.read` page. */
export const MAX_LOG_READ_LIMIT = 5_000
/** Upper bound for the lines of one live batch (design D11 flushes at 1,000 lines). */
export const MAX_BATCH_LINES = 1_000
/**
 * Upper bound for the text of one line, in UTF-16 code units. Lines are cut at 16 KiB of UTF-8
 * (design D11), and a UTF-8 byte sequence never has more code units than bytes.
 */
export const MAX_LINE_TEXT_LENGTH = 16 * 1024

const seqSchema = z.int().min(1)

export const logStreams = ['stdout', 'stderr'] as const
export type LogStream = (typeof logStreams)[number]

// Line and batch schemas are parsed for every batch and read (main validates what it sends), so
// they use only cheap checks: no refinements or patterns per line. Cost is measured in L6 (P1–P4).
export const logLineSchema = z.strictObject({
  /** Unique and increasing within the run. */
  seq: seqSchema,
  stream: z.enum(logStreams),
  /** Capture time, milliseconds since the Unix epoch. */
  at: z.int().min(0),
  /** Raw text; rendered only after ANSI processing (`src/shared/ansi`, L6). */
  text: z.string().max(MAX_LINE_TEXT_LENGTH),
  /** The line exceeded the per-line limit and was cut. */
  truncated: z.boolean(),
})
export type LogLine = z.infer<typeof logLineSchema>

export const skippedRangeSchema = z
  .strictObject({ fromSeq: seqSchema, toSeq: seqSchema })
  .refine((range) => range.fromSeq <= range.toSeq, { message: 'fromSeq must not exceed toSeq' })

/**
 * `logs.onBatch` payload. Envelope `seq` is the highest line seq the batch covers (lines or the
 * skipped range); `batchId` is what the renderer acknowledges with `logs.ack`.
 */
export const logBatchSchema = eventEnvelopeSchema.extend({
  batchId: z.int().min(1),
  lines: z.array(logLineSchema).max(MAX_BATCH_LINES),
  /** Lines left out of live delivery because the renderer fell behind; retrievable with `logs.read`. */
  skipped: skippedRangeSchema.nullable(),
})
export type LogBatch = z.infer<typeof logBatchSchema>

export const readLogsRequestSchema = z.strictObject({
  runId: runIdSchema,
  fromSeq: seqSchema,
  limit: z.int().min(1).max(MAX_LOG_READ_LIMIT),
})
export type ReadLogsRequest = z.infer<typeof readLogsRequestSchema>

export const readLogsResponseSchema = z.strictObject({
  runId: runIdSchema,
  lines: z.array(logLineSchema).max(MAX_LOG_READ_LIMIT),
  /** Oldest retained seq, or `null` if nothing is retained; lines before it were discarded. */
  firstRetainedSeq: seqSchema.nullable(),
  /** Seq the next captured line will get. */
  nextSeq: seqSchema,
})
export type ReadLogsResponse = z.infer<typeof readLogsResponseSchema>

export const runRefSchema = z.strictObject({ runId: runIdSchema })
export type RunRef = z.infer<typeof runRefSchema>

export const ackRequestSchema = z.strictObject({ batchId: z.int().min(1) })
export type AckRequest = z.infer<typeof ackRequestSchema>
