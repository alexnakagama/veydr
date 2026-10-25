import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

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
    expect(files.map((f) => f.path)).toContain('.github/actions/setup/action.yml')
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
