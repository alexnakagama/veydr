import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { selectProcessBackend } from '../support/processes'

// Design D7: a test that cannot run on an operating system is skipped there with a reason in its
// title (`[linux-only: <facility>]`), never made to pass by doing nothing.
//
// The rule enforced here: test code reads the platform only in a declared guard, i.e. the
// condition of `describe/it/test.skipIf`, `.runIf`, or a conditional `.skip(condition, reason)`
// (Vitest's `context.skip`, Playwright's `test.skip`), or in a `const` used by such a guard. Any
// other branch on the platform (`if`, `?:`, `&&`, `||`, `??`, `switch`) is rejected, since it could
// make a test pass without running. Code that must differ by platform belongs in `src/main/platform`;
// tests follow the host's conventions through `hostConventions` (support/config.ts), which reads no
// platform here. Not covered: platform reads hidden behind a function call or an import.

const repoRoot = resolve(__dirname, '../..')
const testRoot = join(repoRoot, 'test')

type GuardedOs = 'linux' | 'windows'
type GuardKind = 'skipIf' | 'runIf' | 'skip'

/** `process.platform` of each operating system a guard may name. */
const NODE_PLATFORM: Readonly<Record<GuardedOs, NodeJS.Platform>> = { linux: 'linux', windows: 'win32' }

/** The platforms a guard's condition is evaluated on: both guarded systems and one other. */
const EVALUATED_PLATFORMS = ['linux', 'win32', 'darwin'] as const satisfies readonly NodeJS.Platform[]
type EvaluatedPlatform = (typeof EVALUATED_PLATFORMS)[number]

/** A reason naming the missing facility, e.g. `[linux-only: /proc]`. */
const REASON = /\[(linux|windows)-only: [^\]\s][^\]]*\]/

interface PlatformGuard {
  readonly file: string
  readonly line: number
  readonly kind: GuardKind
  /** The guard's condition, whitespace collapsed, e.g. `process.platform !== 'linux'`. */
  readonly condition: string
  /** The operating system its reason names, or `null` without a reason. */
  readonly os: GuardedOs | null
  /** The reason as written, e.g. `[linux-only: /proc]`, or `null` without one. */
  readonly reason: string | null
  /** Whether the guard is a statement of the file itself, so it guards every test in the file. */
  readonly fileLevel: boolean
  /** Whether the guarded test runs on each platform, or `null` if the condition cannot be evaluated. */
  readonly runs: Readonly<Record<EvaluatedPlatform, boolean>> | null
}

interface Violation {
  readonly file: string
  readonly line: number
  readonly message: string
}

const MISSING_REASON = 'on the platform without a [linux-only: …] or [windows-only: …] reason in its title'
const NON_LITERAL_TITLE = 'on the platform must guard a test or suite with a literal title'
const PLATFORM_BRANCH = 'branches on the platform outside a declared skip, so a test could pass without running'

/** `process` or `<anything>.process` (e.g. `globalThis.process`). */
const isProcess = (node: ts.Expression): boolean =>
  (ts.isIdentifier(node) && node.text === 'process') || (ts.isPropertyAccessExpression(node) && node.name.text === 'process')

/**
 * Whether `node` depends on the operating system Node runs on: it reads `process.platform` (also as
 * `process['platform']`), calls `platform()` (`os.platform()`), or names a `const` in `aliases`
 * that does. Other `platform` properties, such as `AppInfo.platform` in renderer tests, are data and
 * do not count.
 */
function readsPlatform(node: ts.Node, aliases: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(node) && aliases.has(node.text)) return true
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'platform' && isProcess(node.expression)) return true
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'platform' && isProcess(node.expression)) {
    return true
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression
    if ((ts.isIdentifier(callee) && callee.text === 'platform') || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'platform')) return true
  }
  return ts.forEachChild(node, (child) => readsPlatform(child, aliases)) ?? false
}

const PREDICATE_OPERATORS: readonly ts.SyntaxKind[] = [
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
]

/**
 * Whether `node` is a plain predicate on the platform, built only from platform reads, string
 * literals, `aliases`, comparisons, `!`, `&&`, and `||`. Only such a value may be kept in a variable
 * for a guard; anything else (a ternary, a stored `it.skipIf(...)`) is checked like other code.
 */
