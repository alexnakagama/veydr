import { join, resolve } from 'node:path'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '../..')
const fixtures = join(repoRoot, 'test/lint-fixtures')

/** Fixture file → the boundary rule it must trip (design D5). */
const boundaryRuleIds = ['no-restricted-imports', 'no-restricted-properties', 'no-restricted-syntax']

const violations: Record<string, string | string[]> = {
  'platform-import-linux.ts': 'no-restricted-imports',
  'platform-import-windows.ts': 'no-restricted-imports',
  'platform-import-relative.ts': 'no-restricted-imports',
  'process-platform-import.ts': 'no-restricted-imports',
  'process-platform-read.ts': 'no-restricted-properties',
  'os-platform.ts': 'no-restricted-properties',
  'process-platform-destructure.ts': 'no-restricted-properties',
  'os-named-import.ts': 'no-restricted-imports',
  'os-namespace-import.ts': ['no-restricted-imports', 'no-restricted-syntax', 'no-restricted-properties'],
  'globalthis-process-platform.ts': 'no-restricted-syntax',
  'process-alias.ts': 'no-restricted-syntax',
  'platform-dynamic-import.ts': 'no-restricted-syntax',
  'platform-require.ts': 'no-restricted-syntax',
  'os-renamed-default.ts': 'no-restricted-syntax',
  'process-renamed-default.ts': 'no-restricted-syntax',
  'require-os-platform.ts': 'no-restricted-syntax',
  'globalthis-process-destructure.ts': 'no-restricted-syntax',
  'os-dynamic-import.ts': 'no-restricted-syntax',
  'get-builtin-module.ts': 'no-restricted-syntax',
  'platform-computed-import.ts': 'no-restricted-syntax',
}

async function lint(files: string[]): Promise<Map<string, string[]>> {
  // `ignore: false` lifts the global ignore that keeps fixtures out of `npm run lint`.
  const eslint = new ESLint({ cwd: repoRoot, ignore: false })
  const results = await eslint.lintFiles(files)
  return new Map(results.map((r) => [r.filePath, r.messages.map((m) => m.ruleId ?? `fatal: ${m.message}`)]))
}

// Type-aware ESLint builds a TypeScript program per run: about 5 s on a Linux laptop, several times
// that on the Windows runner. A hang still fails, after a minute.
describe('platform boundary lint rules', { timeout: 60_000 }, () => {
  it('fails each violating fixture with (at least) its rule and no unrelated lint errors', async () => {
    const results = await lint(Object.keys(violations).map((f) => join(fixtures, f)))
    for (const [file, rule] of Object.entries(violations)) {
      const messages = results.get(join(fixtures, file)) ?? []
      // Overlapping rules may also fire; each fixture must trip its own rule and nothing but boundary rules.
      expect(messages, file).toEqual(expect.arrayContaining([rule].flat()))
      for (const id of messages) expect(boundaryRuleIds, `${file}: ${id}`).toContain(id)
    }
  })

  it('accepts code that depends on the platform module', async () => {
    const results = await lint([join(fixtures, 'allowed.ts'), join(fixtures, 'linux/index.ts')])
    for (const messages of results.values()) expect(messages).toEqual([])
  })

  it('allows the composition root and platform/index.ts to select implementations', async () => {
    const files = ['src/main/index.ts', 'src/main/platform/index.ts'].map((f) => join(repoRoot, f))
    const results = await lint(files)
    for (const messages of results.values()) expect(messages).toEqual([])
  })
})
