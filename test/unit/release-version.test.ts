import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkVersion, compareVersions, FORMAT, parseVersion } from '../../scripts/release-version.mjs'

// Design D5: version validation and precedence for the release workflow.

const root = resolve(__dirname, '../..')
const script = join(root, 'scripts/release-version.mjs')

describe('parseVersion', () => {
  it('parses a release and a prerelease version', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
    expect(parseVersion('0.3.0-rc.1')).toEqual({ major: 0, minor: 3, patch: 0, prerelease: ['rc', '1'] })
    expect(parseVersion('1.0.0-x-y.0a.-')).toEqual({ major: 1, minor: 0, patch: 0, prerelease: ['x-y', '0a', '-'] })
  })

  it.each([
    '1.2',
    'v1.2.3',
    '1.2.3+build.5',
    '1.2.3-rc.1+build.5',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-01',
    '1.2.3-',
    '1.2.3-rc..1',
    '1.2.3-rc_1',
    ' 1.2.3',
    '1.2.3\n',
    '1.2.3.4',
    '',
    '9007199254740992.0.0',
  ])('rejects %j', (text) => {
    expect(parseVersion(text)).toBeNull()
  })
})

describe('compareVersions', () => {
  it('orders by major, minor and patch numerically', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1)
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1)
  })

  it('[spec:release-automation/prerelease-ordering] follows SemVer 2.0 prerelease precedence', () => {
    const ascending = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1-0',
    ]
    for (const [i, lower] of ascending.entries()) {
      for (const higher of ascending.slice(i + 1)) {
        expect(compareVersions(lower, higher), `${lower} < ${higher}`).toBe(-1)
        expect(compareVersions(higher, lower), `${higher} > ${lower}`).toBe(1)
      }
    }
  })

  it('compares numeric identifiers numerically and below alphanumeric ones', () => {
    expect(compareVersions('1.0.0-2', '1.0.0-10')).toBe(-1)
    expect(compareVersions('1.0.0-99999999999999999998', '1.0.0-99999999999999999999')).toBe(-1)
    expect(compareVersions('1.0.0-999', '1.0.0-a')).toBe(-1)
    expect(compareVersions('1.0.0-a', '1.0.0-1')).toBe(1)
    // Alphanumeric identifiers compare in ASCII order: uppercase sorts before lowercase.
    expect(compareVersions('1.0.0-RC', '1.0.0-rc')).toBe(-1)
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0)
  })

  it('throws on a malformed version', () => {
    expect(() => compareVersions('v1.0.0', '1.0.0')).toThrow(/invalid version "v1.0.0"/)
  })
})

