import { describe, expect, it } from 'vitest'
import {
  aclViolations,
  FIXED_ALLOWED_SIDS,
  READ_ACL_SCRIPT,
  SID_ADMINISTRATORS,
  SID_CREATOR_OWNER,
  SID_OWNER_RIGHTS,
  SID_SYSTEM,
  WRITE_RIGHTS_MASK,
  writeRightsIn,
  type AclEntry,
  type AclReport,
  type AclRule,
} from '../../scripts/windows-probe/install-acl.mjs'

// The pure permission decision of an installed Veydr (add-windows-packaging design D4, task 3.4),
// fed SIDs as Get-Acl would report them. installer.test.ts and the standard-user driver apply it to
// the real lists on Windows.

// FileSystemRights values (System.Security.AccessControl).
const FULL_CONTROL = 0x1f01ff
const MODIFY = 0x1301bf
const READ_AND_EXECUTE = 0x1200a9
const WRITE = 0x116
const GENERIC_ALL = 0x1000_0000
const GENERIC_READ_EXECUTE = 0xa000_0000

const USER = 'S-1-5-21-1004336348-1177238915-682003330-500'
const OTHER_USER = 'S-1-5-21-1004336348-1177238915-682003330-1001'
const USERS = 'S-1-5-32-545'
const EVERYONE = 'S-1-1-0'
const AUTHENTICATED_USERS = 'S-1-5-11'

const allow = (sid: string | null, rights: number): AclRule => ({ sid, type: 'Allow', rights })
const deny = (sid: string, rights: number): AclRule => ({ sid, type: 'Deny', rights })

/** What %LOCALAPPDATA% gives new files: the user, SYSTEM and Administrators with full control, inherited. */
const PROFILE_DEFAULT: readonly AclRule[] = [
  { ...allow(SID_SYSTEM, FULL_CONTROL), inherited: true },
  { ...allow(SID_ADMINISTRATORS, FULL_CONTROL), inherited: true },
  { ...allow(USER, FULL_CONTROL), inherited: true },
]

const PATHS = ['C:\\Users\\u\\AppData\\Local\\Programs\\veydr', 'C:\\Users\\u\\AppData\\Local\\Programs\\veydr\\Veydr.exe']

function report(extra: readonly AclRule[] = [], { owner = USER, paths = PATHS }: { owner?: string | null; paths?: readonly string[] } = {}): AclReport {
  return { user: USER, paths: paths.map((path): AclEntry => ({ path, owner, access: [...PROFILE_DEFAULT, ...extra] })) }
}

