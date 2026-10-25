import { StringDecoder } from 'node:string_decoder'
import { MAX_LINE_BYTES, PARTIAL_LINE_FLUSH_MS } from '../../shared/logs/limits'

/** A completed line: its text (at most `MAX_LINE_BYTES` UTF-8 bytes) and whether it was cut. */
export type LineListener = (text: string, truncated: boolean) => void

export interface LineSplitter {
  /** Adds a chunk of the stream's bytes. */
  write(chunk: Buffer): void
  /** The stream ended: emits a pending partial line and stops the flush timer. */
  end(): void
}

/**
 * The longest prefix of `text` that fits in `maxBytes` UTF-8 bytes, never cutting a character.
 * `bytes` is `Buffer.byteLength(text)`, which the caller already knows.
 */
export function cutToBytes(text: string, bytes: number, maxBytes: number): string {
  if (bytes <= maxBytes) return text
  const encoded = Buffer.from(text, 'utf8')
  let end = maxBytes
  // Step back over continuation bytes (10xxxxxx) to the start of the character that does not fit.
  while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) end--
  return encoded.toString('utf8', 0, end)
}

export interface LineSplitterOptions {
  readonly flushMs?: number
  readonly maxBytes?: number
  /**
   * How many characters at the end of a partial line to keep back when it is flushed (they are
   * shown with what follows, or when the line or stream ends); e.g. the start of a secret value.
   */
  readonly holdBack?: (text: string) => number
}

/**
 * Splits one output stream into lines (design D11, spec: line handling):
 * - lines end at `\n`; a `\r` right before it is dropped (`\r\n`);
 * - a lone `\r` inside a line (progress output) discards the text before it, so the line keeps
 *   what follows the last `\r`;
 * - bytes are decoded as UTF-8 across chunk boundaries; invalid sequences become U+FFFD;
 * - a line longer than `MAX_LINE_BYTES` keeps its first bytes up to the limit and is marked
 *   truncated; the rest of it, up to the next newline, is read and dropped;
 * - text without a newline is emitted as a line of its own once the stream has been idle for
 *   `PARTIAL_LINE_FLUSH_MS`, except a tail that `holdBack` keeps back. What follows continues on
 *   a new line; a newline that immediately follows the flushed text only ends it and does not
 *   produce an empty line.
 */
export function createLineSplitter(onLine: LineListener, options: LineSplitterOptions = {}): LineSplitter {
  const flushMs = options.flushMs ?? PARTIAL_LINE_FLUSH_MS
  const maxBytes = options.maxBytes ?? MAX_LINE_BYTES
  const holdBack = options.holdBack ?? (() => 0)
  const decoder = new StringDecoder('utf8')

  /** Retained text of the current line and its UTF-8 size. */
  let pending = ''
  let pendingBytes = 0
  let truncated = false
  /** A `\r` was the last character seen: it ends the line if `\n` follows, otherwise it is a lone `\r`. */
  let carriageReturn = false
  /** The current line's text was already emitted by a partial flush. */
  let flushed = false
  let lastDataAt = 0
  let timer: NodeJS.Timeout | null = null
  let ended = false

  const resetLine = (): void => {
    pending = ''
    pendingBytes = 0
    truncated = false
  }

  const append = (text: string): void => {
    if (text === '' || truncated) return
    const bytes = Buffer.byteLength(text, 'utf8')
    if (pendingBytes + bytes <= maxBytes) {
      pending += text
      pendingBytes += bytes
      return
    }
    pending += cutToBytes(text, bytes, maxBytes - pendingBytes)
    pendingBytes = Buffer.byteLength(pending, 'utf8')
    truncated = true
  }

  const emitLine = (): void => {
    // A newline right after a partial flush only ends the flushed text (or the dropped rest of a
    // flushed truncated line).
    if (!(flushed && pending === '')) onLine(pending, truncated)
    resetLine()
    flushed = false
  }

  const consume = (text: string): void => {
    let from = 0
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (carriageReturn) {
        carriageReturn = false
        if (code !== 0x0a) {
          // Lone `\r`: the line restarts with what follows. A partial flush of the earlier text
          // already showed it, so the restarted line is a new line.
          resetLine()
          flushed = false
        }
      }
      if (code === 0x0a) {
        append(text.slice(from, i))
        emitLine()
        from = i + 1
      } else if (code === 0x0d) {
        append(text.slice(from, i))
        carriageReturn = true
        from = i + 1
      }
    }
    append(text.slice(from))
  }

  const flushPartial = (): void => {
    timer = null
    if (ended) return
    const idle = Date.now() - lastDataAt
    if (idle < flushMs) {
      timer = setTimeout(flushPartial, flushMs - idle)
      return
    }
    if (pending === '') return
    // A truncated line is shown as it is (its end is no longer growing).
    const keep = truncated ? 0 : Math.min(holdBack(pending), pending.length)
    // Everything is kept back: shown once the line continues or ends.
    if (keep === pending.length) return
    onLine(pending.slice(0, pending.length - keep), truncated)
    // A truncated line stays truncated: the rest of it, up to its newline, is still dropped.
    pending = pending.slice(pending.length - keep)
    pendingBytes = Buffer.byteLength(pending, 'utf8')
    flushed = true
  }

  return {
    write(chunk) {
      if (ended) return
      const text = decoder.write(chunk)
      if (text !== '') consume(text)
      lastDataAt = Date.now()
      if (timer === null && pending !== '') timer = setTimeout(flushPartial, flushMs)
    },
    end() {
      if (ended) return
      const rest = decoder.end()
      if (rest !== '') consume(rest)
      ended = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      if (pending !== '') onLine(pending, truncated)
      resetLine()
    },
  }
}
