import { isUtf8 } from 'node:buffer'
import { StringDecoder } from 'node:string_decoder'
import { MAX_LINE_BYTES, PARTIAL_LINE_FLUSH_MS } from '../../shared/logs/limits'

/**
 * A completed line: its text (at most `MAX_LINE_BYTES` UTF-8 bytes) and whether it was cut. When
 * the text was decoded with a fallback encoding, `utf8` is the same bytes decoded as UTF-8 with
 * replacement characters (within the same limit), so that secret values printed in UTF-8 on such
 * a line can still be found (add-windows-environment-and-commands group 5 review).
 */
export type LineListener = (text: string, truncated: boolean, utf8?: string) => void

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
  /**
   * WHATWG label of the encoding a line that is not valid UTF-8 is decoded with instead (Windows:
   * the ANSI code page, add-windows-environment-and-commands design D5). Without it, invalid UTF-8
   * becomes U+FFFD. An unsupported label throws a `RangeError` (see `isSupportedEncoding`).
   */
  readonly fallbackEncoding?: string | null
}

/** Whether `label` names an encoding `TextDecoder` can decode in this runtime. */
export function isSupportedEncoding(label: string): boolean {
  try {
    new TextDecoder(label)
    return true
  } catch {
    return false
  }
}

/**
 * The length of `bytes` without a trailing incomplete UTF-8 sequence: a lead byte followed by fewer
 * continuation bytes than it announces. Anything else (complete or not UTF-8 at all) is kept.
 */
