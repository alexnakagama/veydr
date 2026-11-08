import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { completeUtf8Length, createLineSplitter, cutToBytes, isSupportedEncoding } from '../../src/main/logs/splitter'
import { MAX_LINE_BYTES, PARTIAL_LINE_FLUSH_MS } from '../../src/shared/logs/limits'

type Line = [string, boolean]

function splitter(options: { maxBytes?: number; fallbackEncoding?: string; holdBack?: (text: string) => number } = {}) {
  const lines: Line[] = []
  const s = createLineSplitter((text, truncated) => lines.push([text, truncated]), options)
  const write = (...chunks: (string | Buffer | number[])[]): void => {
    for (const chunk of chunks) s.write(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return { lines, write, end: () => s.end() }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('line splitter', () => {
  it('splits on LF, keeps empty lines, and waits for the end of an unterminated line', () => {
    const s = splitter()
    s.write('a\n\nb\nc')
    expect(s.lines).toEqual([
      ['a', false],
      ['', false],
      ['b', false],
    ])
    s.write('d\n')
    expect(s.lines.at(-1)).toEqual(['cd', false])
  })

  it('[spec:process-logs/crlf-output] shows CRLF-terminated lines once, without the carriage return, also when CR and LF arrive in different chunks', () => {
    const s = splitter()
    s.write('one\r\ntwo\r', '\nthree\r\n')
    expect(s.lines).toEqual([
      ['one', false],
      ['two', false],
      ['three', false],
    ])
  })

  it('keeps only the text after the last lone carriage return of a line (progress output)', () => {
    const s = splitter()
    s.write('10%\r20%\r', '30%\rdone\n')
    expect(s.lines).toEqual([['done', false]])
  })

  it('[spec:process-logs/progress-output-without-newline] shows a partial line once the stream has been idle, and continues on a new line', () => {
    const s = splitter()
    s.write('Password: ')
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS - 1)
    expect(s.lines).toEqual([])
    vi.advanceTimersByTime(1)
    expect(s.lines).toEqual([['Password: ', false]])
    // The newline that ends the flushed text does not produce an empty line…
    s.write('\n')
    expect(s.lines).toHaveLength(1)
    // …and later text is a line of its own.
    s.write('next\n')
    expect(s.lines.at(-1)).toEqual(['next', false])
  })

  it('waits for the stream to be idle: data arriving within the delay postpones the flush', () => {
    const s = splitter()
    s.write('a')
    vi.advanceTimersByTime(60)
    s.write('b')
    vi.advanceTimersByTime(60)
    expect(s.lines).toEqual([])
    vi.advanceTimersByTime(40)
    expect(s.lines).toEqual([['ab', false]])
    // Text added after a flush is flushed as another line; a CRLF after it only ends it.
    s.write('c')
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS)
    s.write('\r\n')
    s.write('d\n')
    expect(s.lines).toEqual([
      ['ab', false],
      ['c', false],
      ['d', false],
    ])
  })

  it('flushes a partial line that ends in a carriage return without losing it', () => {
    const s = splitter()
    s.write('50%\r')
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS)
    expect(s.lines).toEqual([['50%', false]])
    s.write('\n60%\n')
    expect(s.lines).toEqual([
      ['50%', false],
      ['60%', false],
    ])
  })

  it('[spec:process-logs/oversized-line] keeps the first 16 KiB of a longer line, marks it truncated, and drops the rest up to the newline', () => {
    const s = splitter()
    const long = 'x'.repeat(MAX_LINE_BYTES + 5000)
    s.write(long.slice(0, 10_000), long.slice(10_000), '\nafter\n')
    expect(s.lines).toEqual([
      ['x'.repeat(MAX_LINE_BYTES), true],
      ['after', false],
    ])
  })

  it('keeps dropping the rest of a truncated line after it was shown as a partial line', () => {
    const s = splitter({ maxBytes: 8 })
    s.write('0123456789')
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS)
    expect(s.lines).toEqual([['01234567', true]])
    s.write('more of the same line')
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS)
    s.write('\nnext\n')
    expect(s.lines).toEqual([
      ['01234567', true],
      ['next', false],
    ])
  })

  it('never cuts a multibyte character when truncating', () => {
    const s = splitter({ maxBytes: 7 })
    // "€" is 3 bytes: only one of them fits after "ab", so the line keeps 5 of the 7 bytes.
    s.write('ab€€€\n')
    expect(s.lines).toEqual([['ab€', true]])
    expect(cutToBytes('ab€', 5, 4)).toBe('ab')
    expect(cutToBytes('a😀', 5, 4)).toBe('a')
    expect(cutToBytes('a😀', 5, 5)).toBe('a😀')
  })

  it('decodes multibyte characters split across chunks', () => {
    const s = splitter()
    const bytes = Buffer.from('größe 😀 ok\n', 'utf8')
    // Every possible split point, one byte at a time.
    s.write(...[...bytes].map((b) => [b]))
    expect(s.lines).toEqual([['größe 😀 ok', false]])
  })

  it('[spec:process-logs/invalid-utf-8] replaces invalid UTF-8 with U+FFFD and keeps capturing', () => {
    const s = splitter()
    s.write([0x61, 0xff, 0x62, 0xc3], [0x28, 0x0a], 'next\n')
    expect(s.lines).toEqual([
      ['a�b�(', false],
      ['next', false],
    ])
  })

  it('emits a pending partial line and an incomplete character at the end of the stream', () => {
    const s = splitter()
    s.write('tail', [0xe2, 0x82])
    s.end()
    expect(s.lines).toEqual([['tail�', false]])
    s.write('ignored\n')
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS)
    expect(s.lines).toHaveLength(1)
  })

  it('keeps back the tail a hold-back rule names when flushing a partial line, and shows it with what follows', () => {
    const lines: [string, boolean][] = []
    const holdBack = (text: string): number => (text.endsWith('sec') ? 3 : 0)
    const s = createLineSplitter((text, truncated) => lines.push([text, truncated]), { holdBack })
    s.write(Buffer.from('token=sec'))
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS)
    expect(lines).toEqual([['token=', false]])
    s.write(Buffer.from('ret\n'))
    expect(lines).toEqual([
      ['token=', false],
      ['secret', false],
    ])
    // A partial line that is all held back stays pending until the stream ends.
    s.write(Buffer.from('sec'))
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS * 3)
    expect(lines).toHaveLength(2)
    s.end()
    expect(lines.at(-1)).toEqual(['sec', false])
  })
})

