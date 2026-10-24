import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { QUIT_DEADLINE_MARGIN_MS, SIGNAL_DEADLINE_MS } from '../../src/main/app/quit'
import { KILL_WAIT_MS, POLL_INTERVAL_MS, SCAN_INTERVAL_MS } from '../../src/main/platform/linux/process-tree'
import { LEDGER_DIR, LEDGER_FILE, LEDGER_UPDATE_INTERVAL_MS } from '../../src/main/supervisor/ledger'
import { DEFAULT_STOP_TIMEOUT_MS, MAX_STOP_TIMEOUT_MS } from '../../src/shared/config'

const root = join(__dirname, '../..')
const doc = readFileSync(join(root, 'docs/processes.md'), 'utf8')

/** The `### …` sections under `## Limitations`. */
function limitations(): { title: string; body: string }[] {
  const section = doc.split('\n## ').find((part) => part.startsWith('Limitations\n'))
  if (section === undefined) throw new Error('no Limitations section')
  return section
    .split('\n### ')
    .slice(1)
    .map((part) => ({ title: part.slice(0, part.indexOf('\n')), body: part }))
}

describe('docs/processes.md matches the implementation', () => {
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
    for (const { title, body } of found) {
      const evidence = body.split('\n').find((line) => line.startsWith('Evidence: '))
      expect(evidence, `${title} has an Evidence line`).toBeDefined()
      const references = [...(evidence ?? '').matchAll(/`([^`]+)` › "([^"]+)"/g)]
      expect(references.length, `${title} references a test`).toBeGreaterThan(0)
      for (const [, file = '', name = ''] of references) {
        const path = join(root, file)
        expect(existsSync(path), `${title}: ${file} exists`).toBe(true)
        expect(readFileSync(path, 'utf8'), `${title}: ${file} contains "${name}"`).toContain(name)
      }
    }
  })
})