describe('checkVersion', () => {
  it.each(['1.2', 'v1.2.3', '1.2.3+build.5'])(
    '[spec:release-automation/malformed-version] rejects %j, naming the expected format',
    (requested) => {
      expect(checkVersion({ requested, current: '0.0.0', tags: [] })).toEqual({
        ok: false,
        error: `invalid version "${requested}": expected ${FORMAT}`,
      })
      expect(FORMAT).toMatch(/MAJOR\.MINOR\.PATCH/)
    },
  )

  it.each(['0.2.0', '0.1.9', '0.0.1'])(
    '[spec:release-automation/version-not-greater-than-the-latest] rejects %j after v0.2.0, naming the latest version',
    (requested) => {
      const result = checkVersion({ requested, current: '0.0.0', tags: ['v0.1.0', 'v0.2.0', 'v0.1.5'] })
      expect(result.ok).toBe(false)
      expect(!result.ok && result.error).toMatch(/latest version 0\.2\.0 \(tag v0\.2\.0\)/)
    },
  )

  it('rejects a version not greater than package.json when no tag is newer', () => {
    const result = checkVersion({ requested: '0.4.0', current: '0.5.0', tags: ['v0.2.0'] })
    expect(result).toEqual({ ok: false, error: 'version 0.4.0 must be greater than the latest version 0.5.0 (package.json)' })
    expect(checkVersion({ requested: '0.5.0', current: '0.5.0', tags: [] }).ok).toBe(false)
  })

  it('rejects a malformed package.json version without throwing', () => {
    expect(checkVersion({ requested: '1.0.0', current: 'v0.1', tags: [] })).toEqual({
      ok: false,
      error: 'package.json version "v0.1" is not a valid version',
    })
  })

  it('rejects a version whose tag already exists', () => {
    expect(checkVersion({ requested: '0.3.0', current: '0.0.0', tags: ['v0.3.0'] })).toEqual({
      ok: false,
      error: 'tag v0.3.0 already exists; the version must be greater than the latest version 0.3.0 (tag v0.3.0)',
    })
  })

  it('ignores tags that are not a v-prefixed release version', () => {
    const result = checkVersion({ requested: '0.1.0', current: '0.0.0', tags: ['v9', 'vnext', 'v2.0.0+build.1', 'release-5.0.0'] })
    expect(result).toEqual({ ok: true, tag: 'v0.1.0', prerelease: false })
  })

  it('[spec:release-automation/prerelease-version] accepts a prerelease and marks it as one', () => {
    expect(checkVersion({ requested: '0.3.0-rc.1', current: '0.0.0', tags: ['v0.2.0'] })).toEqual({
      ok: true,
      tag: 'v0.3.0-rc.1',
      prerelease: true,
    })
    expect(checkVersion({ requested: '0.3.0', current: '0.0.0', tags: ['v0.2.0'] })).toEqual({
      ok: true,
      tag: 'v0.3.0',
      prerelease: false,
    })
  })

  it('[spec:release-automation/prerelease-ordering] accepts 0.3.0 after v0.3.0-rc.1, but not another 0.3.0 prerelease below it', () => {
    const tags = ['v0.2.0', 'v0.3.0-rc.1']
    expect(checkVersion({ requested: '0.3.0', current: '0.2.0', tags })).toEqual({ ok: true, tag: 'v0.3.0', prerelease: false })
    expect(checkVersion({ requested: '0.3.0-rc.2', current: '0.2.0', tags }).ok).toBe(true)
    expect(checkVersion({ requested: '0.3.0-beta.1', current: '0.2.0', tags }).ok).toBe(false)
  })
})