/** windows-1252 bytes of "café 50 €" (é = E9, € = 80). */
const CP1252_CAFE = [0x63, 0x61, 0x66, 0xe9, 0x20, 0x35, 0x30, 0x20, 0x80]
/** Shift_JIS bytes of "日本語" (synthetic: the runner's code page is 1252). */
const SJIS_NIHONGO = [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]

describe('line splitter with an ANSI fallback (Windows, add-windows-environment-and-commands design D5)', () => {
  it('[spec:process-logs/ansi-output-on-windows] decodes a windows-1252 line with the fallback and the lines around it as UTF-8', () => {
    const s = splitter({ fallbackEncoding: 'windows-1252' })
    s.write('Größe: 1 €\n', [...CP1252_CAFE, 0x0a], 'naïve 😀\n')
    expect(s.lines).toEqual([
      ['Größe: 1 €', false],
      ['café 50 €', false],
      ['naïve 😀', false],
    ])
  })

  it('decides per line, also when a UTF-8 line and an ANSI line arrive in one chunk and lines span chunks', () => {
    const s = splitter({ fallbackEncoding: 'windows-1252' })
    const bytes = Buffer.concat([Buffer.from('größe\n'), Buffer.from(CP1252_CAFE), Buffer.from('\n€ ok\n')])
    // Every possible split point, one byte at a time.
    s.write(...[...bytes].map((b) => [b]))
    expect(s.lines).toEqual([
      ['größe', false],
      ['café 50 €', false],
      ['€ ok', false],
    ])
  })

  it('decodes a Shift_JIS line with a Shift_JIS fallback', () => {
    const s = splitter({ fallbackEncoding: 'shift_jis' })
    s.write([...SJIS_NIHONGO, 0x0d, 0x0a], 'UTF-8: 日本語\n')
    expect(s.lines).toEqual([
      ['日本語', false],
      ['UTF-8: 日本語', false],
    ])
  })

  it('[spec:process-logs/crlf-output] drops the carriage return of CRLF lines, also when CR and LF arrive in different chunks', () => {
    const s = splitter({ fallbackEncoding: 'windows-1252' })
    s.write([...CP1252_CAFE, 0x0d], [0x0a], 'two\r\n')
    expect(s.lines).toEqual([
      ['café 50 €', false],
      ['two', false],
    ])
  })

  it('keeps only the text after the last lone carriage return of a line', () => {
    const s = splitter({ fallbackEncoding: 'windows-1252' })
    s.write([0x31, 0x30, 0x25, 0x0d], [0xe9, 0x0d, 0x64, 0x6f, 0x6e, 0x65, 0xe9, 0x0a])
    expect(s.lines).toEqual([['doneé', false]])
  })

  it('shows a partial line once the stream is idle, decoded the same way, and continues on a new line', () => {
    const s = splitter({ fallbackEncoding: 'windows-1252' })
    s.write(CP1252_CAFE)
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS - 1)
    expect(s.lines).toEqual([])
    vi.advanceTimersByTime(1)
    expect(s.lines).toEqual([['café 50 €', false]])
    // The newline only ends the flushed text.
    s.write('\n')
    expect(s.lines).toHaveLength(1)
    s.write('Größe\n')
    expect(s.lines.at(-1)).toEqual(['Größe', false])
  })

  it('keeps an incomplete UTF-8 character of a partial line back until the rest of it arrives', () => {
    const s = splitter({ fallbackEncoding: 'windows-1252' })
    const euro = Buffer.from('€')
    s.write(Buffer.concat([Buffer.from('cost: '), euro.subarray(0, 2)]))
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS)
    expect(s.lines).toEqual([['cost: ', false]])
    s.write(euro.subarray(2), ' 5\n')
    expect(s.lines).toEqual([
      ['cost: ', false],
      ['€ 5', false],
    ])
  })

  it('keeps an incomplete Shift_JIS character of a partial line back until the rest of it arrives', () => {
    const s = splitter({ fallbackEncoding: 'shift_jis' })
    s.write(SJIS_NIHONGO.slice(0, 3))
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS)
    expect(s.lines).toEqual([['日', false]])
    s.write(SJIS_NIHONGO.slice(3), [0x0a])
    expect(s.lines).toEqual([
      ['日', false],
      ['本語', false],
    ])
  })

  it('starts each partial flush afresh, after one that kept an incomplete Shift_JIS character back', () => {
    const s = splitter({ fallbackEncoding: 'shift_jis' })
    s.write([0x61, 0x93])
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS)
    s.write([0x0a])
    expect(s.lines).toEqual([
      ['a', false],
      ['�', false],
    ])
    // 0x93 followed by 0x96 would be one character: nothing of the first flush may carry over.
    s.write([0x96, 0x7b, 0x8c])
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS)
    expect(s.lines.at(-1)).toEqual(['本', false])
  })

  it('keeps back the tail a hold-back rule names, in a UTF-8 and in an ANSI partial line', () => {
    const holdBack = (text: string): number => (text.endsWith('sec') ? 3 : 0)
    const s = splitter({ fallbackEncoding: 'windows-1252', holdBack })
    s.write('tökén=sec')
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS)
    expect(s.lines).toEqual([['tökén=', false]])
    s.write('ret\n')
    expect(s.lines.at(-1)).toEqual(['secret', false])

    s.write([0xe9, 0x3d, 0x73, 0x65, 0x63])
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS)
    expect(s.lines.at(-1)).toEqual(['é=', false])
    s.write('ret\n')
    expect(s.lines.at(-1)).toEqual(['secret', false])

    // All of it held back: shown when the stream ends.
    s.write('sec')
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS * 3)
    expect(s.lines).toHaveLength(4)
    s.end()
    expect(s.lines.at(-1)).toEqual(['sec', false])
  })

  it('keeps a replacement character and the character that caused it together when holding back', () => {
    // 0x93 starts a Shift_JIS character that "1" (0x31) cannot end: the decoder produces U+FFFD
    // and "1" for the same byte. Holding back one unit keeps both back.
    const holdBack = (text: string): number => (text.endsWith('1') ? 1 : 0)
    const s = splitter({ fallbackEncoding: 'shift_jis', holdBack })
    s.write([0x78, 0x93, 0x31])
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS)
    expect(s.lines).toEqual([['x', false]])
    s.write('\n')
    expect(s.lines).toEqual([
      ['x', false],
      ['�1', false],
    ])
  })

  it('[spec:process-logs/oversized-line] cuts an ANSI line at the byte limit, marks it truncated, and drops the rest up to the newline', () => {
    const s = splitter({ fallbackEncoding: 'windows-1252', maxBytes: 8 })
    s.write([0x61, 0xe9, 0x62, 0x63, 0x64, 0x65, 0x66], [0x67, 0x68, 0x69, 0x0a], 'after\n')
    expect(s.lines).toEqual([
      ['aébcdef', true],
      ['after', false],
    ])
  })

  it('drops the last byte of a cut ANSI line when it looks like the start of a UTF-8 character', () => {
    // 0xC3 is "Ã" in windows-1252, and also a UTF-8 lead byte (design D5: dropped before deciding).
    const s = splitter({ fallbackEncoding: 'windows-1252', maxBytes: 3 })
    s.write([0xe9, 0x61, 0xc3, 0x62, 0x0a])
    expect(s.lines).toEqual([['éa', true]])
  })

  it('drops a UTF-8 character cut by the byte limit', () => {
    const s = splitter({ fallbackEncoding: 'windows-1252', maxBytes: 7 })
    // "€" is 3 bytes: the cut leaves 1 of the second one, which is dropped.
    s.write('ab€€€\n')
    expect(s.lines).toEqual([['ab€', true]])
  })

  it('never shows part of a Shift_JIS character cut by the byte limit', () => {
    // The cut leaves the lead byte of "語": decoded, it is one U+FFFD, but Shift_JIS text never
    // shrinks when decoded, so that character is always beyond the limit and cut again.
    const s = splitter({ fallbackEncoding: 'shift_jis', maxBytes: 5 })
    s.write([...SJIS_NIHONGO, 0x0a])
    expect(s.lines).toEqual([['日', true]])
    const ascii = splitter({ fallbackEncoding: 'shift_jis', maxBytes: 5 })
    ascii.write([0x61, 0x62, 0x63, 0x64, 0x93, 0xfa, 0x0a])
    expect(ascii.lines).toEqual([['abcd', true]])
  })

  it('cuts again a decoded ANSI line whose UTF-8 form exceeds the limit, never through a character', () => {
    // 8 bytes of "€" in windows-1252 decode to 24 UTF-8 bytes.
    const s = splitter({ fallbackEncoding: 'windows-1252', maxBytes: 8 })
    s.write(Array.from({ length: 8 }, () => 0x80), [0x0a])
    expect(s.lines).toEqual([['€€', true]])
    expect(Buffer.byteLength(s.lines[0]?.[0] ?? '')).toBeLessThanOrEqual(8)
  })

  it('truncates a partial line whose decoded text passes the limit, and drops the rest of it (group 5 review)', () => {
    // 4 bytes of "€" decode to 12 UTF-8 bytes: shown cut, then the line continues as a truncated one.
    const s = splitter({ fallbackEncoding: 'windows-1252', maxBytes: 8 })
    s.write([0x80, 0x80, 0x80, 0x80])
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS)
    expect(s.lines).toEqual([['€€', true]])
    s.write('tail\nnext\n')
    expect(s.lines).toEqual([
      ['€€', true],
      ['next', false],
    ])
  })

  it("gives the UTF-8 view of a line decoded with the fallback, and none for a UTF-8 line", () => {
    const views: [string, string | undefined, boolean][] = []
    const s = createLineSplitter((text, truncated, utf8) => views.push([text, utf8, truncated]), { fallbackEncoding: 'windows-1252', maxBytes: 16 })
    s.write(Buffer.from('größe\n'))
    s.write(Buffer.concat([Buffer.from('é'), Buffer.from([0xe9, 0x0a])]))
    // 10 bytes: decoded with the fallback, 20 UTF-8 bytes, cut to 16; the UTF-8 view (14) fits.
    s.write(Buffer.concat([Buffer.from('éééé'), Buffer.from([0xe9, 0xe9, 0x0a])]))
    expect(views).toEqual([
      ['größe', undefined, false],
      ['Ã©é', 'é�', false],
      ['Ã©Ã©Ã©Ã©', 'éééé��', true],
    ])
  })

  it('shows a truncated partial line as it is, and keeps dropping the rest of it', () => {
    const s = splitter({ fallbackEncoding: 'windows-1252', maxBytes: 4 })
    s.write([0xe9, 0x31, 0x32, 0x33, 0x34, 0x35])
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS)
    // The 4 bytes kept decode to "é123", 5 UTF-8 bytes ("é" is 2), so the text is cut to 4.
    expect(s.lines).toEqual([['é12', true]])
    s.write('more')
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS)
    s.write('\nnext\n')
    expect(s.lines).toEqual([
      ['é12', true],
      ['next', false],
    ])
  })

  it('emits a pending partial line at the end of the stream and ignores what follows', () => {
    const s = splitter({ fallbackEncoding: 'windows-1252' })
    s.write(CP1252_CAFE.slice(0, 4))
    s.end()
    expect(s.lines).toEqual([['café', false]])
    s.write('ignored\n')
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS)
    expect(s.lines).toHaveLength(1)
  })

  it('keeps a byte order mark, as the UTF-8-only splitter does', () => {
    const fallback = splitter({ fallbackEncoding: 'windows-1252' })
    const plain = splitter()
    for (const s of [fallback, plain]) s.write([0xef, 0xbb, 0xbf], 'x\n')
    expect(fallback.lines).toEqual([['﻿x', false]])
    expect(fallback.lines).toEqual(plain.lines)
  })

  it('[spec:process-logs/invalid-utf-8] without a fallback, invalid UTF-8 still becomes U+FFFD', () => {
    const s = splitter()
    s.write(CP1252_CAFE, [0x0a])
    expect(s.lines).toEqual([['caf� 50 �', false]])
  })

  it('refuses an encoding this runtime cannot decode', () => {
    expect(isSupportedEncoding('windows-1252')).toBe(true)
    expect(isSupportedEncoding('cp437')).toBe(false)
    expect(() => createLineSplitter(() => undefined, { fallbackEncoding: 'cp437' })).toThrow(RangeError)
  })
})

