import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { isFiletime, isWindowsPid, MAX_WINDOWS_PID } from './identity'

/**
 * Version 3 of the protocol between Veydr and `veydr-helper.exe` (add-windows-process-supervision
 * design D2, add-windows-environment-and-commands design D1 and D5, add-windows-port-inspection
 * design D2, which added the `ports` subcommand below; `run`, `inspect` and `terminate` are as in
 * version 2).
 *
 * The control protocol of `veydr-helper.exe run`: UTF-8 JSON objects, one per line (`\n`, an
 * optional preceding `\r` is ignored), over the run's named pipe.
 *
 * Handshake. Veydr spawns `veydr-helper.exe run <pipe>` with the command's working directory and
 * environment, and writes two lines on the helper's stdin before closing it: a one-time token, and
 * the run request `{"application":"<program>","commandLine":"<command line>"}` (`encodeRunRequest`).
 * Neither appears on the helper's own command line. The helper reads the token, connects to
 * `<pipe>`, and its first line is `{"type":"ready","version":3,"token":"<token>","pid":<helper PID>}`.
 * Only then does it read the run request, so every refusal of the request is an `error` line on the
 * pipe and never on stderr, which belongs to the command. Veydr closes connections whose first line
 * does not carry the token, and fails the run if the token matches but the version does not. The
 * helper ignores everything Veydr sends before its `ready`.
 *
 * Helper to Veydr, after `ready`:
 * - `{"type":"started","pid":P,"created":"<FILETIME>","utf8Console":B,"ansiCodePage":N}` the
 *   command's leader, once. `utf8Console` says whether the command's console was set to output code
 *   page 65001 before it ran, and `ansiCodePage` is the system's ANSI code page (`GetACP`). When
 *   `utf8Console` is false, `"consoleError":"..."` says why;
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

export const PROTOCOL_VERSION = 3

/**
 * Longest run request the helper reads, in bytes, `\n` excluded. Escaping can make a command line
 * of `MAX_COMMAND_LINE` characters about six times longer, so this is the helper's own limit,
 * separate from the token line's.
 */
export const MAX_RUN_REQUEST_BYTES = 1024 * 1024

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

const started = z
  .strictObject({
    type: z.literal('started'),
    pid,
    created,
    utf8Console: z.boolean(),
    // A Windows code page identifier (a 16-bit value; 0 is CP_ACP itself, never a code page).
    ansiCodePage: z.int().min(1).max(0xffff),
    consoleError: z.string().max(4096).optional(),
  })
  .refine((message) => message.utf8Console === (message.consoleError === undefined), {
    message: 'consoleError must be present exactly when utf8Console is false',
    path: ['consoleError'],
  })