describe('release-version CLI', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    return result.stdout
  }

  const readJson = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>

  /**
   * A git repository holding only copies of the project's package.json and package-lock.json,
   * committed, at version 0.0.0 whatever the project's own version is: the release runs these
   * tests on a tree it already bumped to the version being released.
   */
  function tempCopy(): string {
    const dir = mkdtempSync(join(tmpdir(), 'veydr-release-version-'))
    dirs.push(dir)
    for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(root, file), join(dir, file))
    const pkg = readJson(join(dir, 'package.json'))
    const lock = readJson(join(dir, 'package-lock.json'))
    const lockPackages = lock['packages'] as Record<string, Record<string, unknown>>
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ ...pkg, version: '0.0.0' }, null, 2)}\n`)
    writeFileSync(
      join(dir, 'package-lock.json'),
      `${JSON.stringify({ ...lock, version: '0.0.0', packages: { ...lockPackages, '': { ...lockPackages[''], version: '0.0.0' } } }, null, 2)}\n`,
    )
    git(dir, 'init', '--quiet')
    git(dir, 'add', 'package.json', 'package-lock.json')
    git(dir, 'commit', '--quiet', '--message', 'initial')
    return dir
  }

  const cli = (cwd: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '', ...env } })

  it('apply sets the new version in package.json and package-lock.json and changes nothing else', () => {
    const dir = tempCopy()
    const before = { pkg: readJson(join(dir, 'package.json')), lock: readJson(join(dir, 'package-lock.json')) }

    const result = cli(dir, ['apply', '0.1.0-rc.1'])
    expect(result.status, result.stderr).toBe(0)

    const pkg = readJson(join(dir, 'package.json'))
    const lock = readJson(join(dir, 'package-lock.json'))
    const lockPackages = lock['packages'] as Record<string, Record<string, unknown>>
    expect(pkg['version']).toBe('0.1.0-rc.1')
    expect(lock['version']).toBe('0.1.0-rc.1')
    expect(lockPackages['']?.['version']).toBe('0.1.0-rc.1')

    // Only the version fields differ.
    const beforePackages = before.lock['packages'] as Record<string, Record<string, unknown>>
    expect(pkg).toEqual({ ...before.pkg, version: '0.1.0-rc.1' })
    expect(lock).toEqual({
      ...before.lock,
      version: '0.1.0-rc.1',
      packages: { ...beforePackages, '': { ...beforePackages[''], version: '0.1.0-rc.1' } },
    })
    expect(readdirSync(dir).sort()).toEqual(['.git', 'package-lock.json', 'package.json'])
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).sort()).toEqual([
      ' M package-lock.json',
      ' M package.json',
    ])
  })

  it('apply fails when any other file changed', () => {
    const dir = tempCopy()
    writeFileSync(join(dir, 'stray.txt'), 'not part of the bump\n')
    const result = cli(dir, ['apply', '0.1.0'])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/expected only package\.json and package-lock\.json to change.*also changed: stray\.txt/)
  })

  it('apply fails when another tracked file is modified', () => {
    const dir = tempCopy()
    writeFileSync(join(dir, 'tracked.txt'), 'one\n')
    git(dir, 'add', 'tracked.txt')
    git(dir, 'commit', '--quiet', '--message', 'tracked')
    writeFileSync(join(dir, 'tracked.txt'), 'two\n')
    const result = cli(dir, ['apply', '0.1.0'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('also changed: tracked.txt')
  })

  it('apply fails when npm version itself fails (the version is unchanged)', () => {
    const dir = tempCopy()
    const current = String(readJson(join(dir, 'package.json'))['version'])
    const result = cli(dir, ['apply', current])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/npm version .* exited with/)
    expect(git(dir, 'status', '--porcelain')).toBe('')
  })

  it('apply does not run version lifecycle scripts', () => {
    const dir = tempCopy()
    const pkg = readJson(join(dir, 'package.json'))
    const hook = `node -e "require('fs').writeFileSync('hooked', '')"`
    pkg['scripts'] = { ...(pkg['scripts'] as Record<string, string>), preversion: hook, version: hook, postversion: hook }
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
    git(dir, 'commit', '--quiet', '--all', '--message', 'add version scripts')
    const result = cli(dir, ['apply', '0.1.0'])
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(dir, 'hooked'))).toBe(false)
  })

  it('runs as a CLI when invoked through a symlink or a relative path', () => {
    const dir = tempCopy()
    const link = join(mkdtempSync(join(tmpdir(), 'veydr-release-version-link-')), 'release-version.mjs')
    dirs.push(dirname(link))
    symlinkSync(script, link)
    const output = join(dir, 'github-output')
    for (const entry of [link, relative(dir, script)]) {
      writeFileSync(output, '')
      const result = spawnSync(process.execPath, [entry, 'check', '9.9.9'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_OUTPUT: output },
      })
      expect(result.status, entry).toBe(0)
      expect(result.stdout, entry).toContain('9.9.9 is valid')
      expect(readFileSync(output, 'utf8'), entry).toBe('tag=v9.9.9\nprerelease=false\n')
    }
  })

  it('apply refuses a malformed version before running npm', () => {
    const dir = tempCopy()
    const result = cli(dir, ['apply', 'v0.1.0'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('invalid version "v0.1.0"')
    expect(git(dir, 'status', '--porcelain')).toBe('')
  })

  it('check reads the git tags and writes tag and prerelease to $GITHUB_OUTPUT', () => {
    const dir = tempCopy()
    git(dir, 'tag', 'v0.2.0')
    const output = join(dir, 'github-output')
    writeFileSync(output, 'existing=1\n')

    const refused = cli(dir, ['check', '0.2.0'], { GITHUB_OUTPUT: output })
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('tag v0.2.0 already exists; the version must be greater than the latest version 0.2.0 (tag v0.2.0)')
    const lower = cli(dir, ['check', '0.1.9'], { GITHUB_OUTPUT: output })
    expect(lower.status).toBe(1)
    expect(lower.stderr).toContain('latest version 0.2.0 (tag v0.2.0)')
    expect(readFileSync(output, 'utf8')).toBe('existing=1\n')

    const accepted = cli(dir, ['check', '0.3.0-rc.1'], { GITHUB_OUTPUT: output })
    expect(accepted.status, accepted.stderr).toBe(0)
    expect(readFileSync(output, 'utf8')).toBe('existing=1\ntag=v0.3.0-rc.1\nprerelease=true\n')
  })

  it('rejects unknown subcommands and missing or extra arguments with exit code 2', () => {
    const dir = tempCopy()
    for (const args of [[], ['check'], ['tag', '1.0.0'], ['check', '1.0.0', 'extra']]) {
      const result = cli(dir, args)
      expect(result.status, args.join(' ')).toBe(2)
      expect(result.stderr).toContain('usage: release-version.mjs check|apply <version>')
    }
  })
})
