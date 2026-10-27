import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// Design D11: the security rules for everything under .github/ (docs/ci.md#workflow-security-rules),
// checked on the files as text with line-level patterns, so no YAML parser is needed. The style is
// deliberately narrow (block style, two-space indentation, one key per line); a line the checker
// cannot classify is a violation rather than something it lets through.

const root = resolve(__dirname, '../..')

interface Source {
  /** Repository-relative path with `/` separators. */
  path: string
  text: string
}

interface Line {
  /** 1-based line number. */
  n: number
  indent: number
  kind: 'blank' | 'comment' | 'scalar' | 'node'
  /** The line is a sequence item (`- …`). */
  item: boolean
  /** The node without indentation and without the leading `- `. */
  body: string
  /** Set when the body is `key:` or `key: value`. */
  key?: string
  value?: string
  /** For block scalar content: the key that opened the scalar (`run` for a script). */
  scalarKey?: string
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    return entry.isDirectory() ? filesUnder(full) : [full]
  })
}

const githubFiles = (): Source[] =>
  filesUnder(join(root, '.github')).map((full) => ({
    path: relative(root, full).split('\\').join('/'),
    text: readFileSync(full, 'utf8'),
  }))

const isYaml = (path: string): boolean => /\.ya?ml$/.test(path)
const isWorkflow = (path: string): boolean => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)

function parse(text: string): Line[] {
  const lines: Line[] = []
  let scalarParent = -1
  let scalarKey = ''
  for (const [index, raw] of text.split('\n').entries()) {
    const n = index + 1
    const trimmed = raw.trim()
    const indent = raw.length - raw.trimStart().length
    if (trimmed === '') {
      lines.push({ n, indent, kind: 'blank', item: false, body: '' })
      continue
    }
    // Block scalar content (`run: |`): script text, not structure.
    if (scalarParent >= 0 && indent > scalarParent) {
      lines.push({ n, indent, kind: 'scalar', item: false, body: trimmed, scalarKey })
      continue
    }
    scalarParent = -1
    if (trimmed.startsWith('#')) {
      lines.push({ n, indent, kind: 'comment', item: false, body: trimmed })
      continue
    }
    const item = trimmed === '-' || trimmed.startsWith('- ')
    const body = item ? trimmed.slice(1).trimStart() : trimmed
    const line: Line = { n, indent, kind: 'node', item, body }
    const pair = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:\s+(.*))?$/.exec(body)
    if (pair?.[1] !== undefined) {
      line.key = pair[1]
      line.value = pair[2] ?? ''
    }
    if (/^[|>][-+]?\d?$/.test(body)) {
      scalarParent = indent
      scalarKey = ''
    } else if (/^[|>][-+]?\d?$/.test(line.value ?? '')) {
      scalarParent = indent + (item ? 2 : 0)
      scalarKey = line.key ?? ''
    }
    lines.push(line)
  }
  return lines
}

const at = (source: Source, line: Line, message: string): string => `${source.path}:${line.n}: ${message}`
const nodes = (lines: Line[]): Line[] => lines.filter((l) => l.kind === 'node')

