import { describe, expect, it } from 'vitest'
import {
  encodeControlMessage,
  LineReader,
  MAX_GRACE_MS,
  parseHandshake,
  parseHelperMessage,
  PROTOCOL_VERSION,
  ProtocolError,
  type ProtocolErrorKind,
} from '../../src/main/platform/windows/protocol'

// Version 1 of the helper control protocol (add-windows-process-supervision design D2).

const TOKEN = 'a'.repeat(64)
const CREATED = '134067012345678901'
const member = { pid: 4248, created: CREATED, image: 'C:\\Program Files\\nodejs\\node.exe' }

const line = (value: unknown): string => JSON.stringify(value)

function expectProtocolError(run: () => unknown, kind: ProtocolErrorKind): void {
  let thrown: unknown
  try {
    run()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(ProtocolError)
  expect((thrown as ProtocolError).kind).toBe(kind)
}

describe('helper messages', () => {
  it('parses every message the helper sends', () => {
    const messages = [
      { type: 'started', pid: 4244, created: CREATED },
      { type: 'members', answer: false, members: [member] },
      { type: 'members', answer: true, members: [] },
      { type: 'exited', code: 0, forced: false },
      { type: 'exited', code: 0xc000013a, forced: true },
      { type: 'stopped', graceful: 'yes', forced: false, survivors: [] },
      { type: 'stopped', graceful: 'no', forced: true, survivors: [member] },
      { type: 'error', message: 'CreateProcess failed: the system cannot find the file specified' },
    ]
    for (const message of messages) expect(parseHelperMessage(line(message))).toEqual(message)
  })

  it('accepts a CRLF line ending', () => {
    expect(parseHelperMessage(`${line({ type: 'exited', code: 1, forced: false })}\r`)).toEqual({ type: 'exited', code: 1, forced: false })
  })

  it('rejects lines that are not JSON objects', () => {
    for (const bad of ['', 'not json', '[]', '"started"', 'null', '42', '{"type":"exited","code":0,"forced":false', '{} {}']) {
      expectProtocolError(() => parseHelperMessage(bad), 'malformed')
    }
  })

  it('rejects unknown message types, including the handshake and messages to the helper', () => {
    for (const type of ['ready', 'stop', 'list', 'members ', 'toString', '__proto__', 'constructor']) {
      expectProtocolError(() => parseHelperMessage(line({ type })), 'unknown-message')
    }
    expectProtocolError(() => parseHelperMessage(line({ pid: 1 })), 'unknown-message')
    expectProtocolError(() => parseHelperMessage(line({ type: 3 })), 'unknown-message')
  })

  it('rejects missing, extra, and out-of-range fields', () => {
    const bad = [
      { type: 'started', pid: 4244 },
      { type: 'started', pid: 4244, created: CREATED, extra: true },
      { type: 'started', pid: 0, created: CREATED },
      { type: 'started', pid: 4244.5, created: CREATED },
      { type: 'started', pid: 0x1_0000_0000, created: CREATED },
      { type: 'started', pid: '4244', created: CREATED },
      { type: 'started', pid: 4244, created: 134067012345678901 },
      { type: 'started', pid: 4244, created: '0134067012345678901' },
      { type: 'members', members: [member] },
      { type: 'members', answer: 'yes', members: [member] },
      { type: 'members', answer: false, members: [{ ...member, image: undefined }] },
      { type: 'members', answer: false, members: [{ ...member, commandLine: 'secret' }] },
      { type: 'members', answer: false, members: member },
      { type: 'exited', code: -1, forced: false },
      { type: 'exited', code: 0x1_0000_0000, forced: false },
      { type: 'exited', code: null, forced: false },
      { type: 'exited', code: 0 },
      { type: 'stopped', graceful: 'unsupported', forced: true, survivors: [] },
      { type: 'stopped', graceful: 'yes', forced: 'no', survivors: [] },
      { type: 'stopped', graceful: 'yes', forced: false },
      { type: 'error', message: 'x'.repeat(4097) },
      { type: 'error' },
    ]
    for (const message of bad) expectProtocolError(() => parseHelperMessage(line(message)), 'malformed')
  })
})

describe('handshake', () => {
  const ready = { type: 'ready', version: PROTOCOL_VERSION, token: TOKEN, pid: 4240 }

  it('accepts a ready line with the run token and returns the helper PID', () => {
    expect(parseHandshake(line(ready), TOKEN)).toEqual({ pid: 4240 })
  })

  it('refuses a first line without the run token as not coming from the helper', () => {
    for (const first of [
      line({ ...ready, token: 'b'.repeat(64) }),
      line({ ...ready, token: TOKEN.slice(1) }),
      line({ ...ready, token: `${TOKEN}a` }),
      line({ ...ready, token: undefined }),
      line({ ...ready, type: 'started' }),
      line({ type: 'members', answer: false, members: [] }),
      'garbage',
      '[]',
    ]) {
      expectProtocolError(() => parseHandshake(first, TOKEN), 'bad-token')
    }
  })

  it('reports another protocol version only for the right token', () => {
    expectProtocolError(() => parseHandshake(line({ ...ready, version: 2 }), TOKEN), 'version-mismatch')
    expectProtocolError(() => parseHandshake(line({ ...ready, version: '1' }), TOKEN), 'version-mismatch')
    expectProtocolError(() => parseHandshake(line({ ...ready, version: undefined }), TOKEN), 'version-mismatch')
    expectProtocolError(() => parseHandshake(line({ ...ready, version: 2, token: 'c'.repeat(64) }), TOKEN), 'bad-token')
  })

  it('rejects a malformed ready line from the right helper', () => {
    expectProtocolError(() => parseHandshake(line({ ...ready, pid: 0 }), TOKEN), 'malformed')
    expectProtocolError(() => parseHandshake(line({ ...ready, extra: 1 }), TOKEN), 'malformed')
  })
})

describe('control messages', () => {
  it('encodes stop and list as single lines', () => {
    expect(encodeControlMessage({ type: 'stop', graceMs: 5000 })).toBe('{"type":"stop","graceMs":5000}\n')
    expect(encodeControlMessage({ type: 'stop', graceMs: 0 })).toBe('{"type":"stop","graceMs":0}\n')
    expect(encodeControlMessage({ type: 'list' })).toBe('{"type":"list"}\n')
  })

  it('refuses a grace period the helper cannot represent', () => {
    for (const graceMs of [-1, 1.5, MAX_GRACE_MS + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => encodeControlMessage({ type: 'stop', graceMs }), String(graceMs)).toThrow(RangeError)
    }
    expect(encodeControlMessage({ type: 'stop', graceMs: MAX_GRACE_MS })).toContain(String(MAX_GRACE_MS))
  })
})

describe('line reader', () => {
  it('splits lines across and within chunks', () => {
    const reader = new LineReader(64)
    expect(reader.push(Buffer.from('{"a":'))).toEqual([])
    expect(reader.push(Buffer.from('1}\n{"b":2}\n{"c"'))).toEqual(['{"a":1}', '{"b":2}'])
    expect(reader.push(Buffer.from(':3}\n'))).toEqual(['{"c":3}'])
  })

  it('joins a UTF-8 character split across chunks', () => {
    const bytes = Buffer.from('"C:\\\\Users\\\\Zoë\\\\node.exe"\n')
    const split = bytes.indexOf(0xc3) + 1
    const reader = new LineReader(64)
    expect(reader.push(bytes.subarray(0, split))).toEqual([])
    expect(reader.push(bytes.subarray(split))).toEqual(['"C:\\\\Users\\\\Zoë\\\\node.exe"'])
  })

  it('rejects a line longer than the limit, also before its end arrives', () => {
    expect(new LineReader(4).push(Buffer.from('1234\n'))).toEqual(['1234'])
    expectProtocolError(() => new LineReader(4).push(Buffer.from('12345\n')), 'line-too-long')
    const reader = new LineReader(4)
    reader.push(Buffer.from('123'))
    expectProtocolError(() => reader.push(Buffer.from('45')), 'line-too-long')
  })

  it('rejects invalid UTF-8', () => {
    expectProtocolError(() => new LineReader(64).push(Buffer.from([0x7b, 0xff, 0x7d, 0x0a])), 'malformed')
  })
})
