// IP address text forms, shared by the Linux and Windows port inspectors (add-windows-port-inspection
// design D5), so that the same address reads the same on both systems. Both functions take the
// address's bytes in network order; each inspector turns its own source into those bytes first.
// No I/O here.

/** Throws unless `bytes` holds exactly `length` integers from 0 to 255. */
function requireBytes(bytes: readonly number[], length: number, what: string): void {
  if (bytes.length !== length || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 0xff)) {
    throw new RangeError(`${what} needs ${length} bytes from 0 to 255`)
  }
}

/** Dotted-decimal text form of an IPv4 address, e.g. `127.0.0.1`, from its 4 network-order bytes. */
export function formatIpv4(bytes: readonly number[]): string {
  requireBytes(bytes, 4, 'An IPv4 address')
  return bytes.join('.')
}

/**
 * RFC 5952 text form of an IPv6 address, from its 16 network-order bytes: lowercase, no leading
 * zeros, the longest run of two or more zero groups (the first of equal runs) shortened to `::`,
 * IPv4-mapped addresses as `::ffff:a.b.c.d`.
 */
export function formatIpv6(bytes: readonly number[]): string {
  requireBytes(bytes, 16, 'An IPv6 address')
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