describe('aclViolations (design D4)', () => {
  it('accepts the profile\'s default list on every path', () => {
    expect(aclViolations(report())).toEqual([])
  })

  it('accepts Users with read-and-execute, and the owner placeholders with full or generic rights', () => {
    expect(aclViolations(report([allow(USERS, READ_AND_EXECUTE), allow(EVERYONE, GENERIC_READ_EXECUTE)]))).toEqual([])
    expect(aclViolations(report([allow(SID_CREATOR_OWNER, GENERIC_ALL), allow(SID_OWNER_RIGHTS, FULL_CONTROL)]))).toEqual([])
  })

  it('rejects Users with write access', () => {
    expect(aclViolations(report([allow(USERS, WRITE)]))).toEqual(PATHS.map((path) => ({ path, sid: USERS, problem: 'Allow WriteData, AppendData, WriteExtendedAttributes, WriteAttributes' })))
  })

  it('rejects Everyone with full control', () => {
    const found = aclViolations(report([allow(EVERYONE, FULL_CONTROL)]))
    expect(found.map((v) => v.sid)).toEqual([EVERYONE, EVERYONE])
    expect(found[0]?.problem).toMatch(/ChangePermissions, TakeOwnership$/)
  })

  it('rejects Authenticated Users with modify', () => {
    const found = aclViolations(report([allow(AUTHENTICATED_USERS, MODIFY)]))
    expect(found.map((v) => v.sid)).toEqual([AUTHENTICATED_USERS, AUTHENTICATED_USERS])
    expect(found[0]?.problem).toContain('Delete')
  })

  it('rejects another user\'s SID with write access', () => {
    expect(aclViolations(report([allow(OTHER_USER, WRITE)])).map((v) => v.sid)).toEqual([OTHER_USER, OTHER_USER])
  })

  it('rejects an identity that is not a SID, whatever its rights, and never compares names', () => {
    for (const identity of [null, '', 'BUILTIN\\Users', 'NT AUTHORITY\\SYSTEM', 'Administrators', 's-1-5-18', 'S-1-5-18 ', 'S-1']) {
      const found = aclViolations(report([allow(identity, READ_AND_EXECUTE)], { paths: PATHS.slice(0, 1) }))
      expect(found, JSON.stringify(identity)).toEqual([{ path: PATHS[0], sid: identity, problem: 'an identity without a SID' }])
    }
  })

  it('rejects each write, delete, permission and ownership right on its own for a SID outside the allowed set', () => {
    for (const [name, bit] of [
      ['WriteData', 0x2],
      ['AppendData', 0x4],
      ['WriteExtendedAttributes', 0x10],
      ['DeleteSubdirectoriesAndFiles', 0x40],
      ['WriteAttributes', 0x100],
      ['Delete', 0x1_0000],
      ['ChangePermissions', 0x4_0000],
      ['TakeOwnership', 0x8_0000],
      ['GenericAll', 0x1000_0000],
      ['GenericWrite', 0x4000_0000],
    ] as const) {
      expect(writeRightsIn(bit), name).toEqual([name])
      expect(aclViolations(report([allow(USERS, bit)], { paths: PATHS.slice(0, 1) })), name).toEqual([{ path: PATHS[0], sid: USERS, problem: `Allow ${name}` }])
    }
    // Read, execute, read-permissions and synchronize are not write rights.
    expect(READ_AND_EXECUTE & WRITE_RIGHTS_MASK).toBe(0)
  })

  it('ignores deny entries, and counts any other entry type as an allow entry', () => {
    expect(aclViolations(report([deny(EVERYONE, FULL_CONTROL)]))).toEqual([])
    expect(aclViolations(report([{ sid: USERS, type: 'AccessAllowedCallback', rights: WRITE }], { paths: PATHS.slice(0, 1) })).map((v) => v.sid)).toEqual([USERS])
  })

  it('rejects rights that are not a 32-bit mask', () => {
    for (const rights of [-1, 0x1_0000_0000, 1.5, Number.NaN, '2' as unknown as number]) {
      expect(aclViolations(report([allow(USERS, rights)], { paths: PATHS.slice(0, 1) })), String(rights)).toEqual([{ path: PATHS[0], sid: USERS, problem: `rights that are not a 32-bit mask: ${JSON.stringify(rights)}` }])
    }
  })

  it('rejects an owner outside the user, SYSTEM and Administrators, or one that is not a SID', () => {
    expect(aclViolations(report([], { owner: SID_SYSTEM }))).toEqual([])
    expect(aclViolations(report([], { owner: SID_ADMINISTRATORS }))).toEqual([])
    expect(aclViolations(report([], { owner: OTHER_USER, paths: PATHS.slice(0, 1) }))).toEqual([{ path: PATHS[0], sid: OTHER_USER, problem: 'owned by an account outside the allowed set' }])
    expect(aclViolations(report([], { owner: SID_CREATOR_OWNER, paths: PATHS.slice(0, 1) })).map((v) => v.problem)).toEqual(['owned by an account outside the allowed set'])
    expect(aclViolations(report([], { owner: null, paths: PATHS.slice(0, 1) })).map((v) => v.problem)).toEqual(['the owner is not a SID'])
  })

  it('rejects a path without an access list', () => {
    const broken = { user: USER, paths: [{ path: PATHS[0], owner: USER }] } as unknown as AclReport
    expect(aclViolations(broken)).toEqual([{ path: PATHS[0], sid: null, problem: 'no access list' }])
  })

  it('takes the installing user from the report, and refuses one that is not an account SID', () => {
    // Another user's report: its own SID is allowed, the first user's is not.
    const other: AclReport = { user: OTHER_USER, paths: [{ path: PATHS[0] as string, owner: OTHER_USER, access: [allow(OTHER_USER, FULL_CONTROL), allow(USER, WRITE)] }] }
    expect(aclViolations(other).map((v) => v.sid)).toEqual([USER])
    expect(aclViolations(other, { userSid: USER }).map((v) => v.sid)).toEqual([OTHER_USER, OTHER_USER])
    for (const user of [EVERYONE, USERS, SID_SYSTEM, AUTHENTICATED_USERS, 'BUILTIN\\Administrators', '', undefined]) {
      expect(() => aclViolations({ user, paths: [] } as unknown as AclReport), String(user)).toThrow(/not an account SID \(S-1-5-21-…; an Entra ID/)
    }
    expect(() => aclViolations({ user: USER } as unknown as AclReport)).toThrow(/no list of paths/)
  })

  it('allows exactly SYSTEM, Administrators, CREATOR OWNER and OWNER RIGHTS besides the user', () => {
    expect([...FIXED_ALLOWED_SIDS].sort()).toEqual(['S-1-3-0', 'S-1-3-4', 'S-1-5-18', 'S-1-5-32-544'])
  })
})

describe('READ_ACL_SCRIPT', () => {
  it('reads identities as SIDs, takes paths only from the environment, and reports the reading account', () => {
    expect(READ_ACL_SCRIPT).toContain('GetAccessRules($true, $true, $sidType)')
    expect(READ_ACL_SCRIPT).toContain('GetOwner($sidType)')
    expect(READ_ACL_SCRIPT).toContain('Get-Acl -LiteralPath')
    expect(READ_ACL_SCRIPT).toContain('$env:VEYDR_ACL_PATHS')
    expect(READ_ACL_SCRIPT).toContain('WindowsIdentity]::GetCurrent().User.Value')
    // No identity is ever translated to or compared as a name.
    expect(READ_ACL_SCRIPT).not.toMatch(/NTAccount|\.Translate\(/)
  })
})
