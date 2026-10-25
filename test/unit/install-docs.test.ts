import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '../..')
const doc = readFileSync(join(root, 'docs/install-linux.md'), 'utf8')
/** `scripts/smoke-linux.sh`'s summary of the recorded run (task 9.5). */
const recorded = readFileSync(join(root, 'test/packaging/smoke-linux-summary.txt'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => {
    const [image = '', mode = '', check = '', status = ''] = line.split(' ')
    const version = /\[([^;]+);/.exec(line)?.[1] ?? ''
    const glibc = / (\d+\.\d+)\]$/.exec(line)?.[1] ?? ''
    return { image, mode, check, status, version, glibc }
  })

/** Rows of the "Supported distributions" table: distribution → cells. */
function supportTable(): Map<string, string[]> {
  const section = doc.split('\n## ').find((part) => part.startsWith('Supported distributions\n')) ?? ''
  const rows = section.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Distribution') && !line.startsWith('|---'))
  return new Map(rows.map((row) => row.split('|').slice(1, -1).map((cell) => cell.trim())).map((cells) => [cells[0] ?? '', cells.slice(1)]))
}

const status = (image: string, mode: string, check: string): string | undefined => recorded.find((r) => r.image === image && r.mode === mode && r.check === check)?.status

describe('docs/install-linux.md', () => {
  it('lists exactly the distributions of the recorded smoke run, with their glibc and results', () => {
    const table = supportTable()
    const images = [...new Set(recorded.map((r) => r.image))]
    expect(images).toEqual(['ubuntu:22.04', 'ubuntu:24.04', 'debian:12', 'debian:13', 'fedora:44'])
    expect(table.size).toBe(images.length)
    for (const image of images) {
      const record = recorded.find((r) => r.image === image)
      const name = (record?.version ?? '').replace(/ LTS$/, '').replace(/^Debian GNU\/Linux (\d+) .*$/, 'Debian $1').replace(/^Fedora Linux (\d+) .*$/, 'Fedora $1').replace(/^(Ubuntu \d+\.\d+)\.\d+$/, '$1')
      const cells = table.get(name)
      expect(cells, `${image} (${name})`).toBeDefined()
      const [glibc, deb, appImage, supported] = cells ?? []
      expect(glibc).toBe(record?.glibc)
      // Supported means: what the row says passed did pass with user namespaces.
      // Footnote marks (¹ ²) qualify a cell; the status itself must match the record.
      const plain = (cell: string | undefined): string => (cell ?? '').replace(/[¹²]/g, '')
      const debStatus = status(image, 'userns', 'deb')
      expect(plain(deb)).toBe(debStatus === 'N/A' ? 'n/a' : debStatus)
      expect(plain(appImage)).toBe(status(image, 'userns', 'appimage-extract'))
      // A passing .deb is footnoted: its setuid path was not verified (no-userns runs are NOT-TESTABLE).
      if (debStatus === 'PASS') {
        expect(deb).toBe('PASS¹')
        expect(status(image, 'no-userns', 'deb')).toBe('NOT-TESTABLE')
      }
      // Ubuntu 24.04 stays pending until its real-host check (task 9.6) is done.
      if (image === 'ubuntu:24.04') expect(supported).toMatch(/^pending 9\.6/)
      else expect(supported?.startsWith('yes')).toBe(plain(deb) === 'PASS' || plain(appImage) === 'PASS')
    }
  })

  it('records the documented failures as expected and nothing as failed', () => {
    expect(recorded.filter((r) => r.status === 'FAIL')).toEqual([])
    for (const r of recorded.filter((r) => r.check === 'appimage-no-fuse')) expect(r.status).toBe('EXPECTED-FAIL')
    for (const r of recorded.filter((r) => r.mode === 'no-userns' && r.check === 'appimage-extract')) expect(r.status).toBe('EXPECTED-FAIL')
    expect(doc).toContain('**`libfuse2`**')
    expect(doc).toContain('refuses to start')
    expect(doc).toContain('**Does not start on Ubuntu 24.04**')
    expect(doc).toContain('¹ With user namespaces available. The setuid `chrome-sandbox` path')
  })

  it('states the glibc floor the packaging test enforces and marks the Ubuntu 24.04 host check as blocked', () => {
    const test = readFileSync(join(root, 'test/packaging/glibc.test.ts'), 'utf8')
    expect(test).toContain('const GLIBC_FLOOR = [2, 35] as const')
    expect(doc).toMatch(/glibc \*\*2\.25\*\* or newer/)
    expect(doc).toContain('**BLOCKED**')
  })

  it('names files that exist', () => {
    for (const file of ['scripts/smoke-linux.sh', 'test/packaging/glibc.test.ts', 'test/packaging/smoke-linux-summary.txt', 'docs/commands.md']) {
      expect(existsSync(join(root, file)), file).toBe(true)
    }
    for (const match of doc.matchAll(/\]\(([\w-]+\.md)\)/g)) expect(existsSync(join(root, 'docs', match[1] ?? '')), match[1]).toBe(true)
  })
})