export function completeUtf8Length(bytes: Uint8Array): number {
  let start = bytes.length
  // At most 3 continuation bytes can follow a lead byte.
  while (start > 0 && bytes.length - start < 3 && ((bytes[start - 1] ?? 0) & 0xc0) === 0x80) start--
  if (start === 0) return bytes.length
  const lead = bytes[start - 1] ?? 0
  const needed = lead >= 0xc2 && lead <= 0xdf ? 1 : lead >= 0xe0 && lead <= 0xef ? 2 : lead >= 0xf0 && lead <= 0xf4 ? 3 : 0
  const present = bytes.length - start
  return needed > present ? start - 1 : bytes.length
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
  const fallbackEncoding = options.fallbackEncoding ?? null
  if (fallbackEncoding !== null) return createFallbackLineSplitter(onLine, options, fallbackEncoding)
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

/** A decoded line, and its UTF-8 view when it was decoded with the fallback. */
interface Decoded {
  readonly text: string
  readonly utf8?: string
}

/**
 * The splitter with a fallback encoding (add-windows-environment-and-commands design D5): the same
 * line rules as `createLineSplitter`, but each stream is split on `\n` and `\r` *bytes*, and each
 * line is decoded as a whole once it is complete, flushed, or cut:
 * - a line that is valid UTF-8 is decoded as UTF-8; any other line with the fallback encoding.
 *   None of the fallback encodings uses the bytes of `\n` or `\r` inside a multibyte character, so
 *   splitting on bytes never cuts one;
 * - a line longer than `maxBytes` bytes is cut at that many bytes, and a trailing incomplete UTF-8
 *   sequence is dropped before deciding whether it is UTF-8;
 * - a decoded line whose UTF-8 form is longer than `maxBytes` is cut again, never through a
 *   character, and marked truncated, so `LineListener`'s limit holds (the log API refuses longer
 *   text). ANSI text never shrinks when decoded, so a cut ANSI line always loses its last
 *   characters this way, a multibyte character cut in two among them;
 * - a partial line is decoded the same way when it is flushed. An incomplete character at its end
 *   is kept back with the line, and shown once the rest of it arrives.
 *
 * For UTF-8 output it emits what `createLineSplitter` emits without a fallback, except when the
 * stream goes idle inside a character, since this splitter sees its bytes before it is complete:
 * - after a lone `\r`, the line already restarts, so the text the `\r` overwrites is not flushed;
 * - past the byte limit, the flushed partial line is already marked truncated.
 */
function createFallbackLineSplitter(onLine: LineListener, options: LineSplitterOptions, fallbackEncoding: string): LineSplitter {
  const flushMs = options.flushMs ?? PARTIAL_LINE_FLUSH_MS
  const maxBytes = options.maxBytes ?? MAX_LINE_BYTES
  const holdBack = options.holdBack ?? (() => 0)
  // `ignoreBOM`: a byte order mark stays in the text, as with `StringDecoder`. Both decoders are
  // used without `stream`, so each call decodes one whole line and keeps no state.
  const fallback = new TextDecoder(fallbackEncoding, { ignoreBOM: true })
  /** Used only to find where a partial line can be divided (`fallbackPrefix`); reset after each use. */
  const fallbackStream = new TextDecoder(fallbackEncoding, { ignoreBOM: true })

  /** Retained bytes of the current line: `line[0, length)`, at most `maxBytes`. */
  const line = Buffer.alloc(maxBytes)
  let length = 0
  let truncated = false
  let carriageReturn = false
  let flushed = false
  let lastDataAt = 0
  let timer: NodeJS.Timeout | null = null
  let ended = false

  const resetLine = (): void => {
    length = 0
    truncated = false
  }

  const append = (chunk: Buffer, from: number, to: number): void => {
    if (from >= to || truncated) return
    const room = maxBytes - length
    if (to - from <= room) {
      length += chunk.copy(line, length, from, to)
      return
    }
    length += chunk.copy(line, length, from, from + room)
    truncated = true
  }

  /** `text` within `maxBytes` UTF-8 bytes, cut at a character boundary if it is longer. */
  const fit = (text: string): { readonly text: string; readonly cut: boolean } => {
    const bytes = Buffer.byteLength(text, 'utf8')
    return bytes <= maxBytes ? { text, cut: false } : { text: cutToBytes(text, bytes, maxBytes), cut: true }
  }

  /**
   * Emits a decoded line (or part of one), within `maxBytes` UTF-8 bytes, with its UTF-8 view
   * when it was decoded with the fallback. Returns whether the text had to be cut to fit.
   */
  const deliver = (decoded: Decoded, cut: boolean): boolean => {
    const text = fit(decoded.text)
    if (decoded.utf8 === undefined) onLine(text.text, cut || text.cut)
    else onLine(text.text, cut || text.cut, fit(decoded.utf8).text)
    return text.cut
  }

  /** Decodes a whole line; a cut line first loses a trailing incomplete UTF-8 sequence. */
  const decode = (bytes: Buffer, cut: boolean): Decoded => {
    const end = cut ? completeUtf8Length(bytes) : bytes.length
    const head = bytes.subarray(0, end)
    return isUtf8(head) ? { text: head.toString('utf8') } : { text: fallback.decode(head), utf8: head.toString('utf8') }
  }

  const emitLine = (): void => {
    if (!(flushed && length === 0)) deliver(decode(line.subarray(0, length), truncated), truncated)
    resetLine()
    flushed = false
  }

  /**
   * Bytes a hold-back rule keeps back at the end of `bytes` read as UTF-8 (0 if it cannot tell).
   * An incomplete UTF-8 character at the end may continue the secret, so it is left out of the
   * text the rule sees, and kept back with the secret's start (group 5 re-review).
   */
  const utf8HeldBytes = (bytes: Buffer): number => {
    const complete = completeUtf8Length(bytes)
    const text = bytes.toString('utf8', 0, complete)
    const kept = text.slice(text.length - Math.min(holdBack(text), text.length))
    // A replacement character stands for an unknown number of bytes; a secret never contains one.
    if (kept === '' || kept.includes('\uFFFD')) return 0
    return Buffer.byteLength(kept, 'utf8') + (bytes.length - complete)
  }

  /**
   * The text of `bytes` decoded with the fallback, without an incomplete character at the end, and
   * for each UTF-16 unit of it the number of bytes read when it was produced.
   */
  const fallbackPrefix = (bytes: Buffer): { readonly text: string; readonly ends: readonly number[] } => {
    let text = ''
    const ends: number[] = []
    try {
      for (let i = 0; i < bytes.length; i++) {
        const produced = fallbackStream.decode(bytes.subarray(i, i + 1), { stream: true })
        for (let unit = 0; unit < produced.length; unit++) ends.push(i + 1)
        text += produced
      }
    } finally {
      // Ends the stream, dropping a held incomplete character, so the next use starts fresh.
      fallbackStream.decode()
    }
    return { text, ends }
  }

  const flushPartial = (): void => {
    timer = null
    if (ended) return
    const idle = Date.now() - lastDataAt
    if (idle < flushMs) {
      timer = setTimeout(flushPartial, flushMs - idle)
      return
    }
    if (length === 0) return
    const bytes = line.subarray(0, length)
    if (truncated) {
      // A truncated line is shown as it is (its end is no longer growing); the rest of it, up to
      // its newline, is still dropped.
      deliver(decode(bytes, true), true)
      length = 0
      flushed = true
      return
    }
    // How many bytes of the line are shown now; the rest stays pending.
    let shownBytes: number
    let shown: Decoded
    const complete = completeUtf8Length(bytes)
    if (isUtf8(bytes.subarray(0, complete))) {
      const text = bytes.toString('utf8', 0, complete)
      const keep = Math.min(holdBack(text), text.length)
      shown = { text: text.slice(0, text.length - keep) }
      shownBytes = Buffer.byteLength(shown.text, 'utf8')
    } else {
      const { text, ends } = fallbackPrefix(bytes)
      let count = text.length - Math.min(holdBack(text), text.length)
      // The start of a secret printed in UTF-8 on this line is kept back too (see `LineListener`).
      const limit = length - utf8HeldBytes(bytes)
      while (count > 0 && (ends[count - 1] ?? 0) > limit) count--
      // Divide only between bytes: units produced by the same byte are shown or kept together.
      // For example, in Shift_JIS the bytes 0x93 0x31 ("1" cannot end the character 0x93 starts)
      // produce U+FFFD and "1" together when 0x31 is read; showing U+FFFD alone would show "1" too.
      while (count > 0 && count < ends.length && ends[count - 1] === ends[count]) count--
      shownBytes = count === 0 ? 0 : (ends[count - 1] ?? 0)
      shown = { text: text.slice(0, count), utf8: bytes.toString('utf8', 0, shownBytes) }
    }
    // Everything is kept back: shown once the line continues or ends.
    if (shownBytes === 0) return
    if (deliver(shown, false)) {
      // Decoded, the shown part is longer than the limit (ANSI text grows in UTF-8): the line is
      // truncated, as if its bytes had passed the limit, and the rest of it up to its newline is
      // dropped (group 5 review).
      truncated = true
      length = 0
    } else {
      line.copy(line, 0, shownBytes, length)
      length -= shownBytes
    }
    flushed = true
  }

  /** Resolves a `\r` seen last, now that the byte at `at` follows it. */
  const afterCarriageReturn = (chunk: Buffer, at: number): void => {
    if (!carriageReturn || at >= chunk.length) return
    carriageReturn = false
    if (chunk[at] !== 0x0a) {
      // Lone `\r`: the line restarts with what follows (see `createLineSplitter`).
      resetLine()
      flushed = false
    }
  }

  // Native `indexOf` scans for the two line-control bytes, rather than a loop over every byte.
  const consume = (chunk: Buffer): void => {
    let from = 0
    let lf = chunk.indexOf(0x0a)
    let cr = chunk.indexOf(0x0d)
    afterCarriageReturn(chunk, 0)
    for (;;) {
      const at = lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr)
      if (at === -1) break
      append(chunk, from, at)
      if (at === lf) {
        emitLine()
        lf = chunk.indexOf(0x0a, at + 1)
      } else {
        carriageReturn = true
        cr = chunk.indexOf(0x0d, at + 1)
      }
      from = at + 1
      afterCarriageReturn(chunk, from)
    }
    append(chunk, from, chunk.length)
  }

  return {
    write(chunk) {
      if (ended) return
      if (chunk.length > 0) consume(chunk)
      lastDataAt = Date.now()
      if (timer === null && length > 0) timer = setTimeout(flushPartial, flushMs)
    },
    end() {
      if (ended) return
      ended = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      if (length > 0) deliver(decode(line.subarray(0, length), truncated), truncated)
      resetLine()
    },
  }
}
