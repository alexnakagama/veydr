// The permission check of an installed Veydr (add-windows-packaging design D4, task 3.4): who may
// change the install directory, Veydr.exe, app.asar and the helper. It is shared by
// test/packaging-windows/ (the administrator's install) and the standard-user driver (task 4.2),
// which runs from a copy of this directory as another account, so it imports nothing outside it.
//
// READ_ACL_SCRIPT reads the access control lists with Get-Acl in Windows PowerShell 5.1. Every
// identity is read as a SecurityIdentifier, never as a name, so a localized Windows gives the same
// result. aclViolations is the pure decision: it rejects any allow entry that grants a right to
// write, delete, change permissions or take ownership to a SID outside the allowed set, an owner
// outside it (the owner may always change the permissions), and anything it cannot read as a SID or
// a rights mask. It never compares names.

/** SYSTEM. */
export const SID_SYSTEM = 'S-1-5-18'
/** BUILTIN\Administrators. */
export const SID_ADMINISTRATORS = 'S-1-5-32-544'
/** CREATOR OWNER: an inherit-only placeholder, replaced by the creating account's SID on new objects. */
export const SID_CREATOR_OWNER = 'S-1-3-0'
/** OWNER RIGHTS: restricts what the owner may do; never grants anything to anyone else. */
export const SID_OWNER_RIGHTS = 'S-1-3-4'

/** The well-known SIDs that may hold write rights, besides the installing user's own. */
export const FIXED_ALLOWED_SIDS = Object.freeze([SID_SYSTEM, SID_ADMINISTRATORS, SID_CREATOR_OWNER, SID_OWNER_RIGHTS])
/** The well-known SIDs that may own an installed file, besides the installing user. */
export const FIXED_ALLOWED_OWNERS = Object.freeze([SID_SYSTEM, SID_ADMINISTRATORS])

/**
 * Every access right that lets its holder change what Veydr runs (winnt.h): write, append, write
 * extended attributes or attributes, delete a child, delete, change permissions (WRITE_DAC), take
 * ownership (WRITE_OWNER), and the generic rights that map to them (GENERIC_ALL, GENERIC_WRITE),
 * which Get-Acl shows for inherit-only entries.
 */
export const WRITE_RIGHTS = Object.freeze({
  WriteData: 0x2,
  AppendData: 0x4,
  WriteExtendedAttributes: 0x10,
  DeleteSubdirectoriesAndFiles: 0x40,
  WriteAttributes: 0x100,
  Delete: 0x1_0000,
  ChangePermissions: 0x4_0000,
  TakeOwnership: 0x8_0000,
  GenericAll: 0x1000_0000,
  GenericWrite: 0x4000_0000,
})
export const WRITE_RIGHTS_MASK = Object.values(WRITE_RIGHTS).reduce((mask, bit) => mask | bit, 0)

/** A SID in its string form (S-1-<authority>-<sub-authority>...). */
const SID = /^S-1-\d{1,15}(?:-\d{1,10})+$/
/** An account's own SID (machine or domain account): never a group or a well-known SID. */
const ACCOUNT_SID = /^S-1-5-21-\d{1,10}-\d{1,10}-\d{1,10}-\d{1,10}$/

export const isSid = (value) => typeof value === 'string' && SID.test(value)
export const isAccountSid = (value) => typeof value === 'string' && ACCOUNT_SID.test(value)

/** The names of the write rights set in `mask`. */
export function writeRightsIn(mask) {
  return Object.entries(WRITE_RIGHTS)
    .filter(([, bit]) => (mask & bit) !== 0)
    .map(([name]) => name)
}

const isMask = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff

/**
 * The violations in `report`, the parsed output of READ_ACL_SCRIPT: `{ user, paths: [{ path, owner,
 * access: [{ sid, type, rights }] }] }`. `userSid`, the installing user's SID, defaults to
 * `report.user`, and must be an account's SID: a group such as Everyone would otherwise widen the
 * allowed set. An empty array means the check passed.
 *
 * Only `type: 'Deny'` entries are skipped; any other type counts as an allow entry. An identity
 * that is not a SID, or a rights value that is not a 32-bit mask, is a violation in itself.
 */
