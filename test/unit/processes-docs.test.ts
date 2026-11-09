import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { QUIT_DEADLINE_MARGIN_MS, SIGNAL_DEADLINE_MS } from '../../src/main/app/quit'
import { KILL_WAIT_MS, POLL_INTERVAL_MS, SCAN_INTERVAL_MS } from '../../src/main/platform/linux/process-tree'
import { LEDGER_DIR, LEDGER_FILE, LEDGER_UPDATE_INTERVAL_MS } from '../../src/main/supervisor/ledger'
import { HELPER_KILL_WAIT_MS } from '../../src/main/platform/windows/helper-client'
import { DEFAULT_STOP_TIMEOUT_MS, MAX_STOP_TIMEOUT_MS } from '../../src/shared/config'

const root = join(__dirname, '../..')
/** The Windows support statement of the preview (add-windows-environment-and-commands design D6). */
const WINDOWS_PREVIEW = 'Windows: preview. Run from source; verified in CI on Windows Server 2025. No Windows package yet.'
const doc = readFileSync(join(root, 'docs/processes.md'), 'utf8')

/** The `## <title>` section, without its heading. */
function section(title: string): string {
  const found = doc.split('\n## ').find((part) => part.startsWith(`${title}\n`))
  if (found === undefined) throw new Error(`no ${title} section`)
  return found.slice(title.length + 1)
}

/** The `### …` subsections of the `## <title>` section. */
function subsections(title: string): { title: string; body: string }[] {
  return section(title)
    .split('\n### ')
    .slice(1)
    .map((part) => ({ title: part.slice(0, part.indexOf('\n')), body: part }))
}

/** The `### …` sections under `## Limitations`. */
const limitations = (): { title: string; body: string }[] => subsections('Limitations')

/** Escapes `text` for use inside a regular expression. */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whether `source` declares a test (or measurement) whose title starts with, or contains, `name`
 * with a plain `it(` or `test(` call: a `.todo`, `.skip`, or `.only` declaration does not count.
 */
function declaresTest(source: string, name: string): boolean {
  return new RegExp(String.raw`\b(?:it|test)\(\s*(['"\x60])[^'"\x60\n]*${escapeRegExp(name)}`).test(source)
}

