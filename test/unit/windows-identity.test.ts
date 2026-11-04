import { describe, expect, it } from 'vitest'
import { isFiletime, parseWindowsIdentity, sameWindowsIdentity, windowsIdentity } from '../../src/main/platform/windows/identity'

// The Windows process identity: PID plus creation time as a decimal FILETIME string
// (add-windows-process-supervision design D4).

const CREATED = '134067012345678901'

describe('Windows process identity', () => {
  it('is the PID with the creation time as token', () => {
    expect(windowsIdentity(4242, CREATED)).toEqual({ pid: 4242, token: CREATED })
    expect(parseWindowsIdentity({ pid: 4242, token: CREATED })).toEqual({ pid: 4242, created: CREATED })
  })

  it('accepts only canonical creation times, so equal times are equal strings', () => {
    for (const valid of ['1', CREATED, '9223372036854775807']) expect(isFiletime(valid), valid).toBe(true)
    for (const invalid of ['', '0', '0134067012345678901', '-1', '+1', '1.5', '1e5', ' 1', '1 ', '9223372036854775808', '99999999999999999999', 'abc']) {
      expect(isFiletime(invalid), invalid).toBe(false)
    }
    expect(isFiletime(134067012345678901)).toBe(false)
  })

  it('rejects PIDs that are not DWORDs above zero', () => {
    for (const pid of [0, -4, 1.5, 0x1_0000_0000, Number.NaN]) {
      expect(() => windowsIdentity(pid, CREATED), String(pid)).toThrow(RangeError)
      expect(parseWindowsIdentity({ pid, token: CREATED }), String(pid)).toBeNull()
    }
    expect(windowsIdentity(0xffff_ffff, CREATED).pid).toBe(0xffff_ffff)
    expect(() => windowsIdentity(4, '007')).toThrow(RangeError)
  })

  it('does not take a Linux identity for a Windows one', () => {
    expect(parseWindowsIdentity({ pid: 500, token: 'fe842736-befd-4703-a9f6-ed979b5b00d3:12345' })).toBeNull()
  })

  it('is equal only for the same PID and creation time', () => {
    const a = windowsIdentity(4242, CREATED)
    expect(sameWindowsIdentity(a, { pid: 4242, token: CREATED })).toBe(true)
    // A reused PID: same number, another creation time.
    expect(sameWindowsIdentity(a, { pid: 4242, token: '134067012345678902' })).toBe(false)
    expect(sameWindowsIdentity(a, { pid: 4246, token: CREATED })).toBe(false)
    // Invalid identities are never equal, not even to themselves.
    const invalid = { pid: 4242, token: '' }
    expect(sameWindowsIdentity(invalid, invalid)).toBe(false)
  })
})
