#!/usr/bin/env node
// Release version logic (design D5). The release workflow calls this; the pure functions are
// exported for test/unit/release-version.test.ts.
//
//   node scripts/release-version.mjs check <version>  validates <version> against package.json and the
//                                                     `v*` tags; writes `tag` and `prerelease` to
//                                                     $GITHUB_OUTPUT when that variable is set
//   node scripts/release-version.mjs apply <version>  `npm version --no-git-tag-version --ignore-scripts`,
//                                                     then asserts that only the version fields of
//                                                     package.json and package-lock.json changed
//
// Both act on the current directory. Exit codes: 0 ok, 1 validation or apply failure, 2 usage error.
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'

export const FORMAT = 'MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-PRERELEASE (e.g. 1.2.3 or 1.2.3-rc.1), without a leading "v" or "+build" metadata'

// SemVer 2.0 (semver.org), without build metadata: no leading zeros in numeric identifiers.
const numeric = '0|[1-9]\\d*'
const identifier = `(?:${numeric}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`
const pattern = new RegExp(`^(${numeric})\\.(${numeric})\\.(${numeric})(?:-(${identifier}(?:\\.${identifier})*))?$`)

/**
 * Parses a release version. Returns null when `text` is not `MAJOR.MINOR.PATCH[-PRERELEASE]`
 * (a leading `v`, build metadata and core numbers beyond the safe integer range are rejected).
 */
export function parseVersion(text) {
  if (typeof text !== 'string') return null
  const match = pattern.exec(text)
  if (match === null) return null
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number)
  if (![major, minor, patch].every(Number.isSafeInteger)) return null
  return { major, minor, patch, prerelease: match[4] === undefined ? [] : match[4].split('.') }
}

function parseOrThrow(text) {
  const version = parseVersion(text)
  if (version === null) throw new Error(`invalid version "${text}": expected ${FORMAT}`)
  return version
}

const sign = (n) => (n < 0 ? -1 : n > 0 ? 1 : 0)

/** SemVer 2.0 §11 precedence of two prerelease identifiers. */
function compareIdentifiers(a, b) {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric) {
    const [x, y] = [BigInt(a), BigInt(b)]
    return x < y ? -1 : x > y ? 1 : 0
  }
  // Numeric identifiers have lower precedence than alphanumeric ones.
  if (aNumeric) return -1
  if (bNumeric) return 1
  // ASCII order, not locale order.
  return a < b ? -1 : a > b ? 1 : 0
}

/** SemVer 2.0 precedence: -1, 0 or 1. Throws on a string that `parseVersion` rejects. */
export function compareVersions(a, b) {
  const x = parseOrThrow(a)
  const y = parseOrThrow(b)
  for (const key of ['major', 'minor', 'patch']) {
    if (x[key] !== y[key]) return sign(x[key] - y[key])
  }
  // A version without a prerelease has higher precedence than one with.
  if (x.prerelease.length === 0 || y.prerelease.length === 0) {
    return sign(y.prerelease.length - x.prerelease.length)
  }
  const length = Math.min(x.prerelease.length, y.prerelease.length)
  for (let i = 0; i < length; i++) {
    const order = compareIdentifiers(x.prerelease[i], y.prerelease[i])
    if (order !== 0) return order
  }
  // A larger set of prerelease fields has higher precedence when all preceding ones are equal.
  return sign(x.prerelease.length - y.prerelease.length)
}

/**
 * Validates a requested release version against the current package.json version and the
 * existing tags (`git tag --list 'v*'`; tags that are not `v` + a release version are ignored).
 * Returns `{ ok: true, tag, prerelease }` or `{ ok: false, error }`.
 */
