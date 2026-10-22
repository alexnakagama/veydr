import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  engines: Record<string, string>
  allowScripts?: Record<string, boolean>
}
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, { version?: string; resolved?: string; integrity?: string; hasInstallScript?: boolean; link?: boolean }>
}

describe('dependency policy (docs/dependencies.md)', () => {
  it('pins every direct dependency to an exact version', () => {
    for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(range, name).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })

  it('has no install-time lifecycle scripts of its own', () => {
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) expect(pkg.scripts[hook], hook).toBeUndefined()
  })

  it('resolves every locked package from the npm registry with an integrity hash', () => {
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (path === '' || entry.link === true) continue
      expect(entry.resolved, path).toMatch(/^https:\/\/registry\.npmjs\.org\//)
      expect(entry.integrity, path).toMatch(/^sha512-/)
    }
  })

  it('records an explicit allowScripts decision for every locked package with an install script', () => {
    const withScripts = Object.entries(lock.packages)
      .filter(([, e]) => e.hasInstallScript === true)
      .map(([path]) => path.replace(/^node_modules\//, ''))
    for (const name of withScripts) expect(pkg.allowScripts?.[name], `${name} must be denied in allowScripts`).toBe(false)
  })

  it('pins the verified npm line, strictly, and delays brand-new releases', () => {
    expect(pkg.engines['npm']).toBeDefined()
    const npmrc = readFileSync(resolve(root, '.npmrc'), 'utf8')
    expect(npmrc).toContain('engine-strict=true')
    expect(npmrc).toMatch(/^min-release-age=([7-9]|[1-9]\d+)$/m)
  })
})