/** Every `file` › "test name" reference of an `Evidence:` line in `body` names a declared test. */
function expectEvidence(where: string, body: string): void {
  const evidence = body.split('\n').find((line) => line.startsWith('Evidence: '))
  expect(evidence, `${where} has an Evidence line`).toBeDefined()
  const references = [...(evidence ?? '').matchAll(/`([^`]+)` › "([^"]+)"/g)]
  expect(references.length, `${where} references a test`).toBeGreaterThan(0)
  for (const [, file = '', name = ''] of references) {
    const path = join(root, file)
    expect(existsSync(path), `${where}: ${file} exists`).toBe(true)
    expect(declaresTest(readFileSync(path, 'utf8'), name), `${where}: ${file} declares a test "${name}"`).toBe(true)
  }
}

describe('docs/processes.md matches the implementation', () => {
  it('counts only declared tests as evidence, not todo or skipped ones', () => {
    expect(declaresTest("it('ends the tree', () => {})", 'ends the tree')).toBe(true)
    // A multi-line call with a tagged title; a real scenario tag here would count in spec coverage.
    expect(declaresTest("it(\n    '[tag] ends the tree',", 'ends the tree')).toBe(true)
    expect(declaresTest("test('x [y] (z)', () => {})", 'x [y] (z)')).toBe(true)
    expect(declaresTest("it.todo('ends the tree')", 'ends the tree')).toBe(false)
    expect(declaresTest("it.skip('ends the tree', () => {})", 'ends the tree')).toBe(false)
    expect(declaresTest("const title = 'ends the tree'", 'ends the tree')).toBe(false)
  })

  it('documents the stop timing constants', () => {
    expect(doc).toContain(`every ${SCAN_INTERVAL_MS / 1000} seconds while the command runs`)
    expect(doc).toContain(`every ${POLL_INTERVAL_MS} ms`)
    expect(doc).toContain(`up to ${KILL_WAIT_MS / 1000} second more`)
    expect(doc).toContain(`${DEFAULT_STOP_TIMEOUT_MS / 1000} seconds by default, configurable per command from 0 to ${MAX_STOP_TIMEOUT_MS / 1000} seconds`)
  })

  it('documents quit, signal, and crash-recovery timing and files', () => {
    expect(doc).toContain(`the longest stop timeout of those commands plus ${QUIT_DEADLINE_MARGIN_MS / 1000} seconds`)
    expect(doc).toContain(`exits within ${SIGNAL_DEADLINE_MS / 1000} seconds`)
    expect(doc).toContain(`then \`SIGKILL\` after ${DEFAULT_STOP_TIMEOUT_MS / 1000} seconds`)
    expect(doc).toContain(`\`${LEDGER_DIR}/${LEDGER_FILE}\``)
    expect(LEDGER_UPDATE_INTERVAL_MS).toBe(1000)
    expect(doc).toContain('at most once per second')
    expect(doc).toContain(`observes descendants every ${SCAN_INTERVAL_MS / 1000} seconds`)
  })

  it('[spec:process-supervision/limitation-documented] states the crash, escaped-descendant, and PID-race limitations', () => {
    const found = limitations()
    expect(found.map((l) => l.title)).toEqual(expect.arrayContaining(['Escaped descendants', 'PID reuse between check and signal', 'After an abnormal exit']))
    expect(found.find((l) => l.title === 'After an abnormal exit')?.body).toContain('keep running **until Veydr is started again**')
    expect(found.find((l) => l.title === 'Escaped descendants')?.body).toContain('Veydr cannot stop it')
  })

  it('backs every documented limitation with an existing test or recorded measurement', () => {
    const found = limitations()
    expect(found.length).toBeGreaterThanOrEqual(3)
    for (const { title, body } of found) expectEvidence(title, body)
  })

  it('[spec:process-supervision/windows-limitations-documented] states the Windows crash behavior and what was not verified, labelled as part of the Windows preview', () => {
    const windows = section('Windows (preview)')
    // Labelled as the preview, before anything else is said.
    expect(windows.trimStart().startsWith(`**${WINDOWS_PREVIEW}**`)).toBe(true)
    expect(windows).toContain('are part of the preview')
    const parts = subsections('Windows (preview)')
    expect(parts.map((p) => p.title)).toEqual(['Containment', 'Stopping', 'After an abnormal exit on Windows', 'Differences from Linux', 'Not verified on the CI runner'])
    const part = (title: string): string => parts.find((p) => p.title === title)?.body ?? ''
    // Job Object containment, the Ctrl+Break graceful stop, and the forced stop.
    expect(part('Containment')).toContain('**Job Object**')
    expect(part('Containment')).toContain('**suspended**')
    expect(part('Stopping')).toContain('**Ctrl+Break**')
    expect(part('Stopping')).toContain(`(${DEFAULT_STOP_TIMEOUT_MS / 1000} seconds by default)`)
    expect(part('Stopping')).toContain('`TerminateJobObject`')
    expect(part('Stopping')).toContain(`up to ${HELPER_KILL_WAIT_MS / 1000} second more`)
    // An abnormal exit ends the tree; the ledger and survivors are only a fallback.
    const crash = part('After an abnormal exit on Windows')
    expect(crash).toContain('do **not** keep running after an abnormal exit')
    expect(crash).toContain('as a fallback only')
    expect(crash).toContain('PID and its creation time')
    // The image path instead of the command line, and one helper per command.
    expect(part('Differences from Linux')).toContain('full path of its executable image')
    expect(part('Differences from Linux')).toContain('one extra process, its helper')
    // What the runner could not verify.
    const unverified = part('Not verified on the CI runner')
    for (const condition of ['a desktop session', 'logging off or shutting down', 'no Job Object around it', 'administrator only']) {
      expect(unverified, condition).toContain(condition)
    }
    expectEvidence('Windows (preview)', windows)
  })

  it('records Windows process supervision in the deferred checks, and the preview that made it reachable from the app', () => {
    const deferred = readFileSync(join(root, 'docs/deferred-checks.md'), 'utf8')
    const row = deferred.split('\n').find((line) => line.startsWith('| Windows process supervision |'))
    expect(row).toBeDefined()
    expect(row).toContain('verified in CI')
    expect(row).toContain('**Not reachable from the app until W2**')
    expect(row).toContain('Since 2026-11-08 commands start on Windows, as a preview (see [Windows preview](#windows-preview-2026-11-08))')
    expect(row).toContain('unsigned')
    expect(row).toContain('antivirus')
    expect(row).toContain('(processes.md#not-verified-on-the-ci-runner)')
    expect(doc).toContain('(deferred-checks.md#windows-process-supervision-2026-11-06)')
    expect(deferred).toContain('\n## Windows process supervision (2026-11-06)\n')
    // The preview's own section keeps W4's packaging and helper-placement row.
    const preview = deferred.slice(deferred.indexOf('\n## Windows preview (2026-11-08)\n'))
    expect(preview).toContain(`| Windows commands | **${WINDOWS_PREVIEW}**`)
    expect(preview).toContain('| Windows packaging and helper placement | Unchanged, owned by W4')
    expect(preview).toContain('| Windows port inspection | Not available until W3')
  })
})