function isPlatformPredicate(node: ts.Expression, aliases: ReadonlySet<string>): boolean {
  if (ts.isParenthesizedExpression(node)) return isPlatformPredicate(node.expression, aliases)
  if (ts.isPrefixUnaryExpression(node)) return node.operator === ts.SyntaxKind.ExclamationToken && isPlatformPredicate(node.operand, aliases)
  if (ts.isBinaryExpression(node)) {
    return PREDICATE_OPERATORS.includes(node.operatorToken.kind) && isPlatformPredicate(node.left, aliases) && isPlatformPredicate(node.right, aliases)
  }
  if (ts.isStringLiteralLike(node)) return true
  if (ts.isCallExpression(node)) return node.arguments.length === 0 && readsPlatform(node, aliases)
  return (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && readsPlatform(node, aliases)
}

/** The static text of a test title, or `null` if it is not a string or template literal. */
function titleText(node: ts.Expression | undefined): string | null {
  if (node === undefined) return null
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('…')
  return null
}

/**
 * Evaluates `condition` (TypeScript, after the `declarations` it may use) with the platform set to
 * each of `EVALUATED_PLATFORMS`, in an empty context. `null` if it reads anything else.
 */
function evaluate(condition: string, declarations: readonly string[]): Record<EvaluatedPlatform, boolean> | null {
  const { outputText } = ts.transpileModule([...declarations, `result = (${condition})`].join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  })
  try {
    const values = EVALUATED_PLATFORMS.map((platform): [EvaluatedPlatform, boolean] => {
      const context = { process: { platform }, os: { platform: () => platform }, platform: () => platform, result: undefined as unknown }
      runInNewContext(outputText, context, { timeout: 100 })
      return [platform, Boolean(context.result)]
    })
    return Object.fromEntries(values) as Record<EvaluatedPlatform, boolean>
  } catch {
    return null
  }
}

function scriptKind(file: string): ts.ScriptKind {
  const ext = extname(file)
  if (ext === '.tsx') return ts.ScriptKind.TSX
  if (ext === '.jsx') return ts.ScriptKind.JSX
  return /^\.[cm]?js$/.test(ext) ? ts.ScriptKind.JS : ts.ScriptKind.TS
}

/** The platform guards in one test file, and the ways it breaks the declared-skip policy. */
function scan(file: string, source: string): { guards: PlatformGuard[]; violations: Violation[] } {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file))
  const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1

  // Variables holding a platform predicate (`const isLinux = process.platform === 'linux'`),
  // collected until no new one appears, so aliases of aliases count too.
  const aliases = new Set<string>()
  const declarations = new Map<string, ts.VariableDeclaration>()
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && !declarations.has(node.name.text)) {
      if (readsPlatform(node.initializer, aliases) && isPlatformPredicate(node.initializer, aliases)) declarations.set(node.name.text, node)
    }
    ts.forEachChild(node, collect)
  }
  for (let size = -1; size !== declarations.size; ) {
    size = declarations.size
    collect(sourceFile)
    for (const name of declarations.keys()) aliases.add(name)
  }
  const aliasDeclarations = [...declarations.entries()]
    .sort(([, a], [, b]) => a.getStart(sourceFile) - b.getStart(sourceFile))
    .map(([name, d]) => `const ${name} = (${d.initializer?.getText(sourceFile) ?? 'undefined'})`)

  const guards: PlatformGuard[] = []
  const violations: Violation[] = []
  // Platform reads that are allowed: guard conditions and alias initializers.
  const declared = new Set<ts.Node>([...declarations.values()].flatMap((d) => (d.initializer === undefined ? [] : [d.initializer])))

  const guard = (node: ts.CallExpression, kind: GuardKind, condition: ts.Expression, title: ts.Expression | undefined, hasTitleSlot: boolean): void => {
    declared.add(condition)
    const text = titleText(title)
    const reason = text === null ? null : REASON.exec(text)
    const conditionText = condition.getText(sourceFile).replace(/\s+/g, ' ')
    guards.push({
      file,
      line: lineOf(node),
      kind,
      condition: conditionText,
      os: reason === null ? null : (reason[1] as GuardedOs),
      reason: reason === null ? null : reason[0],
      fileLevel: ts.isExpressionStatement(node.parent) && ts.isSourceFile(node.parent.parent),
      runs: evaluate(conditionText, aliasDeclarations),
    })
    if (reason === null) {
      violations.push({ file, line: lineOf(node), message: `${kind} ${text === null && !hasTitleSlot ? NON_LITERAL_TITLE : MISSING_REASON}` })
    }
  }

  const visit = (node: ts.Node): void => {
    if (declared.has(node)) return
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const kind = node.expression.name.text
      const condition = node.arguments[0]
      if (condition !== undefined && readsPlatform(condition, aliases)) {
        if (kind === 'skipIf' || kind === 'runIf') {
          // `describe.skipIf(<condition>)(title, body)`: the title belongs to the call it returns.
          const guarded = ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : null
          guard(node, kind, condition, guarded?.arguments[0], false)
        } else if (kind === 'skip') {
          // `test.skip(<condition>, reason)` (Playwright) or `context.skip(<condition>, note)` (Vitest).
          guard(node, kind, condition, node.arguments[1], true)
        }
      }
    }
    const branch =
      (ts.isIfStatement(node) && node.expression) ||
      (ts.isConditionalExpression(node) && node.condition) ||
      (ts.isSwitchStatement(node) && node.expression) ||
      (ts.isBinaryExpression(node) &&
        [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind) &&
        node)
    if (branch && readsPlatform(branch, aliases)) violations.push({ file, line: lineOf(node), message: PLATFORM_BRANCH })
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { guards, violations }
}

