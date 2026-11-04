import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { isFiletime, isWindowsPid } from './identity'

/**
 * Version 1 of the control protocol between Veydr and `veydr-helper.exe run`
 * (add-windows-process-supervision design D2): UTF-8 JSON objects, one per line (`\n`, an optional
 * preceding `\r` is ignored), over the run's named pipe.
 *
 * Handshake. Veydr spawns `veydr-helper.exe run <pipe> <file> [<arg>...]` with the command's working
 * directory and environment, writes a one-time token as one line on the helper's stdin, and closes
 * it. The helper connects to `<pipe>` and its first line is
 * `{"type":"ready","version":1,"token":"<token>","pid":<helper PID>}`. Veydr closes connections
 * whose first line does not carry the token, and fails the run if the token matches but the version
 * does not. The helper ignores everything Veydr sends before its `ready`.
 *
 * Helper to Veydr, after `ready`:
 * - `{"type":"started","pid":P,"created":"<FILETIME>"}` the command's leader, once;
 * - `{"type":"members","answer":B,"members":[{"pid":P,"created":"<FILETIME>","image":"<path>"}...]}`
 *   the live job members (`image` is the full image path, empty if unreadable): with `answer: false`
 *   on every job change, and with `answer: true` exactly once per `list`, in the order received. The helper answers `list` at
 *   any time until it exits, also while a stop is under way and after `exited` or `stopped`;
 * - `{"type":"exited","code":C,"forced":B}` the leader's exit code (a DWORD), once; `forced` when the
 *   helper had already terminated the job;
 * - `{"type":"stopped","graceful":"yes"|"no","forced":B,"survivors":[member...]}` in answer to `stop`,
 *   after `exited` whenever the leader has ended;
 * - `{"type":"error","message":"..."}` the helper cannot continue (before `started`: the command was
 *   not started).
 *
 * Veydr to helper: `{"type":"stop","graceMs":N}` (at most once per run) and `{"type":"list"}`.
 *
 * Fields are exact: an unknown type or field, a missing field, or an out-of-range value makes the
 * line malformed, and Veydr treats the helper as failed.
 */

export const PROTOCOL_VERSION = 1

/** Longest accepted line in bytes, `\n` excluded (a `members` line for thousands of processes fits). */
export const MAX_LINE_BYTES = 1024 * 1024

/** Longest accepted handshake line: a connection that has not proven itself gets little memory. */
export const MAX_HANDSHAKE_BYTES = 1024

/** Largest `graceMs` the helper accepts (a 32-bit signed millisecond count). */
export const MAX_GRACE_MS = 0x7fff_ffff

export type ProtocolErrorKind = 'malformed' | 'unknown-message' | 'line-too-long' | 'version-mismatch' | 'bad-token'

/** A line that does not follow the protocol. */
export class ProtocolError extends Error {
  override readonly name = 'ProtocolError'

  constructor(
    readonly kind: ProtocolErrorKind,
    message: string,
  ) {
    super(message)
  }
}

const pid = z.custom<number>(isWindowsPid, 'Must be a Windows PID')
const created = z.custom<string>(isFiletime, 'Must be a canonical FILETIME decimal string')
const member = z.strictObject({ pid, created, image: z.string().max(32_767) })
export type HelperMember = z.infer<typeof member>

const helperMessages = {
  started: z.strictObject({ type: z.literal('started'), pid, created }),
  members: z.strictObject({ type: z.literal('members'), answer: z.boolean(), members: z.array(member) }),
  exited: z.strictObject({ type: z.literal('exited'), code: z.int().min(0).max(0xffff_ffff), forced: z.boolean() }),
  stopped: z.strictObject({
    type: z.literal('stopped'),
    graceful: z.enum(['yes', 'no']),
    forced: z.boolean(),
    survivors: z.array(member),
  }),
  error: z.strictObject({ type: z.literal('error'), message: z.string().max(4096) }),
} as const

export type HelperMessage = { [K in keyof typeof helperMessages]: z.infer<(typeof helperMessages)[K]> }[keyof typeof helperMessages]

const handshakeSchema = z.strictObject({
  type: z.literal('ready'),
  version: z.literal(PROTOCOL_VERSION),
  token: z.string(),
  pid,
})

