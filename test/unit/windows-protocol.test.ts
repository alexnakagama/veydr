import { describe, expect, it } from 'vitest'
import {
  encodeControlMessage,
  encodeIdentities,
  encodeRunRequest,
  LineReader,
  MAX_GRACE_MS,
  MAX_RUN_REQUEST_BYTES,
  MAX_TOOL_IDENTITIES,
  parseHandshake,
  parseHelperMessage,
  parseInspectOutput,
  parseTerminateOutput,
  PROTOCOL_VERSION,
  ProtocolError,
  type ProtocolErrorKind,
} from '../../src/main/platform/windows/protocol'

// Version 2 of the helper control protocol (add-windows-process-supervision design D2,
// add-windows-environment-and-commands designs D1 and D5).

const TOKEN = 'a'.repeat(64)
const CREATED = '134067012345678901'
const member = { pid: 4248, created: CREATED, image: 'C:\\Program Files\\nodejs\\node.exe' }

const CONSOLE = { utf8Console: true, ansiCodePage: 1252 }
const started = { type: 'started', pid: 4244, created: CREATED, ...CONSOLE }

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
      started,
      { ...started, utf8Console: false, ansiCodePage: 932, consoleError: 'could not attach to the command\'s console: The handle is invalid. (error 6)' },
      { ...started, ansiCodePage: 65001 },
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
      { type: 'started', pid: 4244, ...CONSOLE },
      // Version 1's started line, without the console fields.
      { type: 'started', pid: 4244, created: CREATED },
      { ...started, extra: true },
      { ...started, pid: 0 },
      { ...started, pid: 4244.5 },
      { ...started, pid: 0x1_0000_0000 },
      { ...started, pid: '4244' },
      { ...started, created: 134067012345678901 },
      { ...started, created: '0134067012345678901' },
      { ...started, utf8Console: 'true' },
      { ...started, utf8Console: undefined },
      { ...started, ansiCodePage: 0 },
      { ...started, ansiCodePage: 0x1_0000 },
      { ...started, ansiCodePage: 1252.5 },
      { ...started, ansiCodePage: undefined },
      // The reason comes exactly with a console that is not UTF-8.
      { ...started, consoleError: 'unexpected' },
      { ...started, utf8Console: false },
      { ...started, utf8Console: false, consoleError: 'x'.repeat(4097) },
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
    expect(PROTOCOL_VERSION).toBe(2)
    // A version 1 helper (W1) is refused, by name, as any other version is.
    expect(() => parseHandshake(line({ ...ready, version: 1 }), TOKEN)).toThrow('The Windows helper speaks protocol version 1, but Veydr needs version 2')
    expectProtocolError(() => parseHandshake(line({ ...ready, version: 1 }), TOKEN), 'version-mismatch')
    expectProtocolError(() => parseHandshake(line({ ...ready, version: 3 }), TOKEN), 'version-mismatch')
    expectProtocolError(() => parseHandshake(line({ ...ready, version: '2' }), TOKEN), 'version-mismatch')
    expectProtocolError(() => parseHandshake(line({ ...ready, version: undefined }), TOKEN), 'version-mismatch')
    expectProtocolError(() => parseHandshake(line({ ...ready, version: 1, token: 'c'.repeat(64) }), TOKEN), 'bad-token')
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