export function aclViolations(report, { userSid = report?.user } = {}) {
  if (!isAccountSid(userSid)) throw new TypeError(`the installing user's SID is not an account SID: ${JSON.stringify(userSid)}`)
  if (report === null || typeof report !== 'object' || !Array.isArray(report.paths)) throw new TypeError('the ACL report has no list of paths')
  const allowed = new Set([userSid, ...FIXED_ALLOWED_SIDS])
  const owners = new Set([userSid, ...FIXED_ALLOWED_OWNERS])
  const violations = []
  for (const entry of report.paths) {
    const path = typeof entry?.path === 'string' ? entry.path : JSON.stringify(entry?.path)
    if (!isSid(entry?.owner)) violations.push({ path, sid: entry?.owner ?? null, problem: 'the owner is not a SID' })
    else if (!owners.has(entry.owner)) violations.push({ path, sid: entry.owner, problem: 'owned by an account outside the allowed set' })
    if (!Array.isArray(entry?.access)) {
      violations.push({ path, sid: null, problem: 'no access list' })
      continue
    }
    for (const rule of entry.access) {
      if (rule?.type === 'Deny') continue
      if (!isSid(rule?.sid)) {
        violations.push({ path, sid: rule?.sid ?? null, problem: 'an identity without a SID' })
        continue
      }
      if (!isMask(rule.rights)) {
        violations.push({ path, sid: rule.sid, problem: `rights that are not a 32-bit mask: ${JSON.stringify(rule.rights)}` })
        continue
      }
      const granted = writeRightsIn(rule.rights)
      if (granted.length > 0 && !allowed.has(rule.sid)) violations.push({ path, sid: rule.sid, problem: `${String(rule.type)} ${granted.join(', ')}` })
    }
  }
  return violations
}

/**
 * Windows PowerShell 5.1: prints `{ user, paths: [{ path, owner, access: [{ sid, type, rights,
 * inherited }] }] }` as one line of JSON, for the JSON array of full paths in $env:VEYDR_ACL_PATHS.
 * `user` is the SID of the account running it. Paths reach the script only through the environment.
 * The caller sets $ErrorActionPreference = 'Stop' and UTF-8 output, so a path that cannot be read
 * fails the script instead of being left out.
 */
export const READ_ACL_SCRIPT = `
# Windows PowerShell 5.1 can serialize a wrapped array as {"value":[...],"Count":n} through the
# Count alias of System.Array's extended type data; without it, arrays stay arrays.
Remove-TypeData -TypeName System.Array -ErrorAction SilentlyContinue
$sidType = [System.Security.Principal.SecurityIdentifier]
# Not wrapped in @(): Windows PowerShell 5.1 writes a parsed array as one object, which @() would
# wrap in a second array; foreach enumerates it either way.
$paths = ConvertFrom-Json -InputObject $env:VEYDR_ACL_PATHS
$entries = @(foreach ($path in $paths) {
  $acl = Get-Acl -LiteralPath ([string]$path)
  $owner = $acl.GetOwner($sidType)
  [pscustomobject]@{
    path = [string]$path
    owner = $(if ($null -eq $owner) { $null } else { $owner.Value })
    access = @(foreach ($rule in $acl.GetAccessRules($true, $true, $sidType)) {
      [pscustomobject]@{
        sid = $rule.IdentityReference.Value
        type = $rule.AccessControlType.ToString()
        rights = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$rule.FileSystemRights), 0)
        inherited = [bool]$rule.IsInherited
      }
    })
  }
})
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
ConvertTo-Json -InputObject ([pscustomobject]@{ user = $user; paths = $entries }) -Depth 6 -Compress
`