/** mulberry32: a small deterministic 32-bit generator, so a failing case can be reproduced from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Whether the byte at `at` continues a UTF-8 character (so a chunk ending before it cuts one). */
const insideCharacter = (bytes: Buffer, at: number): boolean => at < bytes.length && ((bytes[at] ?? 0) & 0xc0) === 0x80

describe('line splitter with an ANSI fallback: UTF-8 output is unchanged', () => {
  const pieces = ['a', 'Z', ' ', 'é', '€', '日', '😀', '\r', '\n', '\r\n', '﻿']

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('emits what the UTF-8-only splitter emits, for random UTF-8 output in random chunks and pauses (seed %i)', (seed) => {
    const random = mulberry32(seed)
    for (let round = 0; round < 50; round++) {
      const text = Array.from({ length: Math.floor(random() * 80) }, () => pieces[Math.floor(random() * pieces.length)]).join('')
      const bytes = Buffer.from(text, 'utf8')
      // At least one character's 4 bytes: below that a cut line can keep no character at all,
      // which the real limit (16 KiB) never meets.
      const maxBytes = 4 + Math.floor(random() * 20)
      const plain = splitter({ maxBytes })
      const fallback = splitter({ maxBytes, fallbackEncoding: 'windows-1252' })
      for (let at = 0; at < bytes.length; ) {
        const next = Math.min(bytes.length, at + 1 + Math.floor(random() * 6))
        plain.write(bytes.subarray(at, next))
        fallback.write(bytes.subarray(at, next))
        at = next
        // Sometimes the stream goes idle, so partial lines are flushed too. Only between characters:
        // inside one, the splitters differ on purpose (see the next two tests).
        if (random() < 0.2 && !insideCharacter(bytes, at)) vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS)
      }
      plain.end()
      fallback.end()
      expect(fallback.lines, `seed ${seed}, round ${round}: ${JSON.stringify(text)}`).toEqual(plain.lines)
    }
  })

  it('restarts a line at a lone carriage return as soon as bytes follow it, even before they form a character', () => {
    // The UTF-8-only splitter sees the bytes after `\r` only once they form a character, so an idle
    // flush in between still shows the text the `\r` overwrites. Only that transient text differs.
    const emoji = Buffer.from('😀')
    const plain = splitter()
    const fallback = splitter({ fallbackEncoding: 'windows-1252' })
    for (const s of [plain, fallback]) {
      s.write('50%\r', emoji.subarray(0, 2))
      vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS)
      s.write(emoji.subarray(2), ' done\n')
    }
    expect(plain.lines).toEqual([
      ['50%', false],
      ['😀 done', false],
    ])
    expect(fallback.lines).toEqual([['😀 done', false]])
  })

  it('marks a flushed partial line truncated as soon as its bytes pass the limit, even inside a character', () => {
    const emoji = Buffer.from('😀')
    const plain = splitter({ maxBytes: 5 })
    const fallback = splitter({ maxBytes: 5, fallbackEncoding: 'windows-1252' })
    for (const s of [plain, fallback]) {
      s.write(' €a', emoji.subarray(0, 2))
      vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS)
      s.write(emoji.subarray(2), '\n')
    }
    // The UTF-8-only splitter flushed the 5 bytes before the character was complete; what follows
    // is a new line of its own, within the limit again.
    expect(plain.lines).toEqual([
      [' €a', false],
      ['😀', false],
    ])
    expect(fallback.lines).toEqual([[' €a', true]])
  })

  it.each([1, 2, 3, 4])('never emits more than the byte limit, for random bytes in random chunks (seed %i)', (seed) => {
    const random = mulberry32(seed)
    for (const encoding of ['windows-1252', 'shift_jis', 'gbk', 'big5', 'euc-kr']) {
      const maxBytes = 1 + Math.floor(random() * 32)
      const s = splitter({ maxBytes, fallbackEncoding: encoding })
      const bytes = Buffer.from(Array.from({ length: 2000 }, () => (random() < 0.05 ? 0x0a : Math.floor(random() * 256))))
      for (let at = 0; at < bytes.length; at += 7) s.write(bytes.subarray(at, at + 7))
      s.end()
      expect(s.lines.length).toBeGreaterThan(0)
      for (const [text] of s.lines) expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(maxBytes)
    }
  })

  it('cuts at the real limit: an ANSI line keeps at most 16 KiB of UTF-8 text', () => {
    const s = splitter({ fallbackEncoding: 'windows-1252' })
    s.write(Buffer.alloc(MAX_LINE_BYTES + 100, 0xe9), [0x0a])
    expect(s.lines).toEqual([['é'.repeat(MAX_LINE_BYTES / 2), true]])
  })
})