/** Lines the checker cannot classify: anything outside block style with two-space indentation. */
function unclassified(source: Source, lines: Line[]): string[] {
  const out: string[] = []
  const raw = source.text.split('\n')
  for (const line of nodes(lines)) {
    const lead = /^\s*/.exec(raw[line.n - 1] ?? '')?.[0] ?? ''
    if (lead.includes('\t')) out.push(at(source, line, 'cannot classify: tab in indentation'))
    else if (line.indent % 2 !== 0) out.push(at(source, line, 'cannot classify: indentation is not a multiple of two spaces'))
    else if (line.key === undefined) {
      const plainItem = line.item && /^(?:"[^"]*"|'[^']*'|[^\s"'{}[\]#&*!|>%@`](?:(?!:\s|\s#).)*)$/.test(line.body)
      if (!plainItem) out.push(at(source, line, `cannot classify: ${line.body}`))
    } else {
      const value = line.value ?? ''
      if (/^[{[]/.test(value) && value !== '{}' && value !== '[]') out.push(at(source, line, `cannot classify: flow style in ${line.key}`))
      else if (/^[&*]/.test(value)) out.push(at(source, line, `cannot classify: anchor or alias in ${line.key}`))
      else if (line.key === 'timeout-minutes' && !/^\d+$/.test(value)) out.push(at(source, line, `cannot classify: timeout-minutes: ${value}`))
      else if (line.key === 'timeout-minutes' && (Number(value) < 1 || Number(value) > maxTimeout)) {
        out.push(at(source, line, `timeout-minutes: ${value} is outside 1–${maxTimeout}`))
      }
      else if (line.key === 'persist-credentials' && !/^(true|false)$/.test(value)) out.push(at(source, line, `cannot classify: persist-credentials: ${value}`))
      else if (line.key === 'permissions' && !['', '{}', 'read-all', 'write-all'].includes(value)) out.push(at(source, line, `cannot classify: permissions: ${value}`))
    }
  }
  return out
}

/** Every `uses:` is a local action, a Docker image pinned by digest, or an action pinned to a commit SHA with its version as a comment. */
function unpinned(source: Source, lines: Line[]): string[] {
  const out: string[] = []
  for (const line of nodes(lines)) {
    if (line.key !== 'uses') continue
    const value = line.value ?? ''
    if (/^\.\/\S+$/.test(value)) continue
    if (/^docker:\/\/[^\s@]+@sha256:[0-9a-f]{64}$/.test(value)) continue
    if (/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s+v\d+(?:\.\d+){0,2}$/.test(value)) continue
    if (/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(value)) out.push(at(source, line, `pinned without a "# vX.Y.Z" comment: ${value}`))
    else out.push(at(source, line, `not pinned to a full commit SHA: ${value}`))
  }
  return out
}

/** Upper bound for any `timeout-minutes`; the slowest job (the release gate's E2E or smoke matrix) needs well under it. */
const maxTimeout = 120

/** Text that must not appear anywhere under .github/, comments included. */
const forbiddenText: readonly (readonly [string, string])[] = [
  ['pull_request_target', 'pull_request_target gives pull request code a write token and secrets'],
  ['workflow_run', 'workflow_run runs with a write token and secrets after a pull request workflow'],
  ['--no-sandbox', '--no-sandbox disables the Chromium sandbox under test'],
  ['--disable-setuid-sandbox', '--disable-setuid-sandbox weakens the Chromium sandbox under test'],
  ['--disable-gpu-sandbox', '--disable-gpu-sandbox weakens the Chromium sandbox under test'],
  ['--disable-seccomp-filter-sandbox', '--disable-seccomp-filter-sandbox weakens the Chromium sandbox under test'],
  ['ELECTRON_DISABLE_SANDBOX', 'ELECTRON_DISABLE_SANDBOX disables the Chromium sandbox under test'],
  ['chromiumSandbox: false', 'chromiumSandbox: false disables the Chromium sandbox under test'],
  ['VEYDR_ALLOW_SKIP_OFFLINE', 'VEYDR_ALLOW_SKIP_OFFLINE lets the offline test skip instead of fail'],
]

function forbidden(source: Source): string[] {
  const out: string[] = []
  for (const [index, text] of source.text.split('\n').entries()) {
    for (const [needle, why] of forbiddenText) if (text.includes(needle)) out.push(`${source.path}:${index + 1}: ${why}`)
  }
  return out
}

/** `read-all` and `write-all` grant every scope; scopes are always listed explicitly. */
function broadPermissions(source: Source, lines: Line[]): string[] {
  return nodes(lines)
    .filter((l) => l.key === 'permissions' && (l.value === 'read-all' || l.value === 'write-all'))
    .map((l) => at(source, l, `permissions: ${l.value ?? ''} grants every scope; list the scopes the job needs`))
}

/** `${{ … }}` inside a script is expanded before the shell parses it, so a dispatch input or event field could inject commands; pass values through `env:`. */
function scriptExpressions(source: Source, lines: Line[]): string[] {
  return lines
    .filter((l) => (l.kind === 'scalar' && l.scalarKey === 'run') || (l.kind === 'node' && l.key === 'run'))
    .filter((l) => (l.kind === 'scalar' ? l.body : (l.value ?? '')).includes('${{'))
    .map((l) => at(source, l, 'expression in a run script; pass the value through env:'))
}

/** The only secret besides the job token is the release deploy key (design D7), and only the release workflow may read it. */
function secretReferences(source: Source, lines: Line[]): string[] {
  const allowed = source.path === '.github/workflows/release.yml' ? ['GITHUB_TOKEN', 'RELEASE_DEPLOY_KEY'] : ['GITHUB_TOKEN']
  const out: string[] = []
  for (const line of lines) {
    if (line.kind === 'comment' || line.kind === 'blank') continue
    if (line.kind === 'node' && line.key === 'secrets') {
      out.push(at(source, line, 'secrets: passes repository secrets on'))
      continue
    }
    for (const [, expression = ''] of line.body.matchAll(/\$\{\{(.*?)\}\}/g)) {
      for (const match of expression.matchAll(/\bsecrets\b(?:\.([A-Za-z_][A-Za-z0-9_]*))?/g)) {
        if (match[1] === undefined || !allowed.includes(match[1])) out.push(at(source, line, `secret reference not allowed here: ${match[0]}`))
      }
    }
  }
  return out
}

/** Jobs that may hold a write scope, and which (design goals and D7, D9). Everything else is read-only. */
const writeScopes: Readonly<Record<string, readonly string[]>> = {
  '.github/workflows/release.yml#publish': ['contents', 'id-token', 'attestations'],
  '.github/workflows/nightly.yml#report': ['issues'],
  '.github/workflows/security.yml#codeql': ['security-events'],
}

interface Job {
  name: string
  header: Line
  /** Indexes into the parsed lines: the header and every line up to the next job. */
  start: number
  end: number
}

/** Index range of a top-level key's block (the key line through the line before the next top-level node). */
function topLevelBlock(lines: Line[], key: string): { start: number; end: number } | undefined {
  const start = lines.findIndex((l) => l.kind === 'node' && l.indent === 0 && l.key === key)
  if (start < 0) return undefined
  const next = lines.findIndex((l, i) => i > start && l.kind === 'node' && l.indent === 0)
  return { start, end: next < 0 ? lines.length : next }
}

function jobsOf(lines: Line[]): Job[] {
  const block = topLevelBlock(lines, 'jobs')
  if (block === undefined) return []
  const headers: number[] = []
  for (let i = block.start + 1; i < block.end; i++) if (lines[i]?.kind === 'node' && lines[i]?.indent === 2) headers.push(i)
  return headers.map((start, k) => {
    const header = lines[start] as Line
    return { name: header.key ?? header.body, header, start, end: headers[k + 1] ?? block.end }
  })
}

/** Index range of the step that contains the node at `index`. */
function stepAround(lines: Line[], index: number): { start: number; end: number } {
  const line = lines[index] as Line
  let start = index
  if (!line.item) {
    for (let i = index - 1; i >= 0; i--) {
      const l = lines[i] as Line
      if (l.kind !== 'node') continue
      if (l.item && l.indent === line.indent - 2) {
        start = i
        break
      }
      if (l.indent < line.indent) break
    }
  }
  const dash = (lines[start] as Line).indent
  const next = lines.findIndex((l, i) => i > start && l.kind === 'node' && l.indent <= dash)
  return { start, end: next < 0 ? lines.length : next }
}

const within = (lines: Line[], range: { start: number; end: number }): Line[] => lines.slice(range.start, range.end)
const jobAt = (jobs: Job[], index: number): Job | undefined => jobs.find((j) => index >= j.start && index < j.end)

/** A workflow grants nothing at the top level and every job has a timeout. */
function permissionsAndTimeouts(source: Source, lines: Line[]): string[] {
  const out: string[] = []
  const permissions = topLevelBlock(lines, 'permissions')
  const top = permissions === undefined ? undefined : lines[permissions.start]
  if (top === undefined) out.push(`${source.path}: no top-level permissions; declare "permissions: {}"`)
  else if (top.value !== '{}') out.push(at(source, top, 'top-level permissions must be "{}"; grant scopes per job'))
  const jobs = jobsOf(lines)
  if (jobs.length === 0) out.push(`${source.path}: no jobs found`)
  for (const job of jobs) {
    if (job.header.value !== '') {
      out.push(at(source, job.header, `cannot classify job: ${job.header.body}`))
      continue
    }
    const timeout = within(lines, job).some((l) => l.kind === 'node' && l.indent === 4 && l.key === 'timeout-minutes')
    if (!timeout) out.push(at(source, job.header, `job ${job.name} has no timeout-minutes`))
  }
  return out
}

/** A job's `permissions:` grants `write` only where `writeScopes` allows it. */
function unexpectedWrites(source: Source, lines: Line[]): string[] {
  const out: string[] = []
  for (const job of jobsOf(lines)) {
    const allowed = writeScopes[`${source.path}#${job.name}`] ?? []
    const block = lines.findIndex((l, i) => i > job.start && i < job.end && l.kind === 'node' && l.indent === 4 && l.key === 'permissions')
    if (block < 0) continue
    for (let i = block + 1; i < job.end; i++) {
      const l = lines[i] as Line
      if (l.kind !== 'node') continue
      if (l.indent <= 4) break
      if (l.value === 'write' && !allowed.includes(l.key ?? '')) out.push(at(source, l, `job ${job.name} must not have ${l.key ?? l.body}: write`))
    }
  }
  return out
}

/** `actions/checkout` never leaves the token in .git/config, except in the release `publish` job. */
function persistedCredentials(source: Source, lines: Line[]): string[] {
  const out: string[] = []
  const jobs = jobsOf(lines)
  for (const [index, line] of lines.entries()) {
    if (line.kind !== 'node' || line.key !== 'uses' || !(line.value ?? '').startsWith('actions/checkout@')) continue
    if (source.path === '.github/workflows/release.yml' && jobAt(jobs, index)?.name === 'publish') continue
    const step = within(lines, stepAround(lines, index))
    if (!step.some((l) => l.kind === 'node' && l.key === 'persist-credentials' && l.value === 'false')) {
      out.push(at(source, line, 'actions/checkout without "persist-credentials: false"'))
    }
  }
  return out
}

/** What starts Electron in a job: a virtual display, an npm script that launches the app, or Playwright. */
const launchesElectron = /\b(?:xvfb-run|Xvfb)\b|npm run test:(?:integration|e2e|perf|packaging)\b|\bplaywright\b/

/** A job that launches Electron first runs the setup action with `electron: "true"`, which enables user namespaces. */
function electronWithoutNamespaces(source: Source, lines: Line[]): string[] {
  const out: string[] = []
  for (const job of jobsOf(lines)) {
    const first = lines.findIndex((l, i) => i >= job.start && i < job.end && l.kind !== 'comment' && launchesElectron.test(l.body))
    if (first < 0) continue
    const prepared = lines.some((l, i) => {
      if (i < job.start || i >= first || l.kind !== 'node' || l.key !== 'uses' || l.value !== './.github/actions/setup') return false
      return within(lines, stepAround(lines, i)).some((s) => s.kind === 'node' && s.key === 'electron' && /^(["']?)true\1$/.test(s.value ?? ''))
    })
    if (!prepared) out.push(at(source, lines[first] as Line, `job ${job.name} launches Electron before ./.github/actions/setup with electron: "true"`))
  }
  return out
}

function violations(source: Source): string[] {
  const out = forbidden(source)
  if (!isYaml(source.path)) return out
  const lines = parse(source.text)
  out.push(
    ...unclassified(source, lines),
    ...unpinned(source, lines),
    ...broadPermissions(source, lines),
    ...persistedCredentials(source, lines),
    ...scriptExpressions(source, lines),
    ...secretReferences(source, lines),
  )
  if (isWorkflow(source.path)) {
    out.push(...permissionsAndTimeouts(source, lines), ...unexpectedWrites(source, lines), ...electronWithoutNamespaces(source, lines))
  }
  return out
}

// Fixtures: a workflow that satisfies every rule, and single-line edits that each break one.
const sha = '3d3c42e5aac5ba805825da76410c181273ba90b1'
const valid = `name: fixture
on:
  pull_request:
    branches:
      - master
permissions: {}
jobs:
  e2e:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@${sha} # v7.0.1
        with:
          persist-credentials: false
      - uses: ./.github/actions/setup
        with:
          electron: "true"
      - name: End-to-end tests
        run: |
          xvfb-run npm run test:e2e
`
const fixture = (text: string, path = '.github/workflows/fixture.yml'): Source => ({ path, text })
const edit = (from: string, to: string, path?: string): Source => {
  expect(valid, `fixture edit: ${from}`).toContain(from)
  return fixture(valid.replace(from, to), path)
}

describe('workflow policy (design D11)', () => {
  const files = githubFiles()

  it('checks every file under .github/, and they all satisfy the policy', () => {
    expect(files.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        '.github/actions/setup/action.yml',
        '.github/workflows/ci.yml',
        '.github/workflows/security.yml',
        '.github/workflows/nightly.yml',
        '.github/workflows/build.yml',
        '.github/workflows/release.yml',
        '.github/dependabot.yml',
        '.github/CODEOWNERS',
        '.github/pull_request_template.md',
      ]),
    )
    expect(files.flatMap(violations)).toEqual([])
  })

  it('accepts a workflow that follows every rule', () => {
    expect(violations(fixture(valid))).toEqual([])
  })

  it('[spec:quality-gates/unpinned-action-is-rejected] rejects an action referenced by tag, branch or short SHA', () => {
    const checkout = `actions/checkout@${sha} # v7.0.1`
    for (const ref of ['actions/checkout@v7', 'actions/checkout@main', 'actions/checkout@3d3c42e', 'actions/checkout', 'docker://rhysd/actionlint:1.7.12']) {
      expect(violations(edit(checkout, ref)), ref).toEqual([expect.stringContaining('not pinned to a full commit SHA')])
    }
    expect(violations(edit(checkout, `actions/checkout@${sha}`))).toEqual([expect.stringContaining('without a "# vX.Y.Z" comment')])
    expect(violations(edit(checkout, `docker://rhysd/actionlint@sha256:${'b'.repeat(64)}`))).toEqual([])
    // The same rule applies to composite actions and any other YAML under .github/.
    expect(violations(edit(checkout, 'actions/setup-node@v7', '.github/actions/setup/action.yml'))).toEqual([
      expect.stringContaining('not pinned to a full commit SHA'),
    ])
  })

  it('[spec:quality-gates/missing-permissions-or-timeout-is-rejected] rejects a workflow without top-level permissions or a job without a timeout', () => {
    expect(violations(edit('permissions: {}\njobs:', 'jobs:'))).toEqual([expect.stringContaining('no top-level permissions')])
    expect(violations(edit('permissions: {}\njobs:', 'permissions:\n  contents: read\njobs:'))).toEqual([
      expect.stringContaining('top-level permissions must be "{}"'),
    ])
    expect(violations(edit('permissions: {}\njobs:', 'permissions: write-all\njobs:'))).toEqual([
      expect.stringContaining('grants every scope'),
      expect.stringContaining('top-level permissions must be "{}"'),
    ])
    expect(violations(edit('    timeout-minutes: 30\n', ''))).toEqual([expect.stringContaining('job e2e has no timeout-minutes')])
    // A timeout nested deeper (for example on a step) does not count for the job.
    const stepTimeoutOnly = valid.replace('    timeout-minutes: 30\n', '').replace('        run: |', '        timeout-minutes: 5\n        run: |')
    expect(violations(fixture(stepTimeoutOnly))).toEqual([expect.stringContaining('job e2e has no timeout-minutes')])
    expect(violations(fixture(`${valid}  second:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: "true"\n`))).toEqual([
      expect.stringContaining('job second has no timeout-minutes'),
    ])
    expect(violations(fixture(`${valid.slice(0, valid.indexOf('jobs:'))}jobs: {}\n`))).toEqual([expect.stringContaining('no jobs found')])
    // A timeout that never fires, or none at all, is not a timeout.
    for (const minutes of ['0', '121', '360']) {
      expect(violations(edit('timeout-minutes: 30', `timeout-minutes: ${minutes}`)), minutes).toEqual([expect.stringContaining('is outside 1–120')])
    }
    expect(violations(edit('timeout-minutes: 30', 'timeout-minutes: 120'))).toEqual([])
  })

  it('[spec:quality-gates/no-privileged-pull-request-trigger] rejects pull_request_target anywhere', () => {
    expect(violations(edit('  pull_request:\n', '  pull_request_target:\n'))).toEqual([expect.stringContaining('pull_request_target gives')])
    expect(violations(fixture('Never use pull_request_target here.\n', '.github/pull_request_template.md'))).toHaveLength(1)
    expect(violations(edit('  pull_request:\n', '  workflow_run:\n'))).toEqual([expect.stringContaining('workflow_run runs with')])
  })

  it('grants write scopes only to the jobs listed in writeScopes', () => {
    expect(violations(edit('      contents: read\n', '      contents: write\n'))).toEqual([expect.stringContaining('job e2e must not have contents: write')])
    expect(violations(edit('      contents: read\n', '      contents: read\n      pull-requests: write\n'))).toEqual([
      expect.stringContaining('job e2e must not have pull-requests: write'),
    ])
    const publish = valid.replace('  e2e:', '  publish:').replace('      contents: read\n', '      contents: write\n      id-token: write\n      attestations: write\n')
    expect(violations(fixture(publish, '.github/workflows/release.yml'))).toEqual([])
    expect(violations(fixture(publish.replace('attestations: write', 'issues: write'), '.github/workflows/release.yml'))).toEqual([
      expect.stringContaining('job publish must not have issues: write'),
    ])
    // The same job name in another workflow gets nothing.
    expect(violations(fixture(publish, '.github/workflows/ci.yml'))).toHaveLength(3)
  })

  it('keeps repository secrets out of every workflow but the release', () => {
    const withEnv = (value: string): Source => edit('        run: |', `        env:\n          TOKEN: ${value}\n        run: |`)
    expect(violations(withEnv('${{ secrets.GITHUB_TOKEN }}'))).toEqual([])
    expect(violations(withEnv('${{ github.token }}'))).toEqual([])
    expect(violations(withEnv('${{ secrets.NPM_TOKEN }}'))).toEqual([expect.stringContaining('secret reference not allowed here: secrets.NPM_TOKEN')])
    expect(violations(withEnv('${{ toJSON(secrets) }}'))).toEqual([expect.stringContaining('secret reference not allowed here: secrets')])
    expect(violations(withEnv("${{ secrets['NPM_TOKEN'] }}"))).toEqual([expect.stringContaining('secret reference not allowed here: secrets')])
    expect(violations(withEnv('${{ secrets.RELEASE_DEPLOY_KEY }}'))).toHaveLength(1)
    expect(violations(fixture(withEnv('${{ secrets.RELEASE_DEPLOY_KEY }}').text, '.github/workflows/release.yml'))).toEqual([])
    expect(violations(edit('    timeout-minutes: 30\n', '    timeout-minutes: 30\n    secrets: inherit\n'))).toEqual([
      expect.stringContaining('secrets: passes repository secrets on'),
    ])
  })

  it('rejects expressions inside run scripts, which would let inputs inject shell commands', () => {
    expect(violations(edit('xvfb-run npm run test:e2e', 'xvfb-run npm run test:e2e -- --grep "${{ inputs.filter }}"'))).toEqual([
      expect.stringContaining('expression in a run script'),
    ])
    expect(violations(edit('        run: |\n          xvfb-run npm run test:e2e', '        run: xvfb-run npm run test:e2e ${{ github.event.inputs.ref }}'))).toEqual([
      expect.stringContaining('expression in a run script'),
    ])
    // Through env: the shell receives the value as data.
    expect(violations(edit('        run: |', '        env:\n          FILTER: ${{ inputs.filter }}\n        run: |'))).toEqual([])
  })

  it('[spec:quality-gates/sandbox-and-offline-test-are-not-weakened] rejects --no-sandbox, the offline skip, and Electron jobs without user namespaces', () => {
    expect(violations(edit('npm run test:e2e', 'npm run test:e2e -- --no-sandbox'))).toEqual([expect.stringContaining('--no-sandbox disables')])
    expect(violations(edit('        run: |', '        env:\n          VEYDR_ALLOW_SKIP_OFFLINE: "1"\n        run: |'))).toEqual([
      expect.stringContaining('VEYDR_ALLOW_SKIP_OFFLINE lets'),
    ])
    for (const flag of ['--disable-setuid-sandbox', '--disable-gpu-sandbox', '--disable-seccomp-filter-sandbox']) {
      expect(violations(edit('npm run test:e2e', `npm run test:e2e -- ${flag}`)), flag).toEqual([expect.stringContaining(`${flag} weakens`)])
    }
    expect(violations(edit('        run: |', '        env:\n          ELECTRON_DISABLE_SANDBOX: "1"\n        run: |'))).toEqual([
      expect.stringContaining('ELECTRON_DISABLE_SANDBOX disables'),
    ])
    expect(violations(edit('npm run test:e2e', 'node launch.mjs # chromiumSandbox: false'))).toEqual([expect.stringContaining('chromiumSandbox: false disables')])
    expect(violations(edit('          electron: "true"\n', '          electron: "false"\n'))).toEqual([expect.stringContaining('launches Electron before')])
    // Any way of launching Electron counts, not only xvfb-run.
    const unprepared = valid.replace('      - uses: ./.github/actions/setup\n        with:\n          electron: "true"\n', '')
    for (const launch of ['Xvfb :99 &', 'npm run test:e2e', 'npm run test:integration', 'npm run test:perf', 'npm run test:packaging', 'npx playwright test']) {
      const text = unprepared.replace('xvfb-run npm run test:e2e', launch)
      expect(text, launch).toContain(launch)
      expect(violations(fixture(text)), launch).toEqual([expect.stringContaining('launches Electron before')])
    }
    expect(violations(fixture(unprepared.replace('xvfb-run npm run test:e2e', 'npm test')))).toEqual([])
    expect(violations(edit('      - uses: ./.github/actions/setup\n        with:\n          electron: "true"\n', ''))).toEqual([
      expect.stringContaining('launches Electron before'),
    ])

    // The setup action enables user namespaces whenever electron is "true", and fails clearly if they stay unavailable.
    const action = files.find((f) => f.path === '.github/actions/setup/action.yml')
    expect(action).toBeDefined()
    const lines = parse(action?.text ?? '')
    const named = lines.findIndex((l) => l.kind === 'node' && l.key === 'name' && l.value === 'Enable unprivileged user namespaces')
    expect(named).toBeGreaterThan(0)
    const step = within(lines, stepAround(lines, named))
    expect(step).toContainEqual(expect.objectContaining({ key: 'if', value: "inputs.electron == 'true'" }))
    const script = step.filter((l) => l.kind === 'scalar').map((l) => l.body)
    expect(script).toContain('sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0')
    // Exact lines: a reformat of the script must update these assertions deliberately.
    const sysctl = script.indexOf('sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0')
    const user = script.indexOf('if ! unshare --user true; then')
    const net = script.indexOf('if ! unshare --user --map-root-user --net true; then')
    expect([sysctl, user, net].every((i) => i >= 0)).toBe(true)
    expect(sysctl).toBeLessThan(user)
    expect(user).toBeLessThan(net)
    expect(script.filter((l) => l === 'exit 1')).toHaveLength(2)

    // Core dumps are off for Electron jobs, so a crashed renderer is reported at once (docs/ci.md).
    const dumps = lines.findIndex((l) => l.kind === 'node' && l.key === 'name' && l.value === 'Disable core dumps')
    expect(dumps).toBeGreaterThan(named)
    const dumpStep = within(lines, stepAround(lines, dumps))
    expect(dumpStep).toContainEqual(expect.objectContaining({ key: 'if', value: "inputs.electron == 'true'" }))
    expect(dumpStep.filter((l) => l.kind === 'scalar').map((l) => l.body)).toEqual(["sudo sysctl -w fs.suid_dumpable=0 'kernel.core_pattern=|/bin/false'"])
  })

  it('requires persist-credentials: false on every checkout except in the release publish job', () => {
    expect(violations(edit('      - uses: actions/checkout', '      - name: Check out\n        uses: actions/checkout'))).toEqual([])
    expect(violations(edit('          persist-credentials: false\n', ''))).toEqual([expect.stringContaining('without "persist-credentials: false"')])
    expect(violations(edit('persist-credentials: false', 'persist-credentials: true'))).toEqual([
      expect.stringContaining('without "persist-credentials: false"'),
    ])
    const publish = valid.replace('  e2e:', '  publish:').replace('          persist-credentials: false\n', '')
    expect(violations(fixture(publish, '.github/workflows/release.yml'))).toEqual([])
    expect(violations(fixture(publish, '.github/workflows/build.yml'))).toEqual([expect.stringContaining('without "persist-credentials: false"')])
  })

  it('fails on lines it cannot classify instead of passing them', () => {
    const checkout = `      - uses: actions/checkout@${sha} # v7.0.1`
    expect(violations(edit(checkout, `      - { uses: actions/checkout@v7 }`))).toContainEqual(expect.stringContaining('cannot classify'))
    expect(violations(edit(checkout, checkout.replace('- uses', '- "uses"')))).toContainEqual(expect.stringContaining('cannot classify'))
    expect(violations(edit('    permissions:\n      contents: read\n', '    permissions: { contents: write }\n'))).toEqual([
      expect.stringContaining('cannot classify: flow style in permissions'),
    ])
    expect(violations(edit('    timeout-minutes: 30', '    timeout-minutes: ${{ inputs.minutes }}'))).toContainEqual(
      expect.stringContaining('cannot classify: timeout-minutes'),
    )
    expect(violations(edit('    timeout-minutes: 30', '    timeout-minutes: 30 # half an hour'))).toContainEqual(
      expect.stringContaining('cannot classify: timeout-minutes'),
    )
    expect(violations(edit('    timeout-minutes: 30', '\ttimeout-minutes: 30'))).toContainEqual(expect.stringContaining('tab in indentation'))
    expect(violations(edit('    timeout-minutes: 30', '     timeout-minutes: 30'))).toContainEqual(expect.stringContaining('multiple of two spaces'))
    expect(violations(edit('    runs-on: ubuntu-24.04', '    <<: *defaults'))).toContainEqual(expect.stringContaining('cannot classify'))
  })
})

// ci.yml (design D4): the quality gate's triggers, check set, cancellation and aggregate check.

/** Indexes of the nodes directly under the node at `index` (keys or sequence items one level deeper). */
function childrenOf(lines: Line[], index: number): number[] {
  const parent = lines[index] as Line
  const base = parent.indent + (parent.item ? 2 : 0)
  const out: number[] = []
  for (let i = index + 1; i < lines.length; i++) {
    const l = lines[i] as Line
    if (l.kind !== 'node') continue
    if (l.indent <= base) break
    if (l.indent === base + 2) out.push(i)
  }
  return out
}

const childNames = (lines: Line[], index: number): string[] => childrenOf(lines, index).map((i) => (lines[i] as Line).key ?? (lines[i] as Line).body)
const childAt = (lines: Line[], index: number, key: string): number => childrenOf(lines, index).find((i) => (lines[i] as Line).key === key) ?? -1

/** Index ranges of the steps of a job, in order. */
function stepsOf(lines: Line[], job: Job): { start: number; end: number }[] {
  const steps = childAt(lines, job.start, 'steps')
  return steps < 0 ? [] : childrenOf(lines, steps).map((i) => stepAround(lines, i))
}

/** The node for `key` on a step itself (not nested under `with:` or `env:`). */
function stepField(lines: Line[], step: { start: number; end: number }): (key: string) => Line | undefined {
  const dash = (lines[step.start] as Line).indent
  return (key) => within(lines, step).find((l) => l.kind === 'node' && l.key === key && (l.item ? l.indent === dash : l.indent === dash + 2))
}

/** A step's `run:` script, with block scalar indentation removed. */
function scriptOf(source: Source, lines: Line[], step: { start: number; end: number }): string | undefined {
  const run = stepField(lines, step)('run')
  if (run === undefined) return undefined
  if (!/^[|>]/.test(run.value ?? '')) return run.value
  const raw = source.text.split('\n')
  const body: Line[] = []
  for (let i = lines.indexOf(run) + 1; i < lines.length && ['scalar', 'blank'].includes((lines[i] as Line).kind); i++) body.push(lines[i] as Line)
  const indent = Math.min(...body.filter((l) => l.kind === 'scalar').map((l) => l.indent))
  return `${body.map((l) => (raw[l.n - 1] ?? '').slice(indent)).join('\n').trimEnd()}\n`
}

type Range = { start: number; end: number }

interface ScriptRun {
  status: number | null
  stdout: string
  stderr: string
}

/**
 * Runs a `run:` script as the runner does for a step without `shell:` (`bash -e`). `env` entries
 * are added to the test's environment; an `undefined` entry removes the variable.
 */
function runScript(script: string, options: { env?: Record<string, string | undefined>; cwd?: string } = {}): ScriptRun {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[name]
    else env[name] = value
  }
  const run = spawnSync('bash', ['-e', '-c', script], { encoding: 'utf8', env, cwd: options.cwd })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

const unquote = (value: string | undefined): string | undefined => value?.replace(/^(["'])(.*)\1$/, '$2')

/** A workflow under .github/workflows/ with lookups by trigger, job, step and key. A missing file loads as empty, so its tests fail instead of erroring. */
function loadWorkflow(path: string) {
  const source = githubFiles().find((f) => f.path === path) ?? fixture('', path)
  const lines = parse(source.text)
  const jobs = jobsOf(lines)
  const job = (name: string): Job => {
    const found = jobs.find((j) => j.name === name)
    expect(found, `job ${name} in ${path}`).toBeDefined()
    return found as Job
  }
  const jobField = (name: string, key: string): Line | undefined => {
    const index = childAt(lines, job(name).start, key)
    return index < 0 ? undefined : lines[index]
  }
  /** The `key: value` pairs under a job's `permissions:`, or its inline value (`{}`). */
  const permissions = (name: string): Record<string, string> | string | undefined => {
    const block = jobField(name, 'permissions')
    if (block === undefined) return undefined
    if (block.value !== '') return block.value
    return Object.fromEntries(childrenOf(lines, lines.indexOf(block)).map((i) => [(lines[i] as Line).key ?? '', (lines[i] as Line).value ?? '']))
  }
  const steps = (name: string): Range[] => stepsOf(lines, job(name))
  const field = (step: Range, key: string): string | undefined => stepField(lines, step)(key)?.value
  const script = (step: Range): string | undefined => scriptOf(source, lines, step)
  const scripts = (name: string): string[] => steps(name).flatMap((s) => script(s) ?? []).map((s) => s.trim())
  /** The value of `key` under a step's `with:`; a block scalar's lines are joined with newlines. */
  const withValue = (step: Range, key: string): string | undefined => {
    const block = stepField(lines, step)('with')
    if (block === undefined) return undefined
    const index = childAt(lines, lines.indexOf(block), key)
    if (index < 0) return undefined
    const line = lines[index] as Line
    if (!/^[|>]/.test(line.value ?? '')) return line.value
    const body: string[] = []
    for (let i = index + 1; i < lines.length && (lines[i] as Line).kind === 'scalar'; i++) body.push((lines[i] as Line).body)
    return body.join('\n')
  }
  /** The steps of a job that use an action whose reference starts with `action@`. */
  const stepsUsing = (name: string, action: string): Range[] => steps(name).filter((s) => (field(s, 'uses') ?? '').startsWith(`${action}@`))
  const on = topLevelBlock(lines, 'on')?.start ?? -1
  const triggers = (): string[] => childNames(lines, on).sort()
  const trigger = (name: string): number => {
    const index = childAt(lines, on, name)
    expect(index, `trigger ${name} in ${path}`).toBeGreaterThan(0)
    return index
  }
  const branches = (name: string): string[] => childNames(lines, childAt(lines, trigger(name), 'branches'))
  /** The cron expressions of the `schedule` trigger. */
  const crons = (): (string | undefined)[] => childrenOf(lines, trigger('schedule')).map((i) => unquote((lines[i] as Line).value))
  /** The `workflow_dispatch` inputs, each as its `key: value` fields. */
  const dispatchInputs = (): Record<string, Record<string, string>> => {
    const inputs = childAt(lines, trigger('workflow_dispatch'), 'inputs')
    if (inputs < 0) return {}
    return Object.fromEntries(
      childrenOf(lines, inputs).map((i) => [
        (lines[i] as Line).key ?? '',
        Object.fromEntries(childrenOf(lines, i).map((j) => [(lines[j] as Line).key ?? '', unquote((lines[j] as Line).value) ?? ''])),
      ]),
    )
  }
  /** Runs the `run:` script of the step with this `name:`, with the environment its `env:` would give it replaced by `env`. */
  const runStep = (name: string, step: string, options: { env?: Record<string, string | undefined>; cwd?: string } = {}): ScriptRun => {
    const found = steps(name).find((s) => field(s, 'name') === step)
    expect(found, `step "${step}" in job ${name}`).toBeDefined()
    const text = found === undefined ? undefined : script(found)
    expect(text, `script of step "${step}"`).toBeDefined()
    return runScript(text ?? 'exit 2', options)
  }
  return { source, lines, jobs, job, jobField, permissions, steps, field, scripts, withValue, stepsUsing, on, triggers, trigger, branches, crons, dispatchInputs, runStep }
}

/** Non-comment lines of a file that contain any of `needles`. */
const linesContaining = (source: Source, needles: readonly string[]): string[] =>
  parse(source.text)
    .filter((l) => l.kind !== 'comment' && l.kind !== 'blank' && needles.some((n) => l.body.includes(n)))
    .map((l) => `${source.path}:${l.n}: ${l.body}`)

describe('ci.yml (design D4)', () => {
  const { source: ci, lines, jobs, job, jobField, permissions, scripts, withValue, on, branches } = loadWorkflow('.github/workflows/ci.yml')
  /** Runs ci-ok's script as the runner does (`bash -e`), with `NEEDS` set to `needs` or left unset. */
  const runCiOk = (needs: string | undefined): { status: number | null; stdout: string } => {
    const step = stepsOf(lines, job('ci-ok')).find((s) => stepField(lines, s)('run') !== undefined)
    const script = step === undefined ? undefined : scriptOf(ci, lines, step)
    expect(script).toBeDefined()
    const run = runScript(script ?? 'exit 2', { env: { NEEDS: needs } })
    return { status: run.status, stdout: run.stdout }
  }
  /** ci-ok with `needs` shaped like GitHub's `toJSON(needs)`: `{ job: { result, outputs } }`. */
  const ciOk = (results: Record<string, string>): { status: number | null; stdout: string } =>
    runCiOk(JSON.stringify(Object.fromEntries(Object.entries(results).map(([name, result]) => [name, { result, outputs: {} }]))))
  /** Every job but the aggregate is a check of the set. */
  const checks = (): string[] => jobs.map((j) => j.name).filter((name) => name !== 'ci-ok')

  it('exists and has the expected jobs', () => {
    expect(ci.text).not.toBe('')
    expect(jobs.map((j) => j.name)).toEqual(['static', 'unit', 'integration', 'e2e', 'package', 'windows', 'ci-ok'])
  })

  it('never skips a check step while the job still succeeds', () => {
    // A step whose `if:` is false is skipped and its job stays green, so ci-ok would pass without the
    // check. Exact conditions: changing one must update this test deliberately.
    const guard = "${{ !cancelled() && steps.setup.outcome == 'success' }}"
    const conditions = (name: string): (string | undefined)[] => stepsOf(lines, job(name)).map((s) => stepField(lines, s)('if')?.value)
    expect(conditions('static')).toEqual([undefined, undefined, guard, guard, guard, guard, guard])
    expect(conditions('unit')).toEqual([undefined, undefined, undefined])
    expect(conditions('integration')).toEqual([undefined, undefined, undefined])
    expect(conditions('e2e')).toEqual([undefined, undefined, undefined, 'failure()'])
    expect(conditions('package')).toEqual([undefined, undefined, undefined, undefined])
    expect(conditions('windows')).toEqual([undefined, undefined, guard, guard, guard])
    // The guard refers to the setup step by its id, so the setup step must keep it.
    for (const name of ['static', 'windows']) {
      const setup = stepsOf(lines, job(name)).map((s) => stepField(lines, s))[1]
      expect(setup?.('id')?.value, name).toBe('setup')
      expect(setup?.('uses')?.value, name).toBe('./.github/actions/setup')
    }
  })

  it('uploads the E2E results on failure and the packages for seven days', () => {
    const upload = (name: string): { start: number; end: number } => {
      const steps = stepsOf(lines, job(name)).filter((s) => /^actions\/upload-artifact@[0-9a-f]{40}\s/.test(stepField(lines, s)('uses')?.value ?? ''))
      expect(steps, `uploads in ${name}`).toHaveLength(1)
      return steps[0] as { start: number; end: number }
    }
    const results = upload('e2e')
    expect(stepField(lines, results)('if')?.value).toBe('failure()')
    expect(withValue(results, 'name')).toBe('e2e-test-results')
    expect(withValue(results, 'path')).toBe('test-results/')
    expect(withValue(results, 'retention-days')).toBe('7')
    const packages = upload('package')
    expect(stepField(lines, packages)('if')).toBeUndefined()
    expect(withValue(packages, 'name')).toBe('linux-packages')
    expect(withValue(packages, 'path')).toBe('dist/*.deb\ndist/*.AppImage')
    expect(withValue(packages, 'retention-days')).toBe('7')
    // A packaging run that produced no packages must fail, not upload nothing.
    expect(withValue(packages, 'if-no-files-found')).toBe('error')
  })

  it('[spec:quality-gates/pull-request-runs-the-full-check-set] runs every check on pull requests to master, against the merge commit', () => {
    expect(childNames(lines, on).sort()).toEqual(['merge_group', 'pull_request', 'push'])
    expect(childNames(lines, childAt(lines, on, 'pull_request'))).toEqual(['branches'])
    expect(branches('pull_request')).toEqual(['master'])
    // Each check of the spec runs the same npm script a developer runs locally (docs/ci.md#ci).
    const commands: readonly (readonly [string, string, string])[] = [
      ['typecheck', 'static', 'npm run typecheck'],
      ['lint', 'static', 'npm run lint'],
      ['spec coverage', 'static', 'npm run spec-coverage'],
      ['unit', 'unit', 'npm test'],
      ['integration', 'integration', 'xvfb-run --auto-servernum npm run test:integration'],
      ['end-to-end', 'e2e', 'xvfb-run --auto-servernum npm run test:e2e'],
      ['packaging', 'package', 'xvfb-run --auto-servernum npm run test:packaging'],
    ]
    for (const [check, name, command] of commands) expect(scripts(name), check).toContain(command)
    // Typecheck, lint, and unit tests also run on Windows, against the same commit.
    expect(jobField('windows', 'runs-on')?.value).toBe('windows-2025')
    expect(scripts('windows')).toEqual(['npm run typecheck', 'npm run lint', 'npm test'])
    const actionlint = stepsOf(lines, job('static')).map((s) => stepField(lines, s)('uses')?.value ?? '')
    expect(actionlint).toContainEqual(expect.stringMatching(/^docker:\/\/rhysd\/actionlint@sha256:[0-9a-f]{64}$/))
    // The default checkout of a pull_request run is the merge commit; nothing overrides it, and no
    // check is allowed to fail without failing its job.
    expect(lines.filter((l) => l.kind === 'node' && (l.key === 'ref' || l.key === 'continue-on-error'))).toEqual([])
  })

  it('runs the Windows checks with read-only contents and without Electron (design D6)', () => {
    expect(permissions('windows')).toEqual({ contents: 'read' })
    const setup = stepsOf(lines, job('windows'))[1]
    expect(setup).toBeDefined()
    expect(withValue(setup ?? { start: 0, end: 0 }, 'electron')).toBeUndefined()
    // No Windows job downloads Electron, so the setup action leaves its Linux cache out there.
    const action = parse(githubFiles().find((f) => f.path === '.github/actions/setup/action.yml')?.text ?? '')
    const cache = action.findIndex((l) => l.kind === 'node' && l.key === 'name' && l.value === 'Cache Electron and electron-builder downloads')
    expect(cache).toBeGreaterThan(0)
    expect(within(action, stepAround(action, cache))).toContainEqual(
      expect.objectContaining({ key: 'if', value: "inputs.cache == 'true' && inputs.dependencies == 'true' && runner.os != 'Windows'" }),
    )
  })

  it('[spec:quality-gates/push-to-master-runs-the-same-checks] runs the same checks on pushes to master', () => {
    expect(branches('push')).toEqual(['master'])
    expect(childNames(lines, childAt(lines, on, 'push'))).toEqual(['branches'])
    // No job or step depends on which event started the run, so a push runs exactly what a pull request runs.
    const block = topLevelBlock(lines, 'jobs')
    expect(block).toBeDefined()
    const eventDependent = within(lines, block ?? { start: 0, end: 0 }).filter((l) => l.kind !== 'comment' && /\bgithub\.(?:event|ref|head_ref|base_ref)\b/.test(l.body))
    expect(eventDependent).toEqual([])
    for (const name of checks()) expect(jobField(name, 'if'), `job ${name}`).toBeUndefined()
  })

  it('[spec:quality-gates/superseded-pull-request-runs-are-cancelled] cancels a pull request run superseded by a newer push, and nothing else', () => {
    const concurrency = topLevelBlock(lines, 'concurrency')?.start ?? -1
    expect(concurrency).toBeGreaterThan(0)
    // Exact text: a change here must update this test deliberately. Pull requests share a group per
    // number; any other run (a push to master, a merge group) has a group of its own, so none is dropped.
    expect(lines[childAt(lines, concurrency, 'group')]?.value).toBe(
      "ci-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.run_id }}",
    )
    expect(lines[childAt(lines, concurrency, 'cancel-in-progress')]?.value).toBe("${{ github.event_name == 'pull_request' }}")
  })

  it('aggregates every other job in ci-ok, whatever their outcome', () => {
    expect(jobField('ci-ok', 'if')?.value).toBe('always()')
    expect(childNames(lines, childAt(lines, job('ci-ok').start, 'needs')).sort()).toEqual(checks().sort())
    expect(jobField('ci-ok', 'permissions')?.value).toBe('{}')
    const env = stepsOf(lines, job('ci-ok')).flatMap((s) => within(lines, s)).filter((l) => l.key === 'NEEDS')
    expect(env.map((l) => l.value)).toEqual(['${{ toJSON(needs) }}'])
  })

  it('[spec:quality-gates/all-checks-pass] succeeds when every check succeeded', () => {
    const run = ciOk(Object.fromEntries(checks().map((name) => [name, 'success'])))
    expect(run.status, run.stdout).toBe(0)
    for (const name of checks()) expect(run.stdout).toContain(`${name}: success`)
  })

  // About 40 runs of the script; starting bash and Node takes much longer on Windows than on Linux.
  it('[spec:quality-gates/one-check-fails-or-is-skipped] fails when any check failed, was cancelled or was skipped', { timeout: 60_000 }, () => {
    for (const name of checks()) {
      for (const result of ['failure', 'cancelled', 'skipped', 'neutral', '']) {
        const run = ciOk(Object.fromEntries(checks().map((other) => [other, other === name ? result : 'success'])))
        expect(run.status, `${name}: ${result}`).toBe(1)
        expect(run.stdout, `${name}: ${result}`).toContain(`::error title=ci-ok::these checks did not succeed: ${name}\n`)
      }
    }
    const all = ciOk(Object.fromEntries(checks().map((name) => [name, 'skipped'])))
    expect(all.status).toBe(1)
    expect(all.stdout).toContain(`did not succeed: ${checks().join(', ')}`)
    expect(ciOk({}).status).toBe(1)
    // Input it should never get still fails closed: no NEEDS at all, or a job without a result object.
    expect(runCiOk(undefined).status).toBe(1)
    expect(runCiOk('').status).toBe(1)
    const withNull = runCiOk(JSON.stringify({ ...Object.fromEntries(checks().map((name) => [name, { result: 'success' }])), static: null }))
    expect(withNull.status).toBe(1)
    expect(withNull.stdout).toContain('did not succeed: static\n')
  })

  it('[spec:quality-gates/production-dependency-becomes-vulnerable] fails the gate on any known vulnerability in production dependencies', () => {
    // --audit-level=low fails on every severity; --omit=dev limits it to what ships in the packages.
    expect(scripts('static')).toContain('npm audit --omit=dev --audit-level=low')
    expect(childNames(lines, childAt(lines, job('ci-ok').start, 'needs'))).toContain('static')
  })
})

// security.yml (design D1): CodeQL on pull requests, master and a weekly schedule; dependency review on pull requests.

describe('security.yml', () => {
  const w = loadWorkflow('.github/workflows/security.yml')

  it('exists and has the expected jobs', () => {
    expect(w.source.text).not.toBe('')
    expect(w.jobs.map((j) => j.name)).toEqual(['codeql', 'dependency-review'])
    expect(w.triggers()).toEqual(['merge_group', 'pull_request', 'push', 'schedule'])
    // Every pull request, whatever its base, pushes to master, and merge groups (so a merge queue
    // gets the required dependency-review check, skipped there and so passing).
    expect(childNames(w.lines, w.trigger('merge_group'))).toEqual([])
    expect(childNames(w.lines, w.trigger('pull_request'))).toEqual([])
    expect(w.branches('push')).toEqual(['master'])
    // Same cancellation rule as ci.yml: only a superseded pull request run is cancelled.
    const concurrency = topLevelBlock(w.lines, 'concurrency')?.start ?? -1
    expect(w.lines[childAt(w.lines, concurrency, 'group')]?.value).toBe(
      "security-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.run_id }}",
    )
    expect(w.lines[childAt(w.lines, concurrency, 'cancel-in-progress')]?.value).toBe("${{ github.event_name == 'pull_request' }}")
    // Neither check may fail without failing its job.
    expect(w.lines.filter((l) => l.kind === 'node' && l.key === 'continue-on-error')).toEqual([])
  })

  it('[spec:quality-gates/weekly-analysis-without-code-changes] analyses JavaScript and TypeScript with CodeQL on pull requests, master and every week', () => {
    // One weekly schedule: fixed minute and hour, any day of the month and month, one day of the week.
    // GitHub runs scheduled workflows on the default branch, master.
    expect(w.crons()).toHaveLength(1)
    expect(w.crons()[0]).toMatch(/^\d{1,2} \d{1,2} \* \* [0-7]$/)
    // CodeQL runs for every trigger, the schedule included.
    expect(w.jobField('codeql', 'if')).toBeUndefined()
    expect(w.permissions('codeql')).toEqual({ actions: 'read', contents: 'read', 'security-events': 'write' })
    const init = w.stepsUsing('codeql', 'github/codeql-action/init')
    const analyze = w.stepsUsing('codeql', 'github/codeql-action/analyze')
    expect(init).toHaveLength(1)
    expect(analyze).toHaveLength(1)
    const [initStep, analyzeStep] = [init[0] as Range, analyze[0] as Range]
    expect(w.withValue(initStep, 'languages')).toBe('javascript-typescript')
    expect(w.withValue(initStep, 'build-mode')).toBe('none')
    expect(initStep.start).toBeLessThan(analyzeStep.start)
    // init and analyze come from the same release.
    expect(w.field(initStep, 'uses')?.split('@')[1]).toBe(w.field(analyzeStep, 'uses')?.split('@')[1])
    expect(w.field(analyzeStep, 'if')).toBeUndefined()
  })

  it('[spec:quality-gates/pull-request-adds-a-vulnerable-dependency] fails a pull request that adds a dependency with a moderate or higher vulnerability', () => {
    // The ruleset requires this check by its name.
    expect(w.jobField('dependency-review', 'name')?.value).toBe('dependency-review')
    expect(w.jobField('dependency-review', 'if')?.value).toBe("github.event_name == 'pull_request'")
    expect(w.permissions('dependency-review')).toEqual({ contents: 'read' })
    const review = w.stepsUsing('dependency-review', 'actions/dependency-review-action')
    expect(review).toHaveLength(1)
    const step = review[0] as Range
    expect(w.withValue(step, 'fail-on-severity')).toBe('moderate')
    // The action's default fails only on runtime dependencies; development dependencies run in CI too.
    expect(w.withValue(step, 'fail-on-scopes')?.split(',').map((s) => s.trim()).sort()).toEqual(['development', 'runtime', 'unknown'])
    // Nothing turns the verdict into a warning or exempts an advisory.
    for (const key of ['warn-only', 'allow-ghsas', 'vulnerability-check', 'config-file']) expect(w.withValue(step, key), key).toBeUndefined()
    expect(w.field(step, 'if')).toBeUndefined()
  })
})

// dependabot.yml (design D10): weekly npm and GitHub Actions updates, npm held back like .npmrc's min-release-age.

describe('dependabot.yml (design D10)', () => {
  const source = githubFiles().find((f) => f.path === '.github/dependabot.yml') ?? fixture('', '.github/dependabot.yml')
  const lines = parse(source.text)
  const updates = topLevelBlock(lines, 'updates')?.start ?? -1
  const entries = updates < 0 ? [] : childrenOf(lines, updates)
  /** The update entry for an ecosystem, as a lookup of its fields. */
  const entry = (ecosystem: string): ((key: string) => number) => {
    const found = entries.filter((i) => (lines[i] as Line).key === 'package-ecosystem' && (lines[i] as Line).value === ecosystem)
    expect(found, `updates entry for ${ecosystem}`).toHaveLength(1)
    const fields = stepField(lines, stepAround(lines, found[0] ?? 0))
    return (key) => {
      const line = fields(key)
      return line === undefined ? -1 : lines.indexOf(line)
    }
  }
  const value = (index: number, key: string): string | undefined => unquote(lines[childAt(lines, index, key)]?.value)
  /** Group name → its `patterns` and `update-types` items. */
  const groups = (field: (key: string) => number): Record<string, Record<string, string[]>> =>
    Object.fromEntries(
      childrenOf(lines, field('groups')).map((g) => [
        (lines[g] as Line).key ?? '',
        Object.fromEntries(childrenOf(lines, g).map((k) => [(lines[k] as Line).key ?? '', childNames(lines, k).map((n) => unquote(n) ?? '')])),
      ]),
    )
  const minReleaseAge = /^min-release-age=(\d+)$/m.exec(readFileSync(join(root, '.npmrc'), 'utf8'))?.[1]

  it('exists and covers exactly npm and GitHub Actions', () => {
    expect(lines[topLevelBlock(lines, 'version')?.start ?? -1]?.value).toBe('2')
    expect(entries.map((i) => `${(lines[i] as Line).key ?? ''}: ${(lines[i] as Line).value ?? ''}`)).toEqual([
      'package-ecosystem: npm',
      'package-ecosystem: github-actions',
    ])
  })

  it('[spec:quality-gates/freshly-published-version-is-not-proposed] proposes npm updates weekly, and none younger than min-release-age', () => {
    const npm = entry('npm')
    expect(lines[npm('directory')]?.value).toBe('/')
    expect(value(npm('schedule'), 'interval')).toBe('weekly')
    // The cooldown is the same number of days as .npmrc's min-release-age, so a proposed version
    // always installs. One key only: a shorter per-semver cooldown would undercut it.
    expect(minReleaseAge).toBe('7')
    expect(childNames(lines, npm('cooldown'))).toEqual(['default-days'])
    expect(value(npm('cooldown'), 'default-days')).toBe(minReleaseAge)
    // Minor and patch updates in one pull request; major updates each get their own.
    expect(groups(npm)).toEqual({ 'npm-minor-and-patch': { patterns: ['*'], 'update-types': ['minor', 'patch'] } })
    // Nothing filters what Dependabot may propose.
    for (const key of ['allow', 'ignore', 'target-branch']) expect(npm(key), key).toBe(-1)
  })

  it('proposes GitHub Actions updates weekly, in one group, for the workflows and the local composite actions', () => {
    const actions = entry('github-actions')
    expect(value(actions('schedule'), 'interval')).toBe('weekly')
    expect(childNames(lines, actions('directories'))).toEqual(['/', '/.github/actions/*'])
    // Every local action sits where the glob finds it.
    const local = githubFiles().filter((f) => f.path.startsWith('.github/actions/')).map((f) => f.path)
    expect(local.length).toBeGreaterThan(0)
    for (const path of local) expect(path, path).toMatch(/^\.github\/actions\/[^/]+\/action\.ya?ml$/)
    expect(value(actions('cooldown'), 'default-days')).toBe('7')
    expect(groups(actions)).toEqual({ 'github-actions': { patterns: ['*'] } })
  })
})

// nightly.yml (design D9): the slow checks on a schedule and on demand, reported in one tracking issue.

// These tests run the step scripts with bash, a fake gh and git; starting those processes takes
// several times longer on the Windows runner than on Linux. A hang still fails, after a minute.
describe('nightly.yml (design D9)', { timeout: 60_000 }, () => {
  const w = loadWorkflow('.github/workflows/nightly.yml')
  const checks = ['perf', 'smoke', 'acceptance']

  /** Runs the report step with a fake `gh` that logs its arguments; `openIssue` is what `gh issue list` prints. */
  const report = (options: { openIssue?: string; failOn?: string; env?: Record<string, string> } = {}): { run: ScriptRun; calls: string[][] } => {
    const dir = mkdtempSync(join(tmpdir(), 'veydr-nightly-report-'))
    try {
      const log = join(dir, 'gh.log')
      writeFileSync(
        join(dir, 'gh'),
        `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n')
if (process.env.FAKE_GH_FAIL && args.slice(0, 2).join(' ') === process.env.FAKE_GH_FAIL) process.exit(1)
if (args[0] === 'issue' && args[1] === 'list') process.stdout.write(process.env.FAKE_OPEN_ISSUE ? process.env.FAKE_OPEN_ISSUE + '\\n' : '')
`,
      )
      chmodSync(join(dir, 'gh'), 0o755)
      const needs = { perf: { result: 'success', outputs: {} }, smoke: { result: 'failure', outputs: {} }, acceptance: { result: 'cancelled', outputs: {} } }
      const run = w.runStep('report', 'Report the failure', {
        env: {
          PATH: `${dir}:${process.env['PATH'] ?? ''}`,
          GH_LOG: log,
          FAKE_OPEN_ISSUE: options.openIssue,
          FAKE_GH_FAIL: options.failOn,
          GH_TOKEN: 'token',
          GH_REPO: 'owner/veydr',
          RUN_URL: 'https://github.com/owner/veydr/actions/runs/123',
          EVENT: 'schedule',
          REQUESTED_REF: '',
          RUN_REF: 'master',
          SHA: 'a'.repeat(40),
          NEEDS: JSON.stringify(needs),
          ...options.env,
        },
      })
      const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []
      return { run, calls }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const body = (call: string[] | undefined): string => call?.[call.indexOf('--body') + 1] ?? ''

  it('exists, has the expected jobs, and never blocks a merge', () => {
    expect(w.source.text).not.toBe('')
    expect(w.jobs.map((j) => j.name)).toEqual([...checks, 'report'])
    // Only a schedule and manual runs: no pull request or push trigger, so no required check comes from here.
    expect(w.triggers()).toEqual(['schedule', 'workflow_dispatch'])
    for (const name of checks) expect(w.permissions(name), name).toEqual({ contents: 'read' })
  })

  it('[spec:quality-gates/nightly-run-on-demand] runs perf, the smoke matrix and the acceptance pass nightly and on demand, against the selected ref', () => {
    // Daily: fixed minute and hour, every day.
    expect(w.crons()).toHaveLength(1)
    expect(w.crons()[0]).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/)
    expect(Object.keys(w.dispatchInputs())).toEqual(['ref'])
    expect(w.dispatchInputs()).toMatchObject({ ref: { type: 'string', required: 'false', default: '' } })
    // Every check job checks out the requested ref (empty on a schedule: the default branch).
    for (const name of checks) {
      const checkout = w.stepsUsing(name, 'actions/checkout')
      expect(checkout, name).toHaveLength(1)
      expect(w.withValue(checkout[0] as Range, 'ref'), name).toBe('${{ inputs.ref }}')
      expect(w.jobField(name, 'if'), name).toBeUndefined()
    }
    expect(w.scripts('perf')).toEqual(['xvfb-run --auto-servernum npm run test:perf'])
    expect(w.scripts('smoke')).toEqual(['npm run dist:linux', 'scripts/smoke-linux.sh'])
    expect(w.scripts('acceptance')).toEqual(['npm run dist:linux', 'scripts/acceptance-linux.sh'])
    // The containers need user namespaces too, which only the setup action's electron mode enables.
    for (const name of ['smoke', 'acceptance']) {
      const setup = w.steps(name).find((s) => w.field(s, 'uses') === './.github/actions/setup')
      expect(setup === undefined ? undefined : w.withValue(setup, 'electron'), name).toBe('"true"')
    }
    // Their results are kept whether they pass or fail.
    const uploads: readonly (readonly [string, string, string, string])[] = [
      ['perf', 'failure()', 'perf-test-results', 'test-results/'],
      ['smoke', '${{ !cancelled() }}', 'smoke-linux', 'test-results/smoke-linux/'],
      ['acceptance', '${{ !cancelled() }}', 'acceptance-linux', 'test-results/acceptance-linux/'],
    ]
    for (const [name, condition, artifact, path] of uploads) {
      const upload = w.stepsUsing(name, 'actions/upload-artifact')
      expect(upload, name).toHaveLength(1)
      const step = upload[0] as Range
      expect(w.field(step, 'if'), name).toBe(condition)
      expect(w.withValue(step, 'name'), name).toBe(artifact)
      expect(w.withValue(step, 'path'), name).toBe(path)
    }
    // No check step is skipped while its job still succeeds: the only conditions are on the uploads.
    for (const name of checks) {
      const conditions = w.steps(name).map((s) => w.field(s, 'if')).filter((c) => c !== undefined)
      expect(conditions, name).toEqual([uploads.find(([job]) => job === name)?.[1]])
    }
  })

  it('[spec:quality-gates/nightly-failure-is-reported-once] comments on the open nightly-failure issue, and opens one only if none is open', () => {
    expect(w.jobField('report', 'if')?.value).toBe('failure()')
    expect(childNames(w.lines, childAt(w.lines, w.job('report').start, 'needs'))).toEqual(checks)
    expect(w.permissions('report')).toEqual({ issues: 'write' })
    // Reports never run at the same time, so two failing runs cannot each open an issue.
    const concurrency = childAt(w.lines, w.job('report').start, 'concurrency')
    expect(w.lines[childAt(w.lines, concurrency, 'group')]?.value).toBe('nightly-report')
    expect(w.lines[childAt(w.lines, concurrency, 'cancel-in-progress')]?.value).toBe('false')
    // No checkout: the job runs nothing from the repository.
    expect(w.stepsUsing('report', 'actions/checkout')).toEqual([])

    const open = report({ openIssue: '42' })
    expect(open.run.status, open.run.stderr).toBe(0)
    expect(open.calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['label create', 'issue list', 'issue comment'])
    expect(open.calls[1]).toEqual(expect.arrayContaining(['--label', 'nightly-failure', '--state', 'open']))
    expect(open.calls[2]?.[2]).toBe('42')
    expect(body(open.calls[2])).toContain('https://github.com/owner/veydr/actions/runs/123')
    expect(body(open.calls[2])).toContain('Jobs that did not succeed: smoke (failure), acceptance (cancelled)')
    expect(body(open.calls[2])).toContain(`Checked: master at ${'a'.repeat(40)}`)

    const none = report()
    expect(none.run.status, none.run.stderr).toBe(0)
    expect(none.calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['label create', 'issue list', 'issue create'])
    expect(none.calls[2]).toEqual(expect.arrayContaining(['--label', 'nightly-failure']))
    expect(body(none.calls[2])).toContain('https://github.com/owner/veydr/actions/runs/123')

    // A manual run names the ref it was asked to check.
    const dispatched = report({ env: { EVENT: 'workflow_dispatch', REQUESTED_REF: 'feature/x' } })
    expect(body(dispatched.calls[2])).toContain('Checked: feature/x\n')
    // Unreadable job results still produce a report.
    const garbled = report({ env: { NEEDS: 'not json' } })
    expect(garbled.run.status, garbled.run.stderr).toBe(0)
    expect(body(garbled.calls[2])).toContain('Jobs that did not succeed: unknown')
    // A failing gh call fails the job instead of losing the report silently.
    for (const failOn of ['label create', 'issue list', 'issue comment']) {
      expect(report({ openIssue: '42', failOn }).run.status, failOn).not.toBe(0)
    }
    expect(report({ failOn: 'issue create' }).run.status).not.toBe(0)
  })
})

// build.yml: packages of any ref as workflow artifacts, never a release.

describe('build.yml', () => {
  const w = loadWorkflow('.github/workflows/build.yml')

  /** Runs the SHA256SUMS step in a directory holding `files`; returns the run and the SHA256SUMS it wrote. */
  const checksums = (files: string[]): { run: ScriptRun; sums: string | undefined } => {
    const dir = mkdtempSync(join(tmpdir(), 'veydr-build-sums-'))
    try {
      for (const file of files) writeFileSync(join(dir, file), `contents of ${file}\n`)
      const run = w.runStep('package', 'Write SHA256SUMS', { cwd: dir })
      const sums = existsSync(join(dir, 'SHA256SUMS')) ? readFileSync(join(dir, 'SHA256SUMS'), 'utf8') : undefined
      return { run, sums }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('exists and has the expected jobs', () => {
    expect(w.source.text).not.toBe('')
    expect(w.jobs.map((j) => j.name)).toEqual(['package', 'smoke'])
  })

  // Git Bash's sha256sum marks files as binary (`*name`); the step only ever runs on the ubuntu runner.
  it.skipIf(process.platform !== 'linux')('[linux-only: GNU sha256sum text-mode output] [spec:release-automation/building-a-branch] builds the packages and SHA256SUMS of any ref as artifacts, and changes nothing in the repository', () => {
    // Manual only, for any branch, tag or commit.
    expect(w.triggers()).toEqual(['workflow_dispatch'])
    expect(Object.keys(w.dispatchInputs())).toEqual(['ref', 'smoke'])
    expect(w.dispatchInputs()).toMatchObject({
      ref: { type: 'string', required: 'false', default: '' },
      smoke: { type: 'boolean', required: 'false', default: 'false' },
    })
    // package builds the requested ref and records the commit; smoke checks out that same commit,
    // so its script matches the packages even if the branch moved in between.
    const checkoutRef = (name: string): string | undefined => {
      const checkout = w.stepsUsing(name, 'actions/checkout')
      expect(checkout, name).toHaveLength(1)
      return w.withValue(checkout[0] as Range, 'ref')
    }
    expect(checkoutRef('package')).toBe('${{ inputs.ref }}')
    expect(checkoutRef('smoke')).toBe('${{ needs.package.outputs.sha }}')
    expect(w.lines[childAt(w.lines, childAt(w.lines, w.job('package').start, 'outputs'), 'sha')]?.value).toBe('${{ steps.source.outputs.sha }}')
    const source = w.steps('package').find((s) => w.field(s, 'id') === 'source')
    expect(source === undefined ? undefined : w.field(source, 'run')).toBe('echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"')
    for (const name of ['package', 'smoke']) {
      // Read-only, so the job could not push, tag or release even if a step tried.
      expect(w.permissions(name), name).toEqual({ contents: 'read' })
    }
    expect(linesContaining(w.source, ['git push', 'git tag', 'git commit', 'gh release', 'npm version', 'release-version.mjs'])).toEqual([])

    expect(w.scripts('package')).toContain('xvfb-run --auto-servernum npm run test:packaging')
    const sums = w.steps('package').find((s) => w.field(s, 'name') === 'Write SHA256SUMS')
    expect(sums === undefined ? undefined : w.field(sums, 'working-directory')).toBe('dist')
    const upload = w.stepsUsing('package', 'actions/upload-artifact')
    expect(upload).toHaveLength(1)
    const step = upload[0] as Range
    expect(w.withValue(step, 'name')).toBe('linux-packages')
    expect(w.withValue(step, 'path')).toBe('dist/*.deb\ndist/*.AppImage\ndist/SHA256SUMS')
    expect(w.withValue(step, 'retention-days')).toBe('14')
    expect(w.withValue(step, 'if-no-files-found')).toBe('error')
    expect(w.steps('package').map((s) => w.field(s, 'if')).filter((c) => c !== undefined)).toEqual([])

    // The checksum step covers exactly the .deb and the AppImage, and checks what it wrote.
    const good = checksums(['Veydr-1.2.3-amd64.deb', 'Veydr-1.2.3-x86_64.AppImage', 'builder-debug.yml'])
    expect(good.run.status, good.run.stdout).toBe(0)
    const digest = (file: string): string => createHash('sha256').update(`contents of ${file}\n`).digest('hex')
    expect(good.sums).toBe(['Veydr-1.2.3-amd64.deb', 'Veydr-1.2.3-x86_64.AppImage'].map((f) => `${digest(f)}  ${f}\n`).join(''))
    // Anything other than one of each fails instead of publishing a partial or ambiguous set.
    for (const files of [[], ['Veydr-1.2.3-amd64.deb'], ['Veydr-1.2.3-x86_64.AppImage'], ['a.deb', 'b.deb', 'Veydr-1.2.3-x86_64.AppImage']]) {
      const bad = checksums(files)
      expect(bad.run.status, files.join(' ')).toBe(1)
      expect(bad.run.stdout, files.join(' ')).toContain('::error title=Unexpected packages::')
    }
  })

  it('[spec:release-automation/optional-smoke-matrix-on-a-manual-build] runs the smoke matrix on the built packages only when asked, and keeps its results', () => {
    expect(w.jobField('smoke', 'if')?.value).toBe('inputs.smoke')
    expect(childNames(w.lines, childAt(w.lines, w.job('smoke').start, 'needs'))).toEqual(['package'])
    // It tests the uploaded packages, not a rebuild, after checking them against SHA256SUMS.
    const download = w.stepsUsing('smoke', 'actions/download-artifact')
    expect(download).toHaveLength(1)
    expect(w.withValue(download[0] as Range, 'name')).toBe('linux-packages')
    expect(w.withValue(download[0] as Range, 'path')).toBe('dist')
    expect(w.scripts('smoke')).toEqual(['sha256sum -c SHA256SUMS', 'scripts/smoke-linux.sh'])
    expect(w.scripts('smoke').join('\n')).not.toMatch(/npm run (?:dist|build|test:packaging)/)
    const setup = w.steps('smoke').find((s) => w.field(s, 'uses') === './.github/actions/setup')
    expect(setup === undefined ? undefined : w.withValue(setup, 'electron')).toBe('"true"')
    const upload = w.stepsUsing('smoke', 'actions/upload-artifact')
    expect(upload).toHaveLength(1)
    const step = upload[0] as Range
    expect(w.field(step, 'if')).toBe('${{ !cancelled() }}')
    expect(w.withValue(step, 'name')).toBe('smoke-linux')
    expect(w.withValue(step, 'path')).toBe('test-results/smoke-linux/')
    expect(w.withValue(step, 'retention-days')).toBe('14')
  })
})

// CODEOWNERS and the pull request template (task 4.5).

describe('code owners and pull request template', () => {
  const read = (path: string): string => githubFiles().find((f) => f.path === path)?.text ?? ''

  it('assigns the maintainer to everything, and explicitly to the workflows and the release version logic', () => {
    const rules = read('.github/CODEOWNERS')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'))
      .map((l) => l.split(/\s+/))
    expect(rules).toEqual([
      ['*', '@alexnakagama'],
      ['/.github/', '@alexnakagama'],
      ['/scripts/release-version.mjs', '@alexnakagama'],
      // The release version logic runs npm through this module.
      ['/scripts/npm.mjs', '@alexnakagama'],
    ])
    for (const script of ['scripts/release-version.mjs', 'scripts/npm.mjs']) expect(existsSync(join(root, script)), script).toBe(true)
  })

  it('asks for verify, tagged scenarios and updated docs', () => {
    const items = read('.github/pull_request_template.md')
      .split('\n')
      .filter((l) => l.startsWith('- [ ] '))
    expect(items).toHaveLength(3)
    expect(items[0]).toContain('`npm run verify`')
    expect(items[1]).toContain('[spec:')
    expect(items[2]).toMatch(/[Dd]ocumentation/)
  })
})

// release.yml (design D6, D7): a manual release on master, gated on the bumped tree, published last.

/** The release version logic and the module it runs npm through, copied into the throwaway repositories. */
const releaseScripts = ['scripts/release-version.mjs', 'scripts/npm.mjs']

// These tests build git repositories and run the step scripts with bash, git and npm; starting
// those processes takes several times longer on the Windows runner. A hang still fails, after a minute.
describe('release.yml (design D6)', { timeout: 60_000 }, () => {
  const w = loadWorkflow('.github/workflows/release.yml')
  const gates = ['verify', 'e2e', 'package']
  const packageTests = ['smoke', 'acceptance']
  const sourceSha = '${{ needs.validate.outputs.source_sha }}'
  const versionEnv = '${{ inputs.version }}'
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const tempDir = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), `veydr-release-${prefix}-`))
    dirs.push(dir)
    return dir
  }
  /** The `env:` of the step with this `name:`, as `key: value` pairs. */
  const stepEnv = (job: string, step: string): Record<string, string> => {
    const found = w.steps(job).find((s) => w.field(s, 'name') === step)
    expect(found, `step "${step}" in job ${job}`).toBeDefined()
    const env = found === undefined ? undefined : stepField(w.lines, found)('env')
    if (env === undefined) return {}
    return Object.fromEntries(childrenOf(w.lines, w.lines.indexOf(env)).map((i) => [(w.lines[i] as Line).key ?? '', (w.lines[i] as Line).value ?? '']))
  }
  /** Names (or `uses:` actions) of a job's steps, in order. */
  const stepNames = (job: string): string[] => w.steps(job).map((s) => w.field(s, 'name') ?? (w.field(s, 'uses') ?? '').split('@')[0] ?? '')
  const needs = (job: string): string[] => childNames(w.lines, childAt(w.lines, w.job(job).start, 'needs'))

  /** Git, as the runner configures it: nothing signs, and no global identity. */
  const gitEnv = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  /**
   * Git for preparing the test repositories, with the same configuration as the steps. Without it,
   * the machine's settings would apply, e.g. Git for Windows' system-wide `core.autocrlf=true`,
   * which checks the clone out with CRLF while the steps compare against LF.
   */
  const git = (cwd: string, ...args: string[]): string => {
    const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...gitEnv },
    })
    expect(result.status, `git ${args.join(' ')}: ${result.stderr}`).toBe(0)
    return result.stdout.trim()
  }

  /**
   * A bare `origin` whose master holds the project's package.json, package-lock.json and
   * release-version.mjs, and a clone of it checked out at that commit with every tag, the way
   * publish's checkout leaves it.
   */
  function remote(): { origin: string; source: string; clone: () => string } {
    const seed = tempDir('seed')
    mkdirSync(join(seed, 'scripts'))
    for (const file of ['package.json', 'package-lock.json', ...releaseScripts]) copyFileSync(join(root, file), join(seed, file))
    git(seed, 'init', '--quiet', '--initial-branch', 'master')
    git(seed, 'add', '.')
    git(seed, 'commit', '--quiet', '--message', 'source')
    const origin = join(tempDir('origin'), 'origin.git')
    git(seed, 'clone', '--quiet', '--bare', seed, origin)
    const source = git(seed, 'rev-parse', 'HEAD')
    const clone = (): string => {
      const dir = join(tempDir('clone'), 'repo')
      git(tmpdir(), 'clone', '--quiet', origin, dir)
      git(dir, 'checkout', '--quiet', '--detach', source)
      return dir
    }
    return { origin, source, clone }
  }

  /** Runs publish's commit, remote check and (when the check says so) push steps in `dir`. */
  function publishSteps(dir: string, source: string, version = '0.1.0'): { commit: ScriptRun; check: ScriptRun; push?: ScriptRun; output: string } {
    const env = { ...gitEnv, VERSION: version, TAG: `v${version}`, SOURCE_SHA: source }
    const commit = w.runStep('publish', 'Commit the version', { cwd: dir, env })
    if (commit.status !== 0) return { commit, check: commit, output: '' }
    const outputFile = join(tempDir('output'), 'github-output')
    writeFileSync(outputFile, '')
    const check = w.runStep('publish', 'Check the remote', { cwd: dir, env: { ...env, GITHUB_OUTPUT: outputFile } })
    const output = readFileSync(outputFile, 'utf8')
    if (check.status !== 0 || output !== 'push=true\n') return { commit, check, output }
    return { commit, check, output, push: w.runStep('publish', 'Tag and push', { cwd: dir, env }) }
  }

  const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
  /** Runs publish's SHA256SUMS step on `files` (name → contents) with an acceptance record whose first step names `tested`. */
  const checksums = (files: Record<string, string>, tested: string | undefined, version = '1.2.3') => {
    const dir = tempDir('sums')
    for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents)
    const acceptance = join(tempDir('acceptance'), 'steps.jsonl')
    if (tested !== undefined) {
      writeFileSync(acceptance, `${JSON.stringify({ step: 'environment', ok: true, detail: { deb: tested } })}\n${JSON.stringify({ step: 'launch', ok: true })}\n`)
    }
    const run = w.runStep('publish', 'Write SHA256SUMS', { cwd: dir, env: { VERSION: version, ACCEPTANCE: acceptance } })
    const read = (name: string): string | undefined => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : undefined)
    return { run, dir, sums: read('SHA256SUMS'), record: read('acceptance-linux-steps.jsonl') }
  }

  /** Runs the draft release step with a fake `gh`; `releases` is what the releases API lists. */
  const draftRelease = (options: { releases?: { tag_name: string; draft: boolean }[]; prerelease?: string; failOn?: string } = {}) => {
    const dir = tempDir('gh')
    const log = join(dir, 'gh.log')
    writeFileSync(
      join(dir, 'gh'),
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n')
if (process.env.FAKE_GH_FAIL && args.slice(0, 2).join(' ') === process.env.FAKE_GH_FAIL) process.exit(1)
if (args[0] === 'api') {
  // The step's --jq filter, applied the way gh applies it to each page.
  const releases = JSON.parse(process.env.FAKE_RELEASES)
  for (const r of releases) if (r.tag_name === process.env.TAG) console.log(String(r.draft))
}
`,
    )
    chmodSync(join(dir, 'gh'), 0o755)
    const run = w.runStep('publish', 'Create the draft release', {
      cwd: dir,
      env: {
        PATH: `${dir}:${process.env['PATH'] ?? ''}`,
        GH_LOG: log,
        GH_TOKEN: 'token',
        GH_REPO: 'owner/veydr',
        VERSION: '1.2.3-rc.1',
        TAG: 'v1.2.3-rc.1',
        PRERELEASE: options.prerelease ?? 'true',
        FAKE_RELEASES: JSON.stringify(options.releases ?? []),
        FAKE_GH_FAIL: options.failOn,
      },
    })
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []
    return { run, calls }
  }
  const releaseFiles = ['Veydr-1.2.3-rc.1-amd64.deb', 'Veydr-1.2.3-rc.1-x86_64.AppImage', 'SHA256SUMS', 'acceptance-linux-steps.jsonl']

  it('exists and has the expected jobs', () => {
    expect(w.source.text).not.toBe('')
    expect(w.jobs.map((j) => j.name)).toEqual(['validate', ...gates, ...packageTests, 'publish'])
    // One release at a time, and a running release is never cancelled.
    const concurrency = topLevelBlock(w.lines, 'concurrency')?.start ?? -1
    expect(w.lines[childAt(w.lines, concurrency, 'group')]?.value).toBe('release')
    expect(w.lines[childAt(w.lines, concurrency, 'cancel-in-progress')]?.value).toBe('false')
    // No step may fail without failing its job.
    expect(w.lines.filter((l) => l.kind === 'node' && l.key === 'continue-on-error')).toEqual([])
  })

  it('[spec:release-automation/release-started-from-master] starts only by hand, with a required version, and prepares vX.Y.Z from master', () => {
    expect(w.triggers()).toEqual(['workflow_dispatch'])
    expect(Object.keys(w.dispatchInputs())).toEqual(['version'])
    expect(w.dispatchInputs()['version']).toMatchObject({ required: 'true', type: 'string' })
    expect(w.dispatchInputs()['version']).not.toHaveProperty('default')
    expect(w.runStep('validate', 'Require master', { env: { REF: 'refs/heads/master' } }).status).toBe(0)

    // validate checks the version against every tag, so the checkout fetches all of them.
    const checkout = w.stepsUsing('validate', 'actions/checkout')
    expect(checkout).toHaveLength(1)
    expect(w.withValue(checkout[0] as Range, 'fetch-depth')).toBe('0')
    expect(w.withValue(checkout[0] as Range, 'ref')).toBeUndefined()
    expect(stepEnv('validate', 'Check the version')).toEqual({ VERSION: versionEnv })
    expect(w.scripts('validate')).toContain('node scripts/release-version.mjs check "$VERSION"')
    const outputs = childAt(w.lines, w.job('validate').start, 'outputs')
    expect(Object.fromEntries(childrenOf(w.lines, outputs).map((i) => [(w.lines[i] as Line).key, (w.lines[i] as Line).value]))).toEqual({
      tag: '${{ steps.check.outputs.tag }}',
      prerelease: '${{ steps.check.outputs.prerelease }}',
      source_sha: '${{ steps.source.outputs.sha }}',
    })
    const source = w.steps('validate').find((s) => w.field(s, 'id') === 'source')
    expect(source === undefined ? undefined : w.field(source, 'run')).toBe('echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"')

    // The check step, run in a repository at 0.0.0, outputs the tag for 0.1.0.
    const dir = tempDir('validate')
    mkdirSync(join(dir, 'scripts'))
    for (const file of releaseScripts) copyFileSync(join(root, file), join(dir, file))
    writeFileSync(join(dir, 'package.json'), '{ "name": "veydr", "version": "0.0.0" }\n')
    git(dir, 'init', '--quiet')
    const output = join(dir, 'github-output')
    writeFileSync(output, '')
    const run = w.runStep('validate', 'Check the version', { cwd: dir, env: { VERSION: '0.1.0', GITHUB_OUTPUT: output } })
    expect(run.status, run.stderr).toBe(0)
    expect(readFileSync(output, 'utf8')).toBe('tag=v0.1.0\nprerelease=false\n')
  })

  it('[spec:release-automation/release-started-from-another-branch] fails on any other ref before building anything', () => {
    // The guard is the first step of the first job, and every other job needs that job.
    expect(stepNames('validate')[0]).toBe('Require master')
    expect(stepEnv('validate', 'Require master')).toEqual({ REF: '${{ github.ref }}' })
    for (const ref of ['refs/heads/feature/x', 'refs/tags/v1.0.0', 'refs/heads/master-old', 'refs/pull/1/merge', '']) {
      const run = w.runStep('validate', 'Require master', { env: { REF: ref } })
      expect(run.status, ref).toBe(1)
      expect(run.stdout, ref).toContain('::error title=Release refused::a release runs only on master')
    }
    for (const job of w.jobs.map((j) => j.name).filter((name) => name !== 'validate')) expect(needs(job), job).toContain('validate')
  })

  it('[spec:release-automation/packages-carry-the-release-version] applies the bump in every gate job, and builds packages named for the version', () => {
    for (const job of gates) {
      const checkout = w.stepsUsing(job, 'actions/checkout')
      expect(checkout, job).toHaveLength(1)
      expect(w.withValue(checkout[0] as Range, 'ref'), job).toBe(sourceSha)
      const setup = w.steps(job).find((s) => w.field(s, 'uses') === './.github/actions/setup')
      expect(setup === undefined ? undefined : w.withValue(setup, 'cache'), job).toBe('"false"')
      // Checkout, setup, bump, then the checks of the job on the bumped tree.
      expect(stepNames(job).slice(0, 3), job).toEqual(['actions/checkout', './.github/actions/setup', 'Apply the version'])
      expect(stepEnv(job, 'Apply the version'), job).toEqual({ VERSION: versionEnv })
      expect(w.scripts(job)[0], job).toBe('node scripts/release-version.mjs apply "$VERSION"')
    }
    expect(w.scripts('verify')).toEqual(['node scripts/release-version.mjs apply "$VERSION"', 'xvfb-run --auto-servernum npm run verify'])
    expect(w.scripts('e2e')).toContain('xvfb-run --auto-servernum npm run test:e2e')
    expect(w.scripts('package')).toContain('xvfb-run --auto-servernum npm run test:packaging')

    // The packages job uploads exactly the two packages named for the requested version.
    const names = (files: string[], version = '1.2.3'): ScriptRun => {
      const dir = tempDir('names')
      for (const file of files) writeFileSync(join(dir, file), file)
      return w.runStep('package', 'Check the package names', { cwd: dir, env: { VERSION: version } })
    }
    expect(names(['Veydr-1.2.3-amd64.deb', 'Veydr-1.2.3-x86_64.AppImage', 'builder-debug.yml']).status).toBe(0)
    expect(names(['Veydr-1.2.3-rc.1-amd64.deb', 'Veydr-1.2.3-rc.1-x86_64.AppImage'], '1.2.3-rc.1').status).toBe(0)
    for (const files of [[], ['Veydr-0.0.0-amd64.deb', 'Veydr-0.0.0-x86_64.AppImage'], ['Veydr-1.2.3-amd64.deb'], ['Veydr-1.2.3-amd64.deb', 'Veydr-1.2.3-x86_64.AppImage', 'Veydr-1.2.2-amd64.deb']]) {
      const run = names(files)
      expect(run.status, files.join(' ')).toBe(1)
      expect(run.stdout, files.join(' ')).toContain('::error title=Unexpected packages::')
    }
    const upload = w.stepsUsing('package', 'actions/upload-artifact')
    expect(upload).toHaveLength(1)
    expect(w.withValue(upload[0] as Range, 'name')).toBe('release-packages')
    expect(w.withValue(upload[0] as Range, 'path')).toBe('dist/*.deb\ndist/*.AppImage')
    expect(w.withValue(upload[0] as Range, 'if-no-files-found')).toBe('error')
    expect(stepNames('package').indexOf('Check the package names')).toBeLessThan(stepNames('package').indexOf('Upload packages'))
  })

  it('[spec:release-automation/gate-fails] pushes, tags and releases nothing unless every gate job succeeded', () => {
    // publish needs every other job and has no if:, so it is skipped when any of them fails or is skipped.
    expect(needs('publish').sort()).toEqual(w.jobs.map((j) => j.name).filter((name) => name !== 'publish').sort())
    expect(w.jobField('publish', 'if')).toBeUndefined()
    for (const job of w.jobs.map((j) => j.name)) expect(w.jobField(job, 'if'), job).toBeUndefined()
    // Only publish can write, and only publish contains anything that reaches the remote.
    for (const job of w.jobs.map((j) => j.name).filter((name) => name !== 'publish')) {
      expect(w.permissions(job), job).toEqual({ contents: 'read' })
      const text = within(w.lines, w.job(job)).filter((l) => l.kind !== 'comment').map((l) => l.body).join('\n')
      expect(text, job).not.toMatch(/git (?:push|tag|commit)|gh (?:release|api)|secrets\./)
      // The gate jobs keep no credentials, so even a compromised test could not push.
      for (const checkout of w.stepsUsing(job, 'actions/checkout')) expect(w.withValue(checkout, 'persist-credentials'), job).toBe('false')
    }
    // The same version can be requested again: validate refuses only existing tags, and a failed run
    // created none (checked against the CLI in release-version.test.ts).
    expect(w.scripts('validate').filter((s) => s.includes('release-version.mjs'))).toEqual(['node scripts/release-version.mjs check "$VERSION"'])
    // smoke and acceptance test the uploaded packages, not a rebuild.
    for (const job of packageTests) {
      expect(needs(job), job).toEqual(['validate', 'package'])
      const download = w.stepsUsing(job, 'actions/download-artifact')
      expect(download, job).toHaveLength(1)
      expect(w.withValue(download[0] as Range, 'name'), job).toBe('release-packages')
      expect(w.withValue(download[0] as Range, 'path'), job).toBe('dist')
      expect(w.scripts(job).join('\n'), job).not.toMatch(/npm run (?:dist|build|test:packaging)|release-version/)
    }
    expect(w.scripts('smoke')).toEqual(['scripts/smoke-linux.sh'])
    expect(w.scripts('acceptance')).toEqual(['scripts/acceptance-linux.sh'])
  })

  it('[spec:release-automation/gate-passes] pushes one commit changing only the version files, and its tag, atomically', () => {
    expect(w.permissions('publish')).toEqual({ contents: 'write', 'id-token': 'write', attestations: 'write' })
    const checkout = w.stepsUsing('publish', 'actions/checkout')
    expect(checkout).toHaveLength(1)
    expect(w.withValue(checkout[0] as Range, 'ref')).toBe(sourceSha)
    expect(w.withValue(checkout[0] as Range, 'fetch-depth')).toBe('0')
    // Design D7: the deploy key when the secret exists, the job token otherwise.
    expect(w.withValue(checkout[0] as Range, 'ssh-key')).toBe('${{ secrets.RELEASE_DEPLOY_KEY }}')
    // No npm ci next to the stored write token.
    const setup = w.steps('publish').find((s) => w.field(s, 'uses') === './.github/actions/setup')
    expect(setup === undefined ? undefined : w.withValue(setup, 'dependencies')).toBe('"false"')
    expect(w.scripts('publish').join('\n')).toContain('git push --atomic origin HEAD:refs/heads/master "refs/tags/$TAG"')
    expect(w.field(w.steps('publish').find((s) => w.field(s, 'name') === 'Tag and push') as Range, 'if')).toBe("steps.remote.outputs.push == 'true'")

    const { origin, source, clone } = remote()
    const first = publishSteps(clone(), source)
    expect(first.commit.status, first.commit.stdout + first.commit.stderr).toBe(0)
    expect(first.check.status, first.check.stdout + first.check.stderr).toBe(0)
    expect(first.output).toBe('push=true\n')
    expect(first.push?.status, first.push?.stderr).toBe(0)
    // master advanced by exactly one commit, by github-actions[bot], changing only the two files to the new version.
    const master = git(origin, 'rev-parse', 'refs/heads/master')
    expect(git(origin, 'rev-parse', `${master}^`)).toBe(source)
    expect(git(origin, 'diff', '--name-only', source, master).split('\n')).toEqual(['package-lock.json', 'package.json'])
    expect(git(origin, 'log', '-1', '--format=%an <%ae>%n%s', master)).toBe('github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>\nrelease v0.1.0')
    expect((JSON.parse(git(origin, 'show', `${master}:package.json`)) as { version?: string }).version).toBe('0.1.0')
    // An annotated tag pointing at that commit.
    expect(git(origin, 'cat-file', '-t', 'refs/tags/v0.1.0')).toBe('tag')
    expect(git(origin, 'rev-parse', 'refs/tags/v0.1.0^{commit}')).toBe(master)

    // A rerun of publish after the push recognises its own commit and pushes nothing.
    const rerun = publishSteps(clone(), source)
    expect(rerun.check.status, rerun.check.stdout + rerun.check.stderr).toBe(0)
    expect(rerun.output).toBe('push=false\n')
    expect(rerun.check.stdout).toContain('::notice title=Already pushed::')
    expect(rerun.push).toBeUndefined()
    expect(git(origin, 'rev-parse', 'refs/heads/master')).toBe(master)
  })

  it('refuses to push when master moved or the tag belongs to another commit', () => {
    // master moved after the release started: refused before anything is pushed.
    const moved = remote()
    const dir = moved.clone()
    const other = moved.clone()
    git(other, 'checkout', '--quiet', 'master')
    writeFileSync(join(other, 'README.md'), 'moved\n')
    git(other, 'add', 'README.md')
    git(other, 'commit', '--quiet', '--message', 'moved')
    git(other, 'push', '--quiet', 'origin', 'master')
    const refused = publishSteps(dir, moved.source)
    expect(refused.check.status).toBe(1)
    expect(refused.check.stdout).toContain('::error title=master moved::')
    expect(git(moved.origin, 'tag', '--list')).toBe('')

    // A tag that is not this release's commit on the source commit: refused, nothing changes.
    const foreign = remote()
    const tagger = foreign.clone()
    git(tagger, 'tag', 'v0.1.0')
    git(tagger, 'push', '--quiet', 'origin', 'v0.1.0')
    const run = publishSteps(foreign.clone(), foreign.source)
    expect(run.check.status).toBe(1)
    expect(run.check.stdout).toContain('::error title=Tag exists::v0.1.0 already exists')
    expect(git(foreign.origin, 'rev-parse', 'refs/heads/master')).toBe(foreign.source)

    // The same tag on a different bump of the source commit (another version's content): refused.
    const different = remote()
    const first = publishSteps(different.clone(), different.source, '0.1.0')
    expect(first.push?.status).toBe(0)
    const retagged = different.clone()
    const second = publishSteps(retagged, different.source, '0.1.0')
    expect(second.output).toBe('push=false\n')
    writeFileSync(join(retagged, 'package.json'), readFileSync(join(retagged, 'package.json'), 'utf8').replace('"0.1.0"', '"0.1.1"'))
    git(retagged, 'commit', '--quiet', '--all', '--amend', '--no-edit')
    const outputFile = join(tempDir('output'), 'github-output')
    const mismatch = w.runStep('publish', 'Check the remote', {
      cwd: retagged,
      env: { ...gitEnv, TAG: 'v0.1.0', SOURCE_SHA: different.source, GITHUB_OUTPUT: outputFile },
    })
    expect(mismatch.status).toBe(1)
    expect(mismatch.stdout).toContain('::error title=Tag exists::')
  })

  it.skipIf(process.platform !== 'linux')('[linux-only: GNU sha256sum text-mode output] [spec:release-automation/checksums-match] writes SHA256SUMS for exactly the tested packages, which sha256sum -c accepts', () => {
    const deb = 'Veydr-1.2.3-amd64.deb'
    const appimage = 'Veydr-1.2.3-x86_64.AppImage'
    const files = { [deb]: 'deb contents\n', [appimage]: 'appimage contents\n' }
    const good = checksums(files, `${digest('deb contents\n')}  ${deb}`)
    expect(good.run.status, good.run.stdout + good.run.stderr).toBe(0)
    expect(good.sums).toBe(`${digest('deb contents\n')}  ${deb}\n${digest('appimage contents\n')}  ${appimage}\n`)
    // A user's check: sha256sum -c succeeds on the downloaded files.
    const check = spawnSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: good.dir, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
    expect(check.status, check.stderr).toBe(0)
    expect(check.stdout).toBe(`${deb}: OK\n${appimage}: OK\n`)
    writeFileSync(join(good.dir, deb), 'tampered\n')
    expect(spawnSync('sha256sum', ['-c', '--quiet', 'SHA256SUMS'], { cwd: good.dir }).status).toBe(1)
    // The acceptance record that is attached is the one of the run that tested this .deb.
    expect(good.record?.split('\n')[0]).toContain(digest('deb contents\n'))

    // Anything but exactly the two packages of this version fails.
    for (const other of [{ [deb]: 'x' }, { ...files, 'extra.deb': 'x' }, { 'Veydr-1.2.2-amd64.deb': 'x', [appimage]: 'x' }]) {
      const bad = checksums(other, `${digest('x')}  ${deb}`)
      expect(bad.run.status, Object.keys(other).join(' ')).toBe(1)
      expect(bad.run.stdout).toContain('::error title=Unexpected packages::')
    }
    // A missing record, or one that tested another .deb, fails instead of attaching the wrong evidence.
    const missing = checksums(files, undefined)
    expect(missing.run.status).toBe(1)
    expect(missing.run.stdout).toContain('::error title=No acceptance record::')
    for (const tested of [`${digest('other\n')}  ${deb}`, `${digest('deb contents\n')}  Veydr-1.2.2-amd64.deb`, '']) {
      const mismatch = checksums(files, tested)
      expect(mismatch.run.status, tested).toBe(1)
      expect(mismatch.run.stdout, tested).toContain('::error title=Acceptance record mismatch::')
      expect(mismatch.record, tested).toBeUndefined()
    }
  })

  it('[spec:release-automation/verifying-a-release-package] attests every attached package before anything is pushed', () => {
    const attest = w.stepsUsing('publish', 'actions/attest-build-provenance')
    expect(attest).toHaveLength(1)
    // The subjects are exactly the packages in SHA256SUMS; the attestation names this workflow run
    // and the commit it checked out, the source commit, which is the parent of the tagged commit.
    expect(w.withValue(attest[0] as Range, 'subject-checksums')).toBe('${{ runner.temp }}/release/SHA256SUMS')
    const order = stepNames('publish')
    expect(order).toEqual([
      'actions/checkout',
      './.github/actions/setup',
      'Commit the version',
      'Check the remote',
      'Download packages',
      'Download the acceptance record',
      'Write SHA256SUMS',
      'Attest build provenance',
      'Tag and push',
      'Create the draft release',
    ])
    expect(w.field(w.steps('publish').find((s) => w.field(s, 'name') === 'Write SHA256SUMS') as Range, 'working-directory')).toBe('${{ runner.temp }}/release')
  })

  it('[spec:release-automation/draft-created] creates a draft with generated notes, the packages, SHA256SUMS and the acceptance record', () => {
    // The packages publish attaches are the ones package uploaded, and the record is acceptance's.
    const downloads = w.stepsUsing('publish', 'actions/download-artifact').map((s) => [w.withValue(s, 'name'), w.withValue(s, 'path')])
    expect(downloads).toEqual([
      ['release-packages', '${{ runner.temp }}/release'],
      ['release-acceptance-linux', '${{ runner.temp }}/acceptance'],
    ])
    const upload = w.stepsUsing('acceptance', 'actions/upload-artifact')
    expect(upload).toHaveLength(1)
    expect(w.withValue(upload[0] as Range, 'name')).toBe('release-acceptance-linux')
    expect(w.withValue(upload[0] as Range, 'path')).toBe('test-results/acceptance-linux/')
    expect(stepEnv('publish', 'Write SHA256SUMS')['ACCEPTANCE']).toBe('${{ runner.temp }}/acceptance/steps.jsonl')

    const created = draftRelease()
    expect(created.run.status, created.run.stdout + created.run.stderr).toBe(0)
    expect(created.calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['api --paginate', 'release create'])
    const create = created.calls[1] ?? []
    expect(create[2]).toBe('v1.2.3-rc.1')
    for (const flag of ['--draft', '--verify-tag', '--generate-notes', '--prerelease']) expect(create, flag).toContain(flag)
    expect(create.slice(create.indexOf('--') + 1)).toEqual(releaseFiles)
    // Never published automatically.
    expect(w.source.text).not.toMatch(/--draft[= ]false|gh release edit|--latest/)

    const final = draftRelease({ prerelease: 'false' })
    expect(final.calls[1]).not.toContain('--prerelease')
    expect(final.calls[1]).toContain('--draft')

    // A rerun completes the existing draft instead of creating a second one.
    const existing = draftRelease({ releases: [{ tag_name: 'v1.2.3-rc.1', draft: true }, { tag_name: 'v1.2.2', draft: false }] })
    expect(existing.run.status, existing.run.stderr).toBe(0)
    expect(existing.calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['api --paginate', 'release upload'])
    expect(existing.calls[1]).toContain('--clobber')
    expect((existing.calls[1] ?? []).slice((existing.calls[1] ?? []).indexOf('--') + 1)).toEqual(releaseFiles)
    // A published release, two releases for the tag, or a failing API call: nothing is changed.
    for (const releases of [[{ tag_name: 'v1.2.3-rc.1', draft: false }], [{ tag_name: 'v1.2.3-rc.1', draft: true }, { tag_name: 'v1.2.3-rc.1', draft: true }]]) {
      const refused = draftRelease({ releases })
      expect(refused.run.status).toBe(1)
      expect(refused.calls.map((c) => c[0])).toEqual(['api'])
    }
    const unreachable = draftRelease({ failOn: 'api --paginate' })
    expect(unreachable.run.status).not.toBe(0)
    expect(unreachable.calls.map((c) => c[0])).toEqual(['api'])
    expect(draftRelease({ failOn: 'release create' }).run.status).not.toBe(0)
  })
})