export type ControlMessage = { readonly type: 'stop'; readonly graceMs: number } | { readonly type: 'list' }

/** `line` without the `\r` that a CRLF line ending leaves behind. */
const trimLine = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line)

function parseObject(line: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(trimLine(line))
  } catch {
    throw new ProtocolError('malformed', 'Not a JSON line')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ProtocolError('malformed', 'Not a JSON object')
  return value as Record<string, unknown>
}

const describeIssues = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join('.') || '(line)'}: ${issue.message}`).join('; ')

/** Parses one line the helper sent after its handshake. */
export function parseHelperMessage(line: string): HelperMessage {
  const value = parseObject(line)
  const type = value['type']
  if (typeof type !== 'string' || !Object.hasOwn(helperMessages, type)) {
    throw new ProtocolError('unknown-message', `Unknown message type ${JSON.stringify(type)}`)
  }
  const result = helperMessages[type as keyof typeof helperMessages].safeParse(value)
  if (!result.success) throw new ProtocolError('malformed', `Malformed ${type} message: ${describeIssues(result.error)}`)
  return result.data
}

function tokenMatches(received: string, expected: string): boolean {
  const a = Buffer.from(received, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  // The length of a fixed-size token is no secret; the comparison of its content is constant-time.
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Checks the first line of a connection: a `ready` with `token`. A wrong or missing token is
 * `bad-token` (the peer is not this run's helper); the right token with another protocol version is
 * `version-mismatch`; anything else is `malformed`. Returns the helper's PID.
 */
export function parseHandshake(line: string, token: string): { readonly pid: number } {
  let value: Record<string, unknown>
  try {
    value = parseObject(line)
  } catch {
    throw new ProtocolError('bad-token', 'The first line is not a handshake')
  }
  const received = value['token']
  if (value['type'] !== 'ready' || typeof received !== 'string' || !tokenMatches(received, token)) {
    throw new ProtocolError('bad-token', 'The first line does not carry the run token')
  }
  if (value['version'] !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      'version-mismatch',
      `The Windows helper speaks protocol version ${JSON.stringify(value['version'])}, but Veydr needs version ${PROTOCOL_VERSION}`,
    )
  }
  const result = handshakeSchema.safeParse(value)
  if (!result.success) throw new ProtocolError('malformed', `Malformed ready message: ${describeIssues(result.error)}`)
  return { pid: result.data.pid }
}

/** Encodes a message to the helper as one line, `\n` included. */
export function encodeControlMessage(message: ControlMessage): string {
  switch (message.type) {
    case 'stop':
      if (!Number.isInteger(message.graceMs) || message.graceMs < 0 || message.graceMs > MAX_GRACE_MS) {
        throw new RangeError(`graceMs must be an integer from 0 to ${MAX_GRACE_MS}: ${String(message.graceMs)}`)
      }
      return `${JSON.stringify({ type: 'stop', graceMs: message.graceMs })}\n`
    case 'list':
      return `${JSON.stringify({ type: 'list' })}\n`
  }
}

/**
 * Splits a byte stream into lines of at most `maxBytes` bytes, decoded as strict UTF-8 (a character
 * split across chunks is joined first). Throws `ProtocolError` for a longer line or invalid UTF-8;
 * after that the reader must not be used again.
 */
export class LineReader {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private chunks: Buffer[] = []
  private size = 0

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): string[] {
    const lines: string[] = []
    let start = 0
    for (let end = chunk.indexOf(0x0a); end !== -1; end = chunk.indexOf(0x0a, start)) {
      this.append(chunk.subarray(start, end))
      lines.push(this.take())
      start = end + 1
    }
    this.append(chunk.subarray(start))
    return lines
  }

  private append(part: Buffer): void {
    if (part.length === 0) return
    this.size += part.length
    if (this.size > this.maxBytes) throw new ProtocolError('line-too-long', `A line exceeds ${this.maxBytes} bytes`)
    this.chunks.push(part)
  }

  private take(): string {
    const bytes = Buffer.concat(this.chunks, this.size)
    this.chunks = []
    this.size = 0
    try {
      return this.decoder.decode(bytes)
    } catch {
      throw new ProtocolError('malformed', 'A line is not valid UTF-8')
    }
  }
}
