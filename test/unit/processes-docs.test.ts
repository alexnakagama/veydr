import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KILL_WAIT_MS, POLL_INTERVAL_MS, SCAN_INTERVAL_MS } from '../../src/main/platform/linux/process-tree'
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

  it('states the escaped-descendant and PID-race limitations (the crash limitation follows in L4, task 5.6)', () => {
    const titles = limitations().map((l) => l.title)
    expect(titles).toContain('Escaped descendants')
    expect(titles).toContain('PID reuse between check and signal')
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
