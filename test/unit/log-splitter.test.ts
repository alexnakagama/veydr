import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLineSplitter, cutToBytes } from '../../src/main/logs/splitter'
import { MAX_LINE_BYTES, PARTIAL_LINE_FLUSH_MS } from '../../src/shared/logs/limits'

type Line = [string, boolean]

function splitter(options: { maxBytes?: number } = {}) {
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