describe('the Windows preview is documented', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  /** README.md and every page of docs/, by name. */
  const pages = new Map<string, string>([
    ['README.md', readme],
    ...readdirSync(join(root, 'docs'))
      .filter((name) => name.endsWith('.md'))
      .map((name): [string, string] => [`docs/${name}`, readFileSync(join(root, 'docs', name), 'utf8')]),
  ])

  it('[spec:process-supervision/windows-preview-documented] says run from source, no Windows package, and lists what is not verified, claiming nothing beyond them', () => {
    // The preview statement, where the user reads about support and about processes.
    for (const [name, text] of [['README.md', readme], ['docs/processes.md', doc]] as const) {
      expect(text, name).toContain(`**${WINDOWS_PREVIEW}**`)
    }
    expect(readme.indexOf(WINDOWS_PREVIEW), 'the README states it before its first section').toBeLessThan(readme.indexOf('\n## '))
    const platformRow = readme.split('\n').find((line) => line.startsWith('| Windows x64 |')) ?? ''
    expect(platformRow).toContain('| **Preview.** Run from source; verified in CI on Windows Server 2025. No Windows package yet.')

    // How to run it from source, in order.
    const fromSource = readme.slice(readme.indexOf('\n### Running from source on Windows\n'))
    const steps = ['npm ci', 'node scripts/build-windows-helper.mjs', 'npm run dev'].map((step) => fromSource.indexOf(`   ${step}\n`))
    expect(steps.every((at) => at > 0)).toBe(true)
    expect([...steps].sort((x, y) => x - y)).toEqual(steps)
    expect(fromSource).toContain('**Node.js 24**')

    // What the runner cannot verify, the preview's additions included.
    const unverified = subsections('Windows (preview)').find((part) => part.title === 'Not verified on the CI runner')?.body ?? ''
    for (const condition of ['a desktop session', 'logging off or shutting down', 'no Job Object around it', 'a standard user account', 'localized ANSI code pages', '932, 936, 949 and 950', 'a user-customized `PATHEXT`', 'App Execution Aliases other than those the runner has', 'a Veydr started from Explorer']) {
      expect(unverified, condition).toContain(condition)
    }

    // No page claims more: no Windows package or installer, and no support beyond the preview. This
    // is a tripwire for the usual phrasings, not a proof that no page overstates the preview.
    const windows = String.raw`Windows(?: 1[01]| Server \d{4}| x64)?`
    const beyond = [
      new RegExp(String.raw`\b${windows} (?:is|are) (?:now |fully |officially )?supported\b`, 'i'),
      new RegExp(String.raw`\b(?:full|complete|stable|official) ${windows} support\b`, 'i'),
      new RegExp(String.raw`\b(?:Veydr|the app|it) (?:now |fully )?(?:supports|works on|runs on) ${windows}\b(?! (?:paths?|as a preview|in preview|from source))`, 'i'),
      new RegExp(String.raw`\b(?:fully|officially) supported on ${windows}\b`, 'i'),
      new RegExp(String.raw`\b${windows} (?:package|installer|build|release)s? (?:is|are) (?:now )?(?:available|published|provided|shipped)\b`, 'i'),
      new RegExp(String.raw`\b(?:download|install) (?:the |a )?${windows} (?:package|installer|build|release)\b`, 'i'),
      new RegExp(String.raw`\b${windows} users can (?:download|install)\b`, 'i'),
      /\bnot yet supported\b[^.\n]*\bWindows\b|\bWindows\b[^.\n]*\bnot yet supported\b/i,
    ]
    // The tripwire catches what it is meant to, and lets the preview's own wording through.
    for (const claim of ['Windows 11 is supported.', 'Veydr runs on Windows.', 'Download the Windows installer.', 'Windows users can install it.', 'Full Windows support.']) {
      expect(beyond.some((pattern) => pattern.test(claim)), claim).toBe(true)
    }
    for (const allowed of [WINDOWS_PREVIEW, 'Veydr supports Windows paths such as C:\\tools.', 'Veydr runs on Windows as a preview.', 'Port inspection is not available on Windows yet.']) {
      expect(beyond.some((pattern) => pattern.test(allowed)), allowed).toBe(false)
    }
    for (const [name, text] of pages) {
      // The dated records of docs/deferred-checks.md say what held at their date.
      const current = name === 'docs/deferred-checks.md' ? text.slice(text.indexOf('\n## Windows preview (2026-11-08)\n')) : text
      for (const pattern of beyond) expect(pattern.exec(current)?.[0], `${name}: ${String(pattern)}`).toBeUndefined()
    }
  })

  it('lifts the "not yet available" headings of the Windows sections', () => {
    for (const [name, text] of pages) {
      expect(text, name).not.toContain('Windows (not yet available)')
      expect(text, name).not.toContain('Not yet reachable from the app')
    }
    for (const name of ['docs/commands.md', 'docs/logs.md', 'docs/processes.md']) {
      expect(pages.get(name), name).toContain(`\n## Windows (preview)\n\n**${WINDOWS_PREVIEW}**`)
    }
  })
})
