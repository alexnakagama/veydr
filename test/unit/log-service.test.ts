import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotFoundError } from '../../src/main/errors'
import { createLogService } from '../../src/main/logs/service'
import type { LogBatch } from '../../src/shared/api'
import { BATCH_INTERVAL_MS, PARTIAL_LINE_FLUSH_MS } from '../../src/shared/logs/limits'
import { command } from './support/config'

const CMD = '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01'
const RUN_1 = '00000000-0000-4000-8000-000000000001'
const RUN_2 = '00000000-0000-4000-8000-000000000002'
const RUN_3 = '00000000-0000-4000-8000-000000000003'
const secretEnv = command({ env: [{ key: 'TOKEN', value: 's3cr3t-value', secret: true }] })
const noSecrets = command()

function harness() {
  const sent: LogBatch[] = []
  const events: { level: string; event: string; detail?: Record<string, unknown> }[] = []
  let clock = 1_000
  const logs = createLogService({
    delivery: { active: () => true, send: (batch) => sent.push(batch) },
    now: () => clock,
    log: { record: (level, event, detail) => events.push({ level, event, ...(detail === undefined ? {} : { detail }) }) },
  })
  const out = (runId: string, text: string): void => logs.write(CMD, runId, 'stdout', Buffer.from(text))
  const err = (runId: string, text: string): void => logs.write(CMD, runId, 'stderr', Buffer.from(text))
  return {
    logs,
    sent,
    events,
    out,
    err,
    tick: (ms: number) => {
      clock += ms
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('log service', () => {
  it('[spec:process-logs/stream-distinguished] [spec:process-logs/interleaving-is-approximate] tags lines with their stream and capture time, ordered by capture across streams', () => {
    const h = harness()
    h.logs.open(CMD, RUN_1, noSecrets, null)
    h.out(RUN_1, 'one\n')
    h.tick(5)
    h.err(RUN_1, 'two\n')
    h.tick(5)
    h.out(RUN_1, 'three\n')
    expect(h.logs.read({ runId: RUN_1, fromSeq: 1, limit: 10 })).toEqual({
      runId: RUN_1,
      lines: [
        { seq: 1, stream: 'stdout', at: 1_000, text: 'one', truncated: false },
        { seq: 2, stream: 'stderr', at: 1_005, text: 'two', truncated: false },
        { seq: 3, stream: 'stdout', at: 1_010, text: 'three', truncated: false },
      ],
      firstRetainedSeq: 1,
      nextSeq: 4,
      discarded: 0,
    })
  })

  it('a partial line is numbered when it is shown, after lines of the other stream completed meanwhile', () => {
    const h = harness()
    h.logs.open(CMD, RUN_1, noSecrets, null)
    h.out(RUN_1, 'progress')
    h.err(RUN_1, 'warning\n')
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS)
    expect(h.logs.read({ runId: RUN_1, fromSeq: 1, limit: 10 }).lines.map((l) => [l.seq, l.stream, l.text])).toEqual([
      [1, 'stderr', 'warning'],
      [2, 'stdout', 'progress'],
    ])
  })

  it('redacts secrets before anything is retained or sent, also when a value is split across chunks', () => {
    const h = harness()
    h.logs.open(CMD, RUN_1, secretEnv, null)
    h.out(RUN_1, 'key=s3cr3t-')
    h.out(RUN_1, 'value\n')
    h.err(RUN_1, 's3cr3t-value')
    h.logs.close(CMD, RUN_1, 'stderr')
    vi.advanceTimersByTime(BATCH_INTERVAL_MS)
    const read = h.logs.read({ runId: RUN_1, fromSeq: 1, limit: 10 })
    expect(read.lines.map((l) => l.text)).toEqual(['key=[redacted]', '[redacted]'])
    expect(JSON.stringify(h.sent)).not.toContain('s3cr3t')
  })

  it('redacts a secret printed in two parts with a pause longer than the partial-line delay (L6-04)', () => {
    const h = harness()
    h.logs.open(CMD, RUN_1, secretEnv, null)
    h.out(RUN_1, 'token=s3cr3t')
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS * 3)
    h.out(RUN_1, '-value and more\n')
    expect(h.logs.read({ runId: RUN_1, fromSeq: 1, limit: 10 }).lines.map((l) => l.text)).toEqual(['token=', '[redacted] and more'])
  })

  it("[spec:process-logs/ansi-output-on-windows] decodes each stream's lines that are not UTF-8 with the run's fallback encoding", () => {
    const h = harness()
    h.logs.open(CMD, RUN_1, noSecrets, 'windows-1252')
    h.logs.write(CMD, RUN_1, 'stdout', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
    h.logs.write(CMD, RUN_1, 'stderr', Buffer.from('Größe\n'))
    h.logs.write(CMD, RUN_1, 'stderr', Buffer.from([0x80, 0x0a]))
    expect(h.logs.read({ runId: RUN_1, fromSeq: 1, limit: 10 }).lines.map((l) => [l.stream, l.text])).toEqual([
      ['stdout', 'café'],
      ['stderr', 'Größe'],
      ['stderr', '€'],
    ])
    expect(h.events).toEqual([])
  })

  it('redacts a secret in a line decoded with the fallback, also when it is printed in two parts', () => {
    const h = harness()
    h.logs.open(CMD, RUN_1, secretEnv, 'windows-1252')
    h.logs.write(CMD, RUN_1, 'stdout', Buffer.from([0xe9, ...Buffer.from('=s3cr3t')]))
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS * 3)
    h.logs.write(CMD, RUN_1, 'stdout', Buffer.from('-value\n'))
    expect(h.logs.read({ runId: RUN_1, fromSeq: 1, limit: 10 }).lines.map((l) => l.text)).toEqual(['é=', '[redacted]'])
  })

  it('redacts a secret printed in UTF-8 on a line that the fallback decodes, because of another byte (group 5 review)', () => {
    const h = harness()
    const env = command({ env: [{ key: 'TOKEN', value: 'café-secret', secret: true }] })
    h.logs.open(CMD, RUN_1, env, 'windows-1252')
    // "key=café-secret " in UTF-8, then a stray windows-1252 "é": the fallback would show "cafÃ©".
    h.logs.write(CMD, RUN_1, 'stdout', Buffer.concat([Buffer.from('key=café-secret '), Buffer.from([0xe9, 0x0a])]))
    // An ANSI line without a secret is still decoded with the fallback.
    h.logs.write(CMD, RUN_1, 'stdout', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
    expect(h.logs.read({ runId: RUN_1, fromSeq: 1, limit: 10 }).lines.map((l) => l.text)).toEqual(['key=[redacted] �', 'café'])
  })

  it('redacts a secret whose first character a Shift_JIS lead byte would swallow (group 5 review)', () => {
    const h = harness()
    const env = command({ env: [{ key: 'TOKEN', value: 'secret1234', secret: true }] })
    h.logs.open(CMD, RUN_1, env, 'shift_jis')
    h.logs.write(CMD, RUN_1, 'stdout', Buffer.concat([Buffer.from([0x81]), Buffer.from('secret1234\n')]))
    const [line] = h.logs.read({ runId: RUN_1, fromSeq: 1, limit: 10 }).lines
    expect(line?.text).toBe('�[redacted]')
  })

  it('keeps back the start of a UTF-8 secret at a pause in a line the fallback decodes (group 5 review)', () => {
    const h = harness()
    const env = command({ env: [{ key: 'TOKEN', value: 'café-secret', secret: true }] })
    h.logs.open(CMD, RUN_1, env, 'windows-1252')
    h.logs.write(CMD, RUN_1, 'stdout', Buffer.concat([Buffer.from([0xe9]), Buffer.from(' token=café-se')]))
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS * 3)
    h.logs.write(CMD, RUN_1, 'stdout', Buffer.from('cret\n'))
    const texts = h.logs.read({ runId: RUN_1, fromSeq: 1, limit: 10 }).lines.map((l) => l.text)
    expect(texts).toEqual(['é token=', '[redacted]'])
    expect(JSON.stringify(texts)).not.toMatch(/caf/)
  })

  it('keeps back the start of a UTF-8 secret when the pause falls inside its next character (group 5 re-review)', () => {
    const h = harness()
    const env = command({ env: [{ key: 'TOKEN', value: 'abcdé123', secret: true }] })
    h.logs.open(CMD, RUN_1, env, 'windows-1252')
    // An ANSI "é" first, then "abcd" and the first byte of a UTF-8 "é".
    h.logs.write(CMD, RUN_1, 'stdout', Buffer.from([0xe9, 0x20, 0x61, 0x62, 0x63, 0x64, 0xc3]))
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS * 3)
    h.logs.write(CMD, RUN_1, 'stdout', Buffer.concat([Buffer.from([0xa9]), Buffer.from('123\n')]))
    const texts = h.logs.read({ runId: RUN_1, fromSeq: 1, limit: 10 }).lines.map((l) => l.text)
    expect(texts).toEqual(['é ', '[redacted]'])
  })

  it('logs a fallback encoding this runtime cannot decode, and still captures the run as UTF-8', () => {
    const h = harness()
    h.logs.open(CMD, RUN_1, noSecrets, 'cp437')
    h.logs.write(CMD, RUN_1, 'stdout', Buffer.from([0x61, 0xff, 0x0a]))
    expect(h.logs.read({ runId: RUN_1, fromSeq: 1, limit: 10 }).lines.map((l) => l.text)).toEqual(['a�'])
    expect(h.events).toEqual([{ level: 'warn', event: 'logs.fallback-encoding-unsupported', detail: { commandId: CMD, runId: RUN_1, encoding: 'cp437' } }])
  })

  it('keeps output of the current and previous run, and ignores output of a run no longer retained', () => {
    const h = harness()
    h.logs.open(CMD, RUN_1, noSecrets, null)
    h.out(RUN_1, 'first\n')
    h.logs.open(CMD, RUN_2, noSecrets, null)
    h.logs.open(CMD, RUN_3, noSecrets, null)
    // Run 1's descendants may still write (its pipes are open): nothing is kept or sent.
    h.out(RUN_1, 'late\n')
    vi.advanceTimersByTime(BATCH_INTERVAL_MS)
    expect(() => h.logs.read({ runId: RUN_1, fromSeq: 1, limit: 1 })).toThrow(NotFoundError)
    expect(h.sent.flatMap((b) => b.lines.map((l) => l.text))).toEqual(['first'])
    expect(h.logs.read({ runId: RUN_2, fromSeq: 1, limit: 1 }).lines).toEqual([])
    expect(h.logs.store.totalBytes()).toBe(0)
  })

  it('emits the final partial line when a stream closes and ignores output after that', () => {
    const h = harness()
    h.logs.open(CMD, RUN_1, noSecrets, null)
    h.out(RUN_1, 'no newline at the end')
    h.logs.close(CMD, RUN_1, 'stdout')
    h.out(RUN_1, 'after close\n')
    expect(h.logs.read({ runId: RUN_1, fromSeq: 1, limit: 10 }).lines.map((l) => l.text)).toEqual(['no newline at the end'])
  })

  it('clears a run: retained and not yet delivered lines go, capture continues', () => {
    const h = harness()
    h.logs.open(CMD, RUN_1, noSecrets, null)
    h.out(RUN_1, 'a\nb\n')
    expect(h.logs.clear(RUN_1)).toEqual({ clearedThroughSeq: 2 })
    h.out(RUN_1, 'c\n')
    vi.advanceTimersByTime(BATCH_INTERVAL_MS)
    expect(h.sent.flatMap((b) => b.lines.map((l) => [l.seq, l.text]))).toEqual([[3, 'c']])
    expect(h.logs.read({ runId: RUN_1, fromSeq: 1, limit: 10 })).toMatchObject({ firstRetainedSeq: 3, nextSeq: 4, lines: [{ seq: 3 }] })
    expect(() => h.logs.clear(RUN_2)).toThrow(NotFoundError)
  })

  it('reads in pages from any seq and reports discarded lines', () => {
    const h = harness()
    h.logs.open(CMD, RUN_1, noSecrets, null)
    h.out(RUN_1, Array.from({ length: 10_005 }, (_, i) => `${i + 1}\n`).join(''))
    const page = h.logs.read({ runId: RUN_1, fromSeq: 1, limit: 3 })
    expect(page).toMatchObject({ firstRetainedSeq: 6, nextSeq: 10_006, discarded: 5 })
    expect(page.lines.map((l) => l.text)).toEqual(['6', '7', '8'])
    expect(h.logs.read({ runId: RUN_1, fromSeq: 10_004, limit: 5 }).lines.map((l) => l.seq)).toEqual([10_004, 10_005])
  })
})
