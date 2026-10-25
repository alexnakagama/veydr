// Pure parsers for /proc/net/tcp and /proc/net/tcp6 (proc(5)) and for /proc/<pid>/fd links.
// No I/O here; see `ports.ts`.

export type AddressFamily = 'ipv4' | 'ipv6'

/** One row of /proc/net/tcp or /proc/net/tcp6. */
export interface NetSocket {
  readonly family: AddressFamily
  /** Local address in its usual text form (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`). */
  readonly address: string
  readonly port: number
  /** Kernel TCP state (`include/net/tcp_states.h`), e.g. 0x0A for LISTEN. */
  readonly state: number
  /** Effective user ID of the socket's creator. */
  readonly uid: number
  /** Socket inode, as in `/proc/<pid>/fd/* -> socket:[inode]`; 0 if the socket has none. */
  readonly inode: number
}

export interface ParsedNetTable {
  readonly sockets: readonly NetSocket[]
  /** Rows that did not have the expected format (skipped). */
  readonly malformed: number
}

/** TCP_LISTEN in `include/net/tcp_states.h`. */
export const TCP_LISTEN = 0x0a

/**
 * Whether this machine stores integers little-endian. The kernel prints each 32-bit word of an
 * address as a host-order integer (`%08X`), so the byte order of the text depends on the host.
 */
export const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

const ROW_START = /^\d+:$/
const ADDRESS = /^([0-9A-Fa-f]{8}|[0-9A-Fa-f]{32}):([0-9A-Fa-f]{4})$/
const STATE = /^[0-9A-Fa-f]{2}$/
const DECIMAL = /^\d+$/

/**
 * Parses /proc/net/tcp (`ipv4`) or /proc/net/tcp6 (`ipv6`). The header and blank lines are
 * ignored; rows whose fields do not have the expected format are counted in `malformed`.
 */
export function parseNetTcp(text: string, family: AddressFamily, littleEndian = HOST_LITTLE_ENDIAN): ParsedNetTable {
  const sockets: NetSocket[] = []
  let malformed = 0
  for (const line of text.split('\n')) {
    // sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode …
    const fields = line.trim().split(/\s+/)
    if (!ROW_START.test(fields[0] ?? '')) continue
    const socket = parseRow(fields, family, littleEndian)
    if (socket === null) malformed++
    else sockets.push(socket)
  }
  return { sockets, malformed }
}

function parseRow(fields: readonly string[], family: AddressFamily, littleEndian: boolean): NetSocket | null {
  const [, local, , state, , , , uid, , inode] = fields
  const match = ADDRESS.exec(local ?? '')
  if (match === null || state === undefined || !STATE.test(state)) return null
  const hex = match[1] ?? ''
  if (hex.length !== (family === 'ipv4' ? 8 : 32)) return null
  const uidValue = decimal(uid)
  const inodeValue = decimal(inode)
  if (uidValue === null || inodeValue === null) return null
  const bytes = addressBytes(hex, littleEndian)
  return {
    family,
    address: family === 'ipv4' ? formatIpv4(bytes) : formatIpv6(bytes),
    port: Number.parseInt(match[2] ?? '', 16),
    state: Number.parseInt(state, 16),
    uid: uidValue,
    inode: inodeValue,
  }
}

function decimal(value: string | undefined): number | null {
  if (value === undefined || !DECIMAL.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

/** Network-order bytes of an address printed as host-order 32-bit words. */
function addressBytes(hex: string, littleEndian: boolean): number[] {
  const bytes: number[] = []
  for (let word = 0; word < hex.length; word += 8) {
    const value = Number.parseInt(hex.slice(word, word + 8), 16)
    const big = [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
    bytes.push(...(littleEndian ? big.reverse() : big))
  }
  return bytes
}

function formatIpv4(bytes: readonly number[]): string {
  return bytes.join('.')
}

/**
 * RFC 5952 text form: lowercase, no leading zeros, the longest run of two or more zero groups
 * (the first of equal runs) shortened to `::`, IPv4-mapped addresses as `::ffff:a.b.c.d`.
 */
function formatIpv6(bytes: readonly number[]): string {
  const groups: number[] = []
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0))
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `::ffff:${formatIpv4(bytes.slice(12))}`
  }
  let bestStart = -1
  let bestLength = 1
  for (let start = 0; start < 8; ) {
    if (groups[start] !== 0) {
      start++
      continue
    }
    let end = start
    while (end < 8 && groups[end] === 0) end++
    if (end - start > bestLength) {
      bestStart = start
      bestLength = end - start
    }
    start = end
  }
  const hex = (list: readonly number[]): string => list.map((g) => g.toString(16)).join(':')
  if (bestStart === -1) return hex(groups)
  return `${hex(groups.slice(0, bestStart))}::${hex(groups.slice(bestStart + bestLength))}`
}

const SOCKET_LINK = /^socket:\[(\d+)\]$/

/** The inode of a `/proc/<pid>/fd/<n>` link target `socket:[<inode>]`; `null` for anything else. */
export function socketInode(link: string): number | null {
  const match = SOCKET_LINK.exec(link)
  if (match === null) return null
  const inode = Number(match[1])
  return Number.isSafeInteger(inode) ? inode : null
}
