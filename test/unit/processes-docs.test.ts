import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { QUIT_DEADLINE_MARGIN_MS, SIGNAL_DEADLINE_MS } from '../../src/main/app/quit'
import { KILL_WAIT_MS, POLL_INTERVAL_MS, SCAN_INTERVAL_MS } from '../../src/main/platform/linux/process-tree'
import { LEDGER_DIR, LEDGER_FILE, LEDGER_UPDATE_INTERVAL_MS } from '../../src/main/supervisor/ledger'
import { HELPER_KILL_WAIT_MS } from '../../src/main/platform/windows/helper-client'
import { DEFAULT_STOP_TIMEOUT_MS, MAX_STOP_TIMEOUT_MS } from '../../src/shared/config'

const root = join(__dirname, '../..')
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
    expect(declaresTest("it(\n    '[spec:a/b] ends the tree',", 'ends the tree')).toBe(true)
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

  it('[spec:process-supervision/windows-limitations-documented] states the Windows crash behavior and what was not verified, as not yet reachable from the app', () => {
    const windows = section('Windows (not yet available)')
    // Labelled as not reachable from the app, before anything else is said.
    expect(windows.trimStart().startsWith('**Not yet reachable from the app.** Windows is not yet supported')).toBe(true)
    const parts = subsections('Windows (not yet available)')
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
    expectEvidence('Windows (not yet available)', windows)
  })

  it('records Windows process supervision in the deferred checks, as not reachable from the app', () => {
    const deferred = readFileSync(join(root, 'docs/deferred-checks.md'), 'utf8')
    const row = deferred.split('\n').find((line) => line.startsWith('| Windows process supervision |'))
    expect(row).toBeDefined()
    expect(row).toContain('verified in CI')
    expect(row).toContain('**Not reachable from the app until W2**')
    expect(row).toContain('unsigned')
    expect(row).toContain('antivirus')
    expect(row).toContain('(processes.md#not-verified-on-the-ci-runner)')
    expect(doc).toContain('(deferred-checks.md#windows-process-supervision-2026-11-06)')
    expect(deferred).toContain('\n## Windows process supervision (2026-11-06)\n')
  })
})
