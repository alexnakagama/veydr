import { describe, expect, it } from 'vitest'
import { formatIpv4, formatIpv6 } from '../../src/main/platform/address'

// The address text forms shared by the Linux and Windows port inspectors (add-windows-port-inspection
// design D5, task 1.1). Both take network-order bytes.

/** The 16 bytes of `hex`, 32 hex digits in network order. */
const v6 = (hex: string): number[] => Array.from({ length: 16 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16))

describe('formatIpv4', () => {
  it('writes the four bytes in network order, dotted', () => {
    expect(formatIpv4([127, 0, 0, 1])).toBe('127.0.0.1')
    expect(formatIpv4([0, 0, 0, 0])).toBe('0.0.0.0')
    expect(formatIpv4([192, 168, 10, 255])).toBe('192.168.10.255')
  })

  it('refuses anything but four bytes from 0 to 255', () => {
    for (const bytes of [[], [127, 0, 0], [127, 0, 0, 1, 0], [256, 0, 0, 1], [-1, 0, 0, 1], [1.5, 0, 0, 1], [Number.NaN, 0, 0, 1]]) {
      expect(() => formatIpv4(bytes), JSON.stringify(bytes)).toThrow(RangeError)
    }
  })
})

describe('formatIpv6', () => {
  it('writes the unspecified address as ::', () => {
    expect(formatIpv6(v6('00000000000000000000000000000000'))).toBe('::')
  })

  it('writes the loopback address as ::1', () => {
    expect(formatIpv6(v6('00000000000000000000000000000001'))).toBe('::1')
  })

  it('compresses the longest run of zero groups, the first of equal runs, and drops leading zeros', () => {
    expect(formatIpv6(v6('20010db8000000000000000000000001'))).toBe('2001:db8::1')
    expect(formatIpv6(v6('fe800000000000000202b3fffe1e8329'))).toBe('fe80::202:b3ff:fe1e:8329')
    // Equal runs of two: the first is shortened.
    expect(formatIpv6(v6('20010db8000000000001000000000001'))).toBe('2001:db8::1:0:0:1')
    // The longer run wins over an earlier, shorter one.
    expect(formatIpv6(v6('20010000000000010000000000000001'))).toBe('2001:0:0:1::1')
  })

  it('never shortens a single zero group', () => {
    expect(formatIpv6(v6('20010db8000000010001000100010001'))).toBe('2001:db8:0:1:1:1:1:1')
  })

  it('writes an IPv4-mapped address with a dotted IPv4 tail', () => {
    expect(formatIpv6(v6('00000000000000000000ffff7f000001'))).toBe('::ffff:127.0.0.1')
    expect(formatIpv6(v6('00000000000000000000ffff00000000'))).toBe('::ffff:0.0.0.0')
  })

  it('writes lowercase hex', () => {
    expect(formatIpv6(v6('ABCDEF00000000000000000000000000'))).toBe('abcd:ef00::')
  })

  it('refuses anything but sixteen bytes from 0 to 255', () => {
    expect(() => formatIpv6(new Array<number>(15).fill(0))).toThrow(RangeError)
    expect(() => formatIpv6(new Array<number>(17).fill(0))).toThrow(RangeError)
    expect(() => formatIpv6([...new Array<number>(15).fill(0), 256])).toThrow(RangeError)
    expect(() => formatIpv6([...new Array<number>(15).fill(0), -1])).toThrow(RangeError)
  })
})
