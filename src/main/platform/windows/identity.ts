import type { ProcessIdentity } from '../types'

/**
 * Windows process identity (add-windows-process-supervision design D4): the PID together with the
 * process creation time from `GetProcessTimes`, as a decimal FILETIME string (100 ns intervals
 * since 1601-01-01 UTC). Creation times differ across boots, so no boot ID is needed.
 */

/** Largest Windows PID: a PID is a DWORD. */
export const MAX_WINDOWS_PID = 0xffff_ffff

/** Largest creation time accepted: a FILETIME is a signed 64-bit count in practice. */
const MAX_FILETIME = 0x7fff_ffff_ffff_ffffn

/** Canonical decimal: no sign, no leading zeros, at most 19 digits; 0 is never a creation time. */
const FILETIME_PATTERN = /^[1-9][0-9]{0,18}$/

export function isWindowsPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_WINDOWS_PID
}

/** Whether `value` is a creation time in its canonical decimal form (so equal times are equal strings). */
export function isFiletime(value: unknown): value is string {
  return typeof value === 'string' && FILETIME_PATTERN.test(value) && BigInt(value) <= MAX_FILETIME
}

export function windowsIdentity(pid: number, created: string): ProcessIdentity {
  if (!isWindowsPid(pid)) throw new RangeError(`Not a Windows PID: ${String(pid)}`)
  if (!isFiletime(created)) throw new RangeError(`Not a creation time: ${JSON.stringify(created)}`)
  return { pid, token: created }
}

/** The creation time of a Windows identity; `null` if it is not one (e.g. a Linux ledger entry). */
export function parseWindowsIdentity(identity: ProcessIdentity): { readonly pid: number; readonly created: string } | null {
  return isWindowsPid(identity.pid) && isFiletime(identity.token) ? { pid: identity.pid, created: identity.token } : null
}

/** Whether `a` and `b` are valid Windows identities of the same process. */
export function sameWindowsIdentity(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return parseWindowsIdentity(a) !== null && a.pid === b.pid && a.token === b.token
}
