import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOGIN_SHELL_TIMEOUT_MS } from '../../src/main/platform/linux/environment'
import { isRuntimeVariable } from '../../src/main/platform/runtime-env'
import { DEFAULT_SHELL, SECRET_STORAGE_DISCLOSURE } from '../../src/renderer/src/CommandEditor'

const root = join(__dirname, '../..')
const doc = readFileSync(join(root, 'docs/commands.md'), 'utf8')
const section = (title: string): string => doc.split('\n## ').find((part) => part.startsWith(`${title}\n`)) ?? ''
/** Code spans of a Markdown text, with table-escaped pipes restored. */
const codeSpans = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((m) => (m[1] ?? '').replaceAll('\\|', '|'))

describe('docs/commands.md', () => {
  it('uses examples that the end-to-end tests use', () => {
    const e2e = ['test/e2e/commands.spec.ts', 'test/e2e/projects.spec.ts'].map((file) => readFileSync(join(root, file), 'utf8')).join('\n')
    const examples = codeSpans(section('Examples')).filter((span) => !span.startsWith('test/'))
    expect(examples.length).toBeGreaterThan(8)
    for (const example of examples) {
      // A `<placeholder>` stands for a value the test computes; the text before it must match.
      const literal = example.split('<')[0] ?? ''
      expect(e2e, example).toContain(literal)
    }
  })

  it('states the timeout, default shell, and runtime variables of the code', () => {
    expect(doc).toContain(`takes longer than ${LOGIN_SHELL_TIMEOUT_MS / 1000} seconds`)
    expect(doc).toContain(`The shell defaults to \`${DEFAULT_SHELL}\``)
    const line = section('Environment').split('\n').find((l) => l.includes('runtime variables never reach')) ?? ''
    const listed = codeSpans(line.split("The shell's own")[0] ?? '')
    expect(listed.filter((name) => name !== 'ELECTRON_*')).toEqual(['NO_AT_BRIDGE', 'CHROME_DESKTOP', 'APPDIR', 'APPIMAGE', 'ARGV0', 'OWD'])
    for (const name of listed) expect(isRuntimeVariable(name.replace('*', 'X')), name).toBe(true)
  })

  it('discloses plaintext secret storage like the editor does', () => {
    expect(section('Secrets')).toContain('**stored unencrypted**')
    expect(SECRET_STORAGE_DISCLOSURE).toContain('stores them unencrypted')
  })
})