/** Every script under `test/` (TypeScript and JavaScript), relative to the repository root with `/` separators. */
function testFiles(): string[] {
  return readdirSync(testRoot, { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.[cm]?[jt]sx?$/.test(path))
    .map((path) => relative(repoRoot, join(testRoot, path)).replaceAll('\\', '/'))
    .sort()
}

let repositoryScan: { files: string[]; guards: PlatformGuard[]; violations: Violation[] } | undefined

/** Every test file scanned once (parsing them all is the slow part), shared by the policy tests. */
function scanRepository(): { files: string[]; guards: PlatformGuard[]; violations: Violation[] } {
  if (repositoryScan === undefined) {
    const files = testFiles()
    const results = files.map((file) => scan(file, readFileSync(join(repoRoot, file), 'utf8')))
    repositoryScan = { files, guards: results.flatMap((r) => r.guards), violations: results.flatMap((r) => r.violations) }
  }
  return repositoryScan
}

/** Whether a guard runs its test on exactly the system its reason names (and no other). */
function runsOnlyOnNamedSystem(guard: PlatformGuard & { os: GuardedOs }): boolean {
  if (guard.runs === null) return false
  const runs = guard.runs
  const conditionTrue = (platform: EvaluatedPlatform): boolean => runs[platform]
  return EVALUATED_PLATFORMS.every((platform) => {
    const testRuns = guard.kind === 'runIf' ? conditionTrue(platform) : !conditionTrue(platform)
    return testRuns === (platform === NODE_PLATFORM[guard.os])
  })
}

const describeGuard = (g: PlatformGuard): string => `${g.file}:${g.line} ${g.kind}(${g.condition})`
const describeViolation = (v: Violation): string => `${v.file}:${v.line} ${v.message}`
const labelled = (guards: readonly PlatformGuard[]): (PlatformGuard & { os: GuardedOs })[] =>
  guards.filter((g): g is PlatformGuard & { os: GuardedOs } => g.os !== null)

/**
 * The one platform dispatch allowed in test code (add-windows-environment-and-commands design D7):
 * the process backend of test/support/processes.ts, which reads processes through /proc on Linux and
 * Win32_Process on Windows. It is pinned by file and by count, so a second dispatch anywhere,
 * including in that file, fails the policy.
 */
const PROCESS_DISPATCH = { file: 'test/support/processes.ts', count: 1 } as const

/** The policy's findings, apart from the allowed process dispatch. */
function unexpectedViolations(violations: readonly Violation[]): Violation[] {
  const dispatch = violations.filter((v) => v.file === PROCESS_DISPATCH.file && v.message === PLATFORM_BRANCH)
  return dispatch.length === PROCESS_DISPATCH.count ? violations.filter((v) => !dispatch.includes(v)) : [...violations]
}

describe('platform skip policy (design D7)', () => {
  it('[spec:quality-gates/linux-only-test-on-windows] every platform skip in the tests names the missing facility, and no test branches on the platform', () => {
    const { files, guards, violations } = scanRepository()
    expect(unexpectedViolations(violations).map(describeViolation)).toEqual([])
    // The allowed dispatch is the one in processes.ts, and nothing else there branches on the platform.
    expect(violations.filter((v) => v.file === PROCESS_DISPATCH.file).map(describeViolation)).toHaveLength(PROCESS_DISPATCH.count)
    // The scan is not passing vacuously: it sees every test tree and the guarded Linux-only suites.
    for (const tree of ['test/unit/', 'test/integration/', 'test/e2e/', 'test/packaging/']) {
      expect(files.some((f) => f.startsWith(tree)), tree).toBe(true)
    }
    expect(files.length).toBeGreaterThan(100)
    expect(guards.filter((g) => g.file === 'test/unit/linux-procfs.test.ts').length).toBeGreaterThan(0)
  })

  it('[spec:quality-gates/linux-only-test-on-linux] every linux-only test runs on Linux, and every guard runs its test exactly on the system its reason names', () => {
    const { guards } = scanRepository()
    expect(labelled(guards).some((g) => g.os === 'linux')).toBe(true)
    expect(labelled(guards).filter((g) => !runsOnlyOnNamedSystem(g)).map(describeGuard)).toEqual([])
  })

  it('allows the process dispatch only once, and only in test/support/processes.ts', () => {
    const at = (file: string, line: number): Violation => ({ file, line, message: PLATFORM_BRANCH })
    const dispatch = at(PROCESS_DISPATCH.file, 10)
    expect(unexpectedViolations([dispatch])).toEqual([])
    // A second dispatch in the same file, or one anywhere else, is a finding (with the first one).
    expect(unexpectedViolations([dispatch, at(PROCESS_DISPATCH.file, 20)])).toEqual([dispatch, at(PROCESS_DISPATCH.file, 20)])
    expect(unexpectedViolations([dispatch, at('test/e2e/support/fixtures.ts', 5)])).toEqual([at('test/e2e/support/fixtures.ts', 5)])
    // Another finding in that file is not excused by the dispatch.
    const missingReason = { file: PROCESS_DISPATCH.file, line: 30, message: `skipIf ${MISSING_REASON}` }
    expect(unexpectedViolations([dispatch, missingReason])).toEqual([missingReason])
  })

  it('the process dispatch throws on a system other than Linux and Windows, instead of reading nothing', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    if (platform === undefined) throw new Error('process.platform has no descriptor')
    try {
      for (const other of ['darwin', 'freebsd', 'aix']) {
        Object.defineProperty(process, 'platform', { ...platform, value: other })
        expect(() => selectProcessBackend(), other).toThrow(`cannot inspect processes on ${other}`)
      }
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
    // On this system (Linux or Windows) it selects a backend.
    expect(selectProcessBackend()).toBeDefined()
  })
})

/** A row of the table of end-to-end specs in docs/ci.md. */
interface SpecRow {
  readonly spec: string
  readonly kind: 'portable' | 'Linux-only' | 'Windows-specific'
  /** The skip reasons the row lists for the spec's tests, e.g. `[linux-only: POSIX signals]`. */
  readonly reasons: readonly string[]
}

/** The classification table under "End-to-end tests on Windows" in docs/ci.md (design D7). */
function specTable(markdown: string): SpecRow[] {
  const section = markdown.split(/^### End-to-end tests on Windows$/m)[1]?.split(/^#{2,3} /m)[0]
  if (section === undefined) throw new Error('docs/ci.md has no "### End-to-end tests on Windows" section')
  const rows: SpecRow[] = []
  for (const line of section.split('\n')) {
    const row = /^\| `([\w.-]+\.spec\.ts)` \| (portable|Linux-only|Windows-specific) \| (.*) \|$/.exec(line)
    if (row === null) continue
    const reasons = row[3] === 'none' ? [] : [...(row[3] ?? '').matchAll(/`(\[[^\]`]+\])`/g)].map((m) => m[1] ?? '')
    rows.push({ spec: row[1] ?? '', kind: row[2] as SpecRow['kind'], reasons })
  }
  return rows
}

describe('end-to-end tests by system (design D7)', () => {
  it('[spec:quality-gates/linux-only-end-to-end-test-on-windows] every e2e spec is classified in docs/ci.md, and every skip there names the facility the table names', () => {
    const { guards } = scanRepository()
    const specs = readdirSync(join(testRoot, 'e2e')).filter((name) => name.endsWith('.spec.ts')).sort()
    const table = specTable(readFileSync(join(repoRoot, 'docs', 'ci.md'), 'utf8'))
    // Every spec file has exactly one row, and every row a spec file: none is left unclassified.
    expect(table.map((row) => row.spec).sort()).toEqual(specs)
    expect(specs.length).toBeGreaterThan(15)
    for (const row of table) {
      const own = guards.filter((g) => g.file === `test/e2e/${row.spec}`)
      // The reasons the table lists are exactly those of the spec's guards.
      expect([...new Set(own.map((g) => g.reason))].sort(), row.spec).toEqual([...new Set(row.reasons)].sort())
      const fileLevel = own.filter((g) => g.fileLevel)
      if (row.kind === 'portable') {
        // Runs on both systems; single tests may be skipped on one, with their reason.
        expect(fileLevel.map(describeGuard), row.spec).toEqual([])
      } else {
        const os: GuardedOs = row.kind === 'Linux-only' ? 'linux' : 'windows'
        expect(fileLevel.map((g) => g.os), row.spec).toEqual([os])
        expect(own.every((g) => g.os === os), row.spec).toBe(true)
        // Windows-specific specs, and only those, are named windows-*.spec.ts.
        expect(row.spec.startsWith('windows-'), row.spec).toBe(row.kind === 'Windows-specific')
      }
    }
    // Not vacuous: Linux-only tests on Windows exist, each with its facility named.
    expect(table.filter((row) => row.reasons.some((reason) => reason.startsWith('[linux-only: '))).length).toBeGreaterThan(3)
  })

  it('reads the classification table', () => {
    const markdown = [
      '## CI',
      '### End-to-end tests on Windows',
      '| Spec | Kind | Skipped on one system |',
      '|---|---|---|',
      '| `a.spec.ts` | portable | none |',
      '| `b.spec.ts` | Linux-only | `[linux-only: network namespaces]` |',
      '| `windows-c.spec.ts` | Windows-specific | `[windows-only: Job Objects]`, `[windows-only: x]` |',
      '### Next',
      '| `d.spec.ts` | portable | none |',
    ].join('\n')
    expect(specTable(markdown)).toEqual([
      { spec: 'a.spec.ts', kind: 'portable', reasons: [] },
      { spec: 'b.spec.ts', kind: 'Linux-only', reasons: ['[linux-only: network namespaces]'] },
      { spec: 'windows-c.spec.ts', kind: 'Windows-specific', reasons: ['[windows-only: Job Objects]', '[windows-only: x]'] },
    ])
    expect(() => specTable('## CI')).toThrow('no "### End-to-end tests on Windows" section')
  })

  it('records whether a guard guards its whole file', () => {
    const { guards } = scan(
      'example.spec.ts',
      `test.skip(process.platform !== 'linux', '[linux-only: network namespaces]')
test('a', () => { test.skip(process.platform !== 'linux', '[linux-only: POSIX signals]') })`,
    )
    expect(guards.map((g) => [g.reason, g.fileLevel])).toEqual([
      ['[linux-only: network namespaces]', true],
      ['[linux-only: POSIX signals]', false],
    ])
  })
})

describe('platform skip scanner', () => {
  const violationsIn = (source: string): string[] => scan('example.test.ts', source).violations.map((v) => v.message)
  const mismatchedIn = (source: string): number[] => labelled(scan('example.test.ts', source).guards).filter((g) => !runsOnlyOnNamedSystem(g)).map((g) => g.line)

  it('accepts a labelled skip and records where it runs', () => {
    const { guards, violations } = scan(
      'example.test.ts',
      `describe.skipIf(process.platform !== 'linux')('[linux-only: /proc] reader', () => {})
it.runIf(process.platform === 'win32')(\`[windows-only: job objects] \${name}\`, () => {})`,
    )
    expect(violations).toEqual([])
    expect(guards).toEqual([
      { file: 'example.test.ts', line: 1, kind: 'skipIf', condition: "process.platform !== 'linux'", os: 'linux', reason: '[linux-only: /proc]', fileLevel: false, runs: { linux: false, win32: true, darwin: true } },
      { file: 'example.test.ts', line: 2, kind: 'runIf', condition: "process.platform === 'win32'", os: 'windows', reason: '[windows-only: job objects]', fileLevel: false, runs: { linux: false, win32: true, darwin: false } },
    ])
  })

  it('rejects a platform skip without a reason, or with an empty one', () => {
    for (const title of ["'reads /proc'", "'[linux-only:] reads /proc'", "'[linux-only: ] reads /proc'", "'[mac-only: x] reads /proc'"]) {
      expect(violationsIn(`it.skipIf(process.platform !== 'linux')(${title}, () => {})`), title).toEqual([`skipIf ${MISSING_REASON}`])
    }
  })

  it('recognizes other ways of reading the platform, including through a variable', () => {
    for (const condition of ["process['platform'] !== 'linux'", "os.platform() !== 'linux'", "globalThis.process.platform !== 'linux'"]) {
      expect(violationsIn(`describe.skipIf(${condition})('suite', () => {})`), condition).toEqual([`skipIf ${MISSING_REASON}`])
    }
    const aliased = `const isLinux = process.platform === 'linux'\nconst notLinux = !isLinux\ndescribe.skipIf(notLinux)`
    expect(violationsIn(`${aliased}('suite', () => {})`)).toEqual([`skipIf ${MISSING_REASON}`])
    expect(violationsIn(`${aliased}('[linux-only: /proc] suite', () => {})`)).toEqual([])
    expect(mismatchedIn(`${aliased}('[linux-only: /proc] suite', () => {})`)).toEqual([])
  })

  it('treats a conditional skip (Playwright test.skip, Vitest context.skip) as a guard', () => {
    expect(violationsIn(`test('ports', () => { test.skip(process.platform !== 'linux', 'needs /proc') })`)).toEqual([`skip ${MISSING_REASON}`])
    expect(violationsIn(`test('ports', () => { test.skip(process.platform !== 'linux', '[linux-only: /proc]') })`)).toEqual([])
    expect(violationsIn(`it('ports', (ctx) => { ctx.skip(process.platform !== 'linux') })`)).toEqual([`skip ${MISSING_REASON}`])
  })

  it('rejects a skipIf guard whose title is not a literal, such as a guard stored in a variable', () => {
    expect(violationsIn(`it.skipIf(process.platform !== 'linux')(title, () => {})`)).toEqual([`skipIf ${NON_LITERAL_TITLE}`])
    expect(violationsIn(`const itLinux = it.skipIf(process.platform !== 'linux')\nitLinux('[linux-only: /proc] a', () => {})`)).toEqual([`skipIf ${NON_LITERAL_TITLE}`])
  })

  it('rejects any other branch on the platform', () => {
    for (const body of [
      "if (process.platform !== 'linux') return",
      "if (process.platform === 'linux') { expect(1).toBe(1) }",
      "if (process.platform !== 'linux') ctx.skip()",
      "process.platform === 'linux' && expect(1).toBe(1)",
      "process.platform !== 'linux' || expect(1).toBe(1)",
      "const value = process.platform === 'linux' ? 1 : undefined",
      "switch (process.platform) { case 'linux': expect(1).toBe(1) }",
      "const isLinux = process.platform === 'linux'; if (isLinux) expect(1).toBe(1)",
    ]) {
      expect(violationsIn(`it('reads /proc', (ctx) => { ${body} })`), body).toEqual([PLATFORM_BRANCH])
    }
    // Also outside a test body: a helper that branches on the platform would hide it from the guards.
    expect(violationsIn(`function sep() { if (process.platform === 'win32') return '\\\\'; return '/' }`)).toEqual([PLATFORM_BRANCH])
  })

  it('allows combined guard conditions and ignores other conditions and platform data that is not the host', () => {
    expect(violationsIn(`it.skipIf(process.platform !== 'linux' || !process.env.PROC)('[linux-only: /proc] a', () => {})`)).toEqual([])
    expect(violationsIn(`it.skipIf(!process.env.CI)('slow', () => {})`)).toEqual([])
    expect(violationsIn(`it.skipIf(info.platform !== 'linux')('banner', () => {})`)).toEqual([])
    expect(violationsIn(`it('banner', () => { if (info.platform === 'linux') return; const x = a && b })`)).toEqual([])
  })

  it('evaluates guard conditions instead of matching their text', () => {
    // Equivalent spellings run a linux-only test on Linux only.
    for (const condition of ['process.platform !== "linux"', "'linux' !== process.platform", "!(process.platform === 'linux')"]) {
      expect(mismatchedIn(`it.skipIf(${condition})('[linux-only: /proc] a', () => {})`), condition).toEqual([])
    }
    expect(
      mismatchedIn(
        `it.skipIf(process.platform === 'win32')('[linux-only: /proc] a', () => {})
it.runIf(process.platform !== 'win32')('[linux-only: /proc] b', () => {})
it.skipIf(process.platform !== 'linux')('[windows-only: registry] c', () => {})
it.skipIf(process.platform !== 'linux' || !hasProc)('[linux-only: /proc] d', () => {})
test('e', () => { test.skip(process.platform === 'linux', '[linux-only: /proc]') })`,
      ),
    ).toEqual([1, 2, 3, 4, 5])
  })
})