describe('run request', () => {
  const application = 'C:\\Program Files\\nodejs\\node.exe'

  it('is one line with the two fields in a fixed order and no whitespace', () => {
    expect(encodeRunRequest({ application: 'C:\\a.exe', commandLine: '"C:\\a.exe" x' })).toBe('{"application":"C:\\\\a.exe","commandLine":"\\"C:\\\\a.exe\\" x"}\n')
    // Fields beyond the two are not passed on.
    const extra = { commandLine: 'b', application: 'a', secret: 'x' } as { application: string; commandLine: string }
    expect(encodeRunRequest(extra)).toBe('{"application":"a","commandLine":"b"}\n')
  })

  it('escapes quotes, backslashes and every control character, and writes other characters as UTF-8', () => {
    const controls = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)).filter((c) => c !== '\0').join('')
    const commandLine = `"${application}" "a \\"b\\" c\\\\" ${controls} \u007f é € 😀 \u2028`
    const encoded = encodeRunRequest({ application, commandLine })
    expect(encoded.endsWith('\n')).toBe(true)
    expect(encoded.slice(0, -1)).not.toMatch(/[\u0000-\u001f]/)
    // The escapes the helper's parser reads; a non-BMP character stays one UTF-8 sequence.
    expect(encoded).toContain('\\b\\t\\n\\u000b\\f\\r')
    expect(encoded).toContain('😀')
    expect(Buffer.from(encoded, 'utf8').includes(Buffer.from([0xf0, 0x9f, 0x98, 0x80]))).toBe(true)
    expect(JSON.parse(encoded)).toEqual({ application, commandLine })
  })

  it('refuses NUL and lone surrogates, which the helper refuses too', () => {
    for (const bad of ['a\0b', 'a\ud800b', 'a\udc00', '\ud83d']) {
      expect(() => encodeRunRequest({ application, commandLine: bad }), JSON.stringify(bad)).toThrow(RangeError)
      expect(() => encodeRunRequest({ application: bad, commandLine: 'x' }), JSON.stringify(bad)).toThrow(RangeError)
    }
  })

  it('refuses a request beyond the helper\'s limit, counted in UTF-8 bytes', () => {
    const fits = 'x'.repeat(MAX_RUN_REQUEST_BYTES - '{"application":"a","commandLine":""}'.length)
    expect(Buffer.byteLength(encodeRunRequest({ application: 'a', commandLine: fits })) - 1).toBe(MAX_RUN_REQUEST_BYTES)
    expect(() => encodeRunRequest({ application: 'a', commandLine: `${fits}x` })).toThrow(/more than the 1048576/)
    // Escaped control characters take six bytes each.
    expect(() => encodeRunRequest({ application: 'a', commandLine: '\u0001'.repeat(MAX_RUN_REQUEST_BYTES / 6 + 1) })).toThrow(RangeError)
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

describe('survivor subcommands', () => {
  it('encodes identities as one line in the exact form the helper accepts', () => {
    expect(encodeIdentities([])).toBe('[]\n')
    // Fields beyond pid and created are not passed on, and the key order is fixed.
    const extra = { created: CREATED, image: 'x', pid: 4248 } as { pid: number; created: string }
    expect(encodeIdentities([extra, { pid: 0xffff_ffff, created: '1' }])).toBe(
      `[{"pid":4248,"created":"${CREATED}"},{"pid":4294967295,"created":"1"}]\n`,
    )
  })

  it('refuses identities the helper could not read, and too many of them', () => {
    for (const bad of [{ pid: 0, created: CREATED }, { pid: 2 ** 32, created: CREATED }, { pid: 1.5, created: CREATED }, { pid: 4, created: '0' }, { pid: 4, created: '01' }, { pid: 4, created: '9223372036854775808' }]) {
      expect(() => encodeIdentities([bad]), JSON.stringify(bad)).toThrow(RangeError)
    }
    expect(() => encodeIdentities(Array.from({ length: MAX_TOOL_IDENTITIES + 1 }, () => ({ pid: 4, created: CREATED })))).toThrow(RangeError)
  })

  it('parses the inspect and terminate output lines', () => {
    expect(parseInspectOutput(`${line({ type: 'inspected', processes: [member] })}\n`)).toEqual({ type: 'inspected', processes: [member] })
    expect(parseInspectOutput(`${line({ type: 'inspected', processes: [] })}\r\n`)).toEqual({ type: 'inspected', processes: [] })
    const terminated = { type: 'terminated', graceful: 'no', forced: true, survivors: [member] }
    expect(parseTerminateOutput(`${line(terminated)}\n`)).toEqual(terminated)
  })

  it('rejects output that is not exactly one well-formed line of the expected type', () => {
    const inspected = line({ type: 'inspected', processes: [] })
    const cases: [() => unknown, ProtocolErrorKind][] = [
      [() => parseInspectOutput(''), 'malformed'],
      [() => parseInspectOutput(inspected), 'malformed'],
      [() => parseInspectOutput(`${inspected}\n${inspected}\n`), 'malformed'],
      [() => parseInspectOutput('not json\n'), 'malformed'],
      [() => parseInspectOutput(`${line({ type: 'terminated', graceful: 'yes', forced: false, survivors: [] })}\n`), 'unknown-message'],
      [() => parseInspectOutput(`${line({ type: 'inspected', processes: [], extra: 1 })}\n`), 'malformed'],
      [() => parseInspectOutput(`${line({ type: 'inspected', processes: [{ ...member, created: '0' }] })}\n`), 'malformed'],
      [() => parseTerminateOutput(`${line({ type: 'terminated', graceful: 'unsupported', forced: false, survivors: [] })}\n`), 'malformed'],
      [() => parseTerminateOutput(`${line({ type: 'terminated', graceful: 'yes', survivors: [] })}\n`), 'malformed'],
      [() => parseTerminateOutput(`${inspected}\n`), 'unknown-message'],
    ]
    for (const [run, kind] of cases) expectProtocolError(run, kind)
  })
})