export function checkVersion({ requested, current, tags }) {
  const version = parseVersion(requested)
  if (version === null) return { ok: false, error: `invalid version "${requested}": expected ${FORMAT}` }
  const tag = `v${requested}`
  if (parseVersion(current) === null) return { ok: false, error: `package.json version "${current}" is not a valid version` }

  let latest = { version: current, source: 'package.json' }
  for (const existing of tags) {
    const candidate = existing.slice(1)
    if (!existing.startsWith('v') || parseVersion(candidate) === null) continue
    if (compareVersions(candidate, latest.version) > 0) latest = { version: candidate, source: `tag ${existing}` }
  }
  const mustBeGreater = `must be greater than the latest version ${latest.version} (${latest.source})`
  if (tags.includes(tag)) return { ok: false, error: `tag ${tag} already exists; the version ${mustBeGreater}` }
  if (compareVersions(requested, latest.version) <= 0) {
    return { ok: false, error: `version ${requested} ${mustBeGreater}` }
  }
  return { ok: true, tag, prerelease: version.prerelease.length > 0 }
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}: ${result.stderr.trim()}`)
  }
  return result.stdout
}

const readJson = (file) => JSON.parse(readFileSync(join(process.cwd(), file), 'utf8'))

function check(requested) {
  const tags = run('git', ['tag', '--list', 'v*']).split('\n').map((t) => t.trim()).filter((t) => t !== '')
  const result = checkVersion({ requested, current: readJson('package.json').version, tags })
  if (!result.ok) {
    console.error(`release-version: ${result.error}`)
    return 1
  }
  const output = process.env.GITHUB_OUTPUT
  if (output !== undefined && output !== '') {
    appendFileSync(output, `tag=${result.tag}\nprerelease=${result.prerelease}\n`)
  }
  console.log(`release-version: ${requested} is valid (tag ${result.tag}, prerelease ${result.prerelease})`)
  return 0
}

const bumpedFiles = ['package.json', 'package-lock.json']
/** Lines `npm version` rewrites: `version` in package.json; `version` and `packages[""].version` in the lockfile. */
const expectedNumstat = { 'package.json': '1/1', 'package-lock.json': '2/2' }

/** The file's content without the version fields the bump is allowed to change. */
function withoutVersions(json) {
  const copy = structuredClone(json)
  delete copy.version
  delete copy.packages?.['']?.version
  return copy
}

function apply(requested) {
  if (parseVersion(requested) === null) {
    console.error(`release-version: invalid version "${requested}": expected ${FORMAT}`)
    return 1
  }
  const before = bumpedFiles.map(readJson)
  // `--ignore-scripts`: no version lifecycle script may change files or reach the network.
  run('npm', ['version', requested, '--no-git-tag-version', '--ignore-scripts'])
  const after = bumpedFiles.map(readJson)

  const problems = []
  // `--untracked-files=all` lists files rather than directories; porcelain v1 lines are `XY path`.
  const changed = run('git', ['status', '--porcelain', '--untracked-files=all'])
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.slice(3))
  const unexpected = changed.filter((file) => !bumpedFiles.includes(file))
  if (unexpected.length > 0) problems.push(`also changed: ${unexpected.join(', ')}`)
  const numstat = new Map(
    run('git', ['diff', '--numstat', '--', ...bumpedFiles])
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const [added, deleted, file] = line.split('\t')
        return [file, `${added}/${deleted}`]
      }),
  )
  for (const [i, file] of bumpedFiles.entries()) {
    if (!isDeepStrictEqual(withoutVersions(before[i]), withoutVersions(after[i]))) {
      problems.push(`${file} changed beyond its version fields`)
    }
    if (numstat.get(file) !== expectedNumstat[file]) {
      problems.push(`${file} diff adds/deletes ${numstat.get(file) ?? 'no'} lines, expected ${expectedNumstat[file]}`)
    }
  }
  const [pkg, lock] = after
  const versions = [pkg.version, lock.version, lock.packages?.['']?.version]
  if (versions.some((v) => v !== requested)) problems.push(`versions are ${versions.join(', ')}`)

  if (problems.length > 0) {
    console.error(
      `release-version: expected only ${bumpedFiles.join(' and ')} to change, and only to version ${requested}; ` +
        problems.join('; '),
    )
    return 1
  }
  console.log(`release-version: applied ${requested} to ${bumpedFiles.join(' and ')}`)
  return 0
}

function main(args) {
  const [command, requested, ...rest] = args
  if ((command !== 'check' && command !== 'apply') || requested === undefined || rest.length > 0) {
    console.error(`usage: release-version.mjs check|apply <version> (got: ${args.join(' ')})`)
    return 2
  }
  return command === 'check' ? check(requested) : apply(requested)
}

/** True when Node runs this file as the entry point. Node resolves symlinks for `import.meta.url`, so argv[1] is too. */
function isEntryPoint() {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`release-version: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