describe('completeUtf8Length', () => {
  it.each([
    ['empty', [], 0],
    ['ASCII', [0x61, 0x62], 2],
    ['a complete 2-byte character', [0x61, 0xc3, 0xa9], 3],
    ['a lone 2-byte lead', [0x61, 0xc3], 1],
    ['a 3-byte character missing 1 byte', [0x61, 0xe2, 0x82], 1],
    ['a 3-byte character missing 2 bytes', [0x61, 0xe2], 1],
    ['a 4-byte character missing 1 byte', [0xf0, 0x9f, 0x98], 0],
    ['a complete 4-byte character', [0xf0, 0x9f, 0x98, 0x80], 4],
    ['continuation bytes without a lead', [0x61, 0x80, 0x80], 3],
    ['more continuation bytes than any lead announces', [0xf0, 0x80, 0x80, 0x80, 0x80], 5],
    ['a byte that is never a lead (0xC0)', [0x61, 0xc0], 2],
    ['a byte that is never a lead (0xF5)', [0x61, 0xf5, 0x80], 3],
    ['windows-1252 text ending in é', [0x63, 0x61, 0x66, 0xe9], 3],
  ])('%s', (_name, bytes, expected) => {
    expect(completeUtf8Length(Uint8Array.from(bytes))).toBe(expected)
  })
})
