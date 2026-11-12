// Types for scripts/windows-probe/install-acl.mjs.

export const SID_SYSTEM: 'S-1-5-18'
export const SID_ADMINISTRATORS: 'S-1-5-32-544'
export const SID_CREATOR_OWNER: 'S-1-3-0'
export const SID_OWNER_RIGHTS: 'S-1-3-4'
export const FIXED_ALLOWED_SIDS: readonly string[]
export const FIXED_ALLOWED_OWNERS: readonly string[]
export const WRITE_RIGHTS: Readonly<Record<string, number>>
export const WRITE_RIGHTS_MASK: number

export interface AclRule {
  readonly sid: string | null
  readonly type: string
  readonly rights: number
  readonly inherited?: boolean
}

export interface AclEntry {
  readonly path: string
  readonly owner: string | null
  readonly access: readonly AclRule[]
}

export interface AclReport {
  /** The SID of the account that read the lists. */
  readonly user: string
  readonly paths: readonly AclEntry[]
}

export interface AclViolation {
  readonly path: string
  readonly sid: string | null
  readonly problem: string
}

export function isSid(value: unknown): value is string
export function isAccountSid(value: unknown): value is string
export function writeRightsIn(mask: number): string[]
export function aclViolations(report: AclReport, options?: { userSid?: string }): AclViolation[]
export const READ_ACL_SCRIPT: string