const helperMessages = {
  started,
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

/** Most issues named in an error message; a large malformed line must not make a huge one. */
const MAX_DESCRIBED_ISSUES = 5

function describeIssues(error: z.ZodError): string {
  const shown = error.issues.slice(0, MAX_DESCRIBED_ISSUES).map((issue) => `${issue.path.join('.') || '(line)'}: ${issue.message}`)
  const more = error.issues.length - shown.length
  return `${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''}`
}

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

/**
 * The run request, the second line on the helper's stdin, `\n` included (design D1). The key order
 * is fixed and there is no whitespace, the only form the helper's strict parser accepts.
 * `JSON.stringify` escapes `"`, `\` and control characters, and writes every other character as
 * UTF-8; a lone surrogate (which it would write as `\uD800`) or NUL never reaches here, since
 * `helperLaunch` refuses them, but they are refused again because the helper refuses them too.
 */
export function encodeRunRequest(launch: { readonly application: string; readonly commandLine: string }): string {
  for (const [name, value] of [
    ['application', launch.application],
    ['commandLine', launch.commandLine],
  ] as const) {
    if (value.includes('\0')) throw new RangeError(`The run request's ${name} contains a NUL character`)
    if (/[\uD800-\uDFFF]/u.test(value)) throw new RangeError(`The run request's ${name} contains an unpaired UTF-16 surrogate`)
  }
  const line = JSON.stringify({ application: launch.application, commandLine: launch.commandLine })
  const bytes = Buffer.byteLength(line, 'utf8')
  if (bytes > MAX_RUN_REQUEST_BYTES) throw new RangeError(`The run request has ${bytes} bytes, more than the ${MAX_RUN_REQUEST_BYTES} the helper reads`)
  return `${line}\n`
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

/*
 * Survivor subcommands (design D4). Unlike `run`, these are short-lived and talk over stdio: Veydr
 * writes one line on stdin, a JSON array of identities exactly as `encodeIdentities` produces it
 * (ASCII, no byte order mark), and closes stdin; the helper prints one line on stdout and exits
 * with 0.
 *
 * - `veydr-helper.exe inspect` prints `{"type":"inspected","processes":[member...]}`: the live
 *   processes whose PID and creation time both match a requested identity. Nothing is opened for
 *   writing.
 * - `veydr-helper.exe terminate <graceMs>` prints
 *   `{"type":"terminated","graceful":"yes"|"no","forced":B,"survivors":[member...]}`: it ends the
 *   requested processes that still match, Ctrl+Break first where a console holds nothing else.
 *
 * Every reported process must be one that was requested; anything else is a helper failure.
 */

/** Most identities in one `inspect` or `terminate` call; the helper refuses more. */
export const MAX_TOOL_IDENTITIES = 65_536

/** Longest accepted output of `inspect` or `terminate`, in bytes. */
export const MAX_TOOL_OUTPUT_BYTES = 8 * 1024 * 1024

export interface WindowsProcessRef {
  readonly pid: number
  readonly created: string
}

/*
 * Port inspection (add-windows-port-inspection design D1 and D2). `veydr-helper.exe ports` takes no
 * arguments and reads nothing on stdin. It prints one line and exits with 0:
 *
 *   {"type":"ports","takenAt":"<FILETIME>","listeners":[listener...],"owners":[owner...]}
 *
 * - `takenAt` is the fence: the time read before the tables;
 * - a listener is `{"family":"ipv4"|"ipv6","address":"<hex>","port":N,"pid":P}`, the address as 8
 *   (IPv4) or 32 (IPv6) lowercase hex digits in network byte order, the port 1–65535;
 * - an owner, exactly one per listener PID, is `{"pid":P,"state":"known","created":"<FILETIME>",
 *   "image":"<path>"}`, `{"pid":P,"state":"restricted"|"gone"|"reused"}`, or
 *   `{"pid":P,"state":"error","code":N}` with the Win32 error code (never 0, which means success).
 *   PID 0 (no owning process) is allowed, so one odd row never fails the listing, and is always
 *   `gone`. A `known` owner was created at least FENCE_MARGIN before `takenAt`, else it is `reused`.
 *
 * The helper drops a table row with port 0: a listening socket always has a port.
 */

/** The helper's fence margin, 20 ms in FILETIME units (design D1). */
export const FENCE_MARGIN = 200_000n

/** Longest accepted output of `ports`, in bytes: about 250,000 listeners (design D2). */
export const MAX_PORTS_OUTPUT_BYTES = 16 * 1024 * 1024

/** A listener's or owner's PID: a Windows PID, or 0 for a socket with no owning process. */
const portPid = z.int().min(0).max(MAX_WINDOWS_PID)
const port = z.int().min(1).max(0xffff)
const listener = z.discriminatedUnion('family', [
  z.strictObject({ family: z.literal('ipv4'), address: z.string().regex(/^[0-9a-f]{8}$/, 'Must be 8 lowercase hex digits'), port, pid: portPid }),
  z.strictObject({ family: z.literal('ipv6'), address: z.string().regex(/^[0-9a-f]{32}$/, 'Must be 32 lowercase hex digits'), port, pid: portPid }),
])
const owner = z
  .discriminatedUnion('state', [
    z.strictObject({ pid, state: z.literal('known'), created, image: z.string().max(32_767) }),
    z.strictObject({ pid: portPid, state: z.literal('restricted') }),
    z.strictObject({ pid: portPid, state: z.literal('gone') }),
    z.strictObject({ pid: portPid, state: z.literal('reused') }),
    z.strictObject({ pid: portPid, state: z.literal('error'), code: z.int().min(1).max(0xffff_ffff) }),
  ])
  .refine((entry) => entry.pid !== 0 || entry.state === 'gone', { message: 'PID 0 has no owning process and must be gone' })
export type PortsListener = z.infer<typeof listener>
export type PortsOwner = z.infer<typeof owner>

const ports = z
  .strictObject({ type: z.literal('ports'), takenAt: created, listeners: z.array(listener), owners: z.array(owner) })
  .superRefine((message, context) => {
    const owners = new Set<number>()
    const fence = BigInt(message.takenAt) - FENCE_MARGIN
    message.owners.forEach((entry, index) => {
      // The fence is what makes `known` safe: a younger owner may hold a reused PID.
      if (entry.state === 'known' && BigInt(entry.created) > fence) {
        context.addIssue({ code: 'custom', path: ['owners', index, 'created'], message: `PID ${entry.pid} was created after the fence and cannot be known` })
      }
      if (owners.has(entry.pid)) context.addIssue({ code: 'custom', path: ['owners', index, 'pid'], message: `PID ${entry.pid} has more than one owner entry` })
      owners.add(entry.pid)
    })
    const listened = new Set<number>()
    message.listeners.forEach((entry, index) => {
      listened.add(entry.pid)
      if (!owners.has(entry.pid)) context.addIssue({ code: 'custom', path: ['listeners', index, 'pid'], message: `PID ${entry.pid} has no owner entry` })
    })
    message.owners.forEach((entry, index) => {
      if (!listened.has(entry.pid)) context.addIssue({ code: 'custom', path: ['owners', index, 'pid'], message: `PID ${entry.pid} holds no listener` })
    })
  })

const toolMessages = {
  inspected: z.strictObject({ type: z.literal('inspected'), processes: z.array(member) }),
  terminated: z.strictObject({
    type: z.literal('terminated'),
    graceful: z.enum(['yes', 'no']),
    forced: z.boolean(),
    survivors: z.array(member),
  }),
  ports,
} as const

export type InspectResult = z.infer<(typeof toolMessages)['inspected']>
export type TerminateResult = z.infer<(typeof toolMessages)['terminated']>
export type PortsResult = z.infer<(typeof toolMessages)['ports']>

/** The stdin line of `inspect` and `terminate`, `\n` included. */
export function encodeIdentities(identities: readonly WindowsProcessRef[]): string {
  if (identities.length > MAX_TOOL_IDENTITIES) throw new RangeError(`At most ${MAX_TOOL_IDENTITIES} identities per call: ${identities.length}`)
  for (const identity of identities) {
    if (!isWindowsPid(identity.pid) || !isFiletime(identity.created)) {
      throw new RangeError(`Not a Windows process identity: ${JSON.stringify(identity)}`)
    }
  }
  // Key order and spacing are fixed: the helper accepts exactly this form.
  return `${JSON.stringify(identities.map(({ pid, created }) => ({ pid, created })))}\n`
}

/** The single output line of a subcommand: exactly one line, ended by `\n` (or `\r\n`). */
function toolLine(output: string, type: keyof typeof toolMessages): Record<string, unknown> {
  if (!output.endsWith('\n')) throw new ProtocolError('malformed', `The ${type} output is not one complete line`)
  const line = output.slice(0, -1)
  if (line.includes('\n')) throw new ProtocolError('malformed', `The ${type} output has more than one line`)
  const value = parseObject(line)
  if (value['type'] !== type) throw new ProtocolError('unknown-message', `Expected ${type}, got ${JSON.stringify(value['type'])}`)
  return value
}

/** Parses what `veydr-helper.exe inspect` printed. */
export function parseInspectOutput(output: string): InspectResult {
  const result = toolMessages.inspected.safeParse(toolLine(output, 'inspected'))
  if (!result.success) throw new ProtocolError('malformed', `Malformed inspected output: ${describeIssues(result.error)}`)
  return result.data
}

/** Parses what `veydr-helper.exe terminate` printed. */
export function parseTerminateOutput(output: string): TerminateResult {
  const result = toolMessages.terminated.safeParse(toolLine(output, 'terminated'))
  if (!result.success) throw new ProtocolError('malformed', `Malformed terminated output: ${describeIssues(result.error)}`)
  return result.data
}

/**
 * Parses what `veydr-helper.exe ports` printed. The line may be up to MAX_PORTS_OUTPUT_BYTES long,
 * the same limit the reader applies to the helper's stdout, not MAX_LINE_BYTES.
 */
export function parsePortsOutput(output: string): PortsResult {
  const bytes = Buffer.byteLength(output, 'utf8')
  if (bytes > MAX_PORTS_OUTPUT_BYTES) throw new ProtocolError('line-too-long', `The ports output has ${bytes} bytes, more than ${MAX_PORTS_OUTPUT_BYTES}`)
  const result = toolMessages.ports.safeParse(toolLine(output, 'ports'))
  if (!result.success) throw new ProtocolError('malformed', `Malformed ports output: ${describeIssues(result.error)}`)
  return result.data
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
