import type { LogLine, LogStream } from '../../shared/api'
import { GLOBAL_MAX_BYTES, RUN_MAX_BYTES, RUN_MAX_LINES } from '../../shared/logs/limits'

export interface RetentionLimits {
  readonly runMaxLines: number
  readonly runMaxBytes: number
  readonly totalMaxBytes: number
}

export const DEFAULT_RETENTION: RetentionLimits = { runMaxLines: RUN_MAX_LINES, runMaxBytes: RUN_MAX_BYTES, totalMaxBytes: GLOBAL_MAX_BYTES }

/**
 * The retained lines of one run, oldest first, in a ring of at most `maxLines` entries. Sequence
 * numbers are consecutive from 1 in capture order across both streams; retained lines always form
 * one consecutive range, because lines leave only from the front (limits) or all at once (clear).
 * `bytes` counts the UTF-8 size of the retained text.
 */
export class RunBuffer {
  private readonly lines: (LogLine | undefined)[]
  private readonly sizes: number[]
  private head = 0
  private count = 0
  private size = 0
  private next = 1
  private dropped = 0

  constructor(
    readonly commandId: string,
    readonly runId: string,
    private readonly maxLines: number,
    private readonly maxBytes: number,
  ) {
    this.lines = new Array<LogLine | undefined>(maxLines)
    this.sizes = new Array<number>(maxLines).fill(0)
  }

  /** UTF-8 bytes of the retained text. */
  get bytes(): number {
    return this.size
  }

  get length(): number {
    return this.count
  }

  /** Seq the next captured line gets. */
  get nextSeq(): number {
    return this.next
  }

  /** Lines discarded by the retention limits since the run started or was last cleared. */
  get discarded(): number {
    return this.dropped
  }

  /** Seq of the oldest retained line, or `null` if none is retained. */
  get firstSeq(): number | null {
    return this.count === 0 ? null : this.next - this.count
  }

  /**
   * Appends a line of `bytes` UTF-8 bytes, discarding the oldest lines as needed to stay within
   * the run's limits. Returns the new line and the bytes discarded to make room.
   */
  append(stream: LogStream, at: number, text: string, truncated: boolean, bytes: number): { line: LogLine; freed: number } {
    let freed = 0
    while (this.count > 0 && (this.count >= this.maxLines || this.size + bytes > this.maxBytes)) freed += this.dropOldest()
    const line: LogLine = { seq: this.next, stream, at, text, truncated }
    const slot = (this.head + this.count) % this.maxLines
    this.lines[slot] = line
    this.sizes[slot] = bytes
    this.count++
    this.size += bytes
    this.next++
    return { line, freed }
  }

  /** Discards the oldest retained line; returns its size (0 if nothing is retained). */
  dropOldest(): number {
    if (this.count === 0) return 0
    const bytes = this.sizes[this.head] ?? 0
    this.lines[this.head] = undefined
    this.sizes[this.head] = 0
    this.head = (this.head + 1) % this.maxLines
    this.count--
    this.size -= bytes
    this.dropped++
    return bytes
  }

  /** Up to `limit` retained lines with seq ≥ `fromSeq`, oldest first. */
  read(fromSeq: number, limit: number): LogLine[] {
    const first = this.firstSeq
    if (first === null) return []
    const start = Math.max(fromSeq, first)
    const end = Math.min(this.next, start + limit)
    const out: LogLine[] = []
    for (let seq = start; seq < end; seq++) {
      const line = this.lines[(this.head + (seq - first)) % this.maxLines]
      if (line !== undefined) out.push(line)
    }
    return out
  }

  /**
   * Discards every retained line (spec: clear); capture continues with the next seq. Returns the
   * highest seq captured so far (0 if none) and the bytes freed.
   */
  clear(): { clearedThroughSeq: number; freed: number } {
    const freed = this.size
    this.lines.fill(undefined)
    this.sizes.fill(0)
    this.head = 0
    this.count = 0
    this.size = 0
    this.dropped = 0
    return { clearedThroughSeq: this.next - 1, freed }
  }
}

interface CommandRuns {
  current: RunBuffer
  previous: RunBuffer | null
}

export interface LogStore {
  /**
   * Starts retaining a new run of `commandId`: its current run becomes the previous one, and the
   * run that was previous is no longer retained (spec: current and most recent previous run).
   */
  open(commandId: string, runId: string): RunBuffer
  /** The retained run, if it is still the current or previous run of its command. */
  get(runId: string): RunBuffer | undefined
  /** Appends a line to `run` and enforces the total limit; `null` if the run is no longer retained. */
  append(run: RunBuffer, stream: LogStream, at: number, text: string, truncated: boolean, bytes: number): LogLine | null
  /** Discards a run's retained lines; see `RunBuffer.clear`. */
  clear(run: RunBuffer): number
  /** UTF-8 bytes of all retained text. */
  readonly totalBytes: () => number
}

/**
 * Retained output of the session (design D11): per run at most `runMaxLines` lines and
 * `runMaxBytes` bytes; per command the current and the previous run; in total at most
 * `totalMaxBytes`. Over the total limit, the oldest lines of previous runs go first (largest
 * previous run first), then the oldest lines of the largest current run.
 */
export function createLogStore(limits: RetentionLimits = DEFAULT_RETENTION): LogStore {
  const commands = new Map<string, CommandRuns>()
  const runs = new Map<string, RunBuffer>()
  let total = 0

  /** The largest non-empty previous run, or else the largest non-empty current run. */
  const victim = (): RunBuffer | null => {
    let previous: RunBuffer | null = null
    let current: RunBuffer | null = null
    for (const runsOf of commands.values()) {
      const p = runsOf.previous
      if (p !== null && p.length > 0 && (previous === null || p.bytes > previous.bytes)) previous = p
      const c = runsOf.current
      if (c.length > 0 && (current === null || c.bytes > current.bytes)) current = c
    }
    return previous ?? current
  }

  const enforceTotal = (): void => {
    while (total > limits.totalMaxBytes) {
      const run = victim()
      if (run === null) return
      total -= run.dropOldest()
    }
  }

  return {
    open(commandId, runId) {
      const existing = runs.get(runId)
      if (existing !== undefined) return existing
      const run = new RunBuffer(commandId, runId, limits.runMaxLines, limits.runMaxBytes)
      const known = commands.get(commandId)
      if (known !== undefined) {
        if (known.previous !== null) {
          total -= known.previous.bytes
          runs.delete(known.previous.runId)
        }
        commands.set(commandId, { current: run, previous: known.current })
      } else {
        commands.set(commandId, { current: run, previous: null })
      }
      runs.set(runId, run)
      return run
    },

    get: (runId) => runs.get(runId),

    append(run, stream, at, text, truncated, bytes) {
      if (runs.get(run.runId) !== run) return null
      const { line, freed } = run.append(stream, at, text, truncated, bytes)
      total += bytes - freed
      enforceTotal()
      return line
    },

    clear(run) {
      const { clearedThroughSeq, freed } = run.clear()
      if (runs.get(run.runId) === run) total -= freed
      return clearedThroughSeq
    },

    totalBytes: () => total,
  }
}
