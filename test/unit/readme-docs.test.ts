import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Task 10.4: README.md states the platform label, links every document, and repeats the secrets
// and crash-cleanup limitations.

const root = join(__dirname, '../..')
const readme = readFileSync(join(root, 'README.md'), 'utf8')
const section = (title: string): string => readme.split('\n## ').find((part) => part.startsWith(`${title}\n`)) ?? ''
/** Relative link targets (without anchors) of Markdown links and `src`/`srcset`/`href` attributes. */
const targets = [...readme.matchAll(/\]\(([^)\s]+)\)|(?:src|srcset|href)="([^"]+)"/g)]
  .map((m) => (m[1] ?? m[2] ?? '').split('#')[0] ?? '')
  .filter((t) => t !== '' && !/^[a-z]+:/.test(t))

describe('README.md', () => {
  it('states "Linux only; Windows not yet supported" near the top', () => {
    expect(readme).toContain('Linux only; Windows not yet supported')
    expect(readme.indexOf('Linux only; Windows not yet supported')).toBeLessThan(readme.indexOf('\n## '))
  })

  it('links every document in docs/', () => {
    const docs = readdirSync(join(root, 'docs')).filter((name) => name.endsWith('.md'))
    expect(docs.length).toBeGreaterThan(0)
    for (const name of docs) expect(section('Documentation'), name).toContain(`](docs/${name})`)
  })

  it('has no broken relative links', () => {
    expect(targets.length).toBeGreaterThan(0)
    for (const target of targets) expect(existsSync(join(root, target)), target).toBe(true)
  })

  it('repeats the secrets and crash-cleanup limitations', () => {
    const limitations = section('Known limitations')
    expect(limitations).toContain('**Secrets are stored unencrypted.**')
    expect(limitations).toContain('protected only by its file permissions (`0600`)')
    expect(limitations).toContain('Redaction in output is best effort')
    expect(limitations).toContain('**Crash cleanup has limits.**')
    expect(limitations).toContain('keep running until Veydr is started again and you terminate them')
    expect(limitations).toContain('may not be found')
    expect(limitations).toContain('](docs/processes.md#limitations)')
  })
})
