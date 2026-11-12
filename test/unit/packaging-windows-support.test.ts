import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { integrityOf, overwriteInPlace, parseAsar, readAsar, replaceFile } from '../packaging-windows/asar'
import { startRecordFor } from '../packaging-windows/global-setup'
import { aclChunks, cleanEnv, type InstallRecordLine, installerName, recordedStep, recordStep, standardUserStepPassed, startInstallRecord, windowsPowerShellEnv } from '../packaging-windows/support'
import { RUN_LAST, runLastOrder } from '../support/sequencer'
import { loggable, type ResultLine } from '../support/standard-user'

// The pure parts of the Windows packaging tests' support (add-windows-packaging design D3, tasks
// 2.3 and 2.4), which run on every system: the installer's name and the ASAR rewriting the fuse
// tests rely on, checked against @electron/asar, the library electron-builder packs with.

interface ElectronAsar {
  createPackageWithOptions(src: string, dest: string, options: Record<string, unknown>): Promise<void>
  extractFile(archive: string, file: string): Buffer
  listPackage(archive: string, options: Record<string, unknown>): string[]
  getRawHeader(archive: string): { headerString: string }
}
const builderRequire = createRequire(createRequire(__filename).resolve('app-builder-lib/package.json'))
const electronAsar = builderRequire('@electron/asar') as ElectronAsar

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('installerName (nsis.artifactName)', () => {
  it('names a release and a prerelease installer', () => {
    expect(installerName('1.2.3')).toBe('Veydr-1.2.3-x64-setup.exe')
    expect(installerName('1.2.3-rc.1')).toBe('Veydr-1.2.3-rc.1-x64-setup.exe')
    expect(installerName('0.1.0-rc.1')).toBe('Veydr-0.1.0-rc.1-x64-setup.exe')
  })

  it('refuses anything that is not a semantic version without build metadata', () => {
    for (const bad of ['', '1.2', '01.2.3', '1.2.3+build.5', '1.2.3-rc.01', '1.2.3-', '../1.2.3', '1.2.3\\..\\x', '1.2.3 ', 'v1.2.3', '1.2.3-rc/1']) {
      expect(() => installerName(bad), JSON.stringify(bad)).toThrow(/not a semantic version/)
    }
  })
})

describe('cleanEnv (Windows)', () => {
  it('drops ELECTRON_* and NODE_OPTIONS in any case, and an override replaces every spelling', () => {
    const saved = { ...process.env }
    try {
      process.env['electron_run_as_node'] = '1'
      process.env['Node_Options'] = '--require x'
      process.env['VEYDR_TEST_Case'] = 'old'
      const env = cleanEnv({ VEYDR_TEST_CASE: 'new' })
      expect(Object.keys(env).filter((k) => /^electron_|^node_options$/i.test(k))).toEqual([])
      expect(Object.entries(env).filter(([k]) => k.toUpperCase() === 'VEYDR_TEST_CASE')).toEqual([['VEYDR_TEST_CASE', 'new']])
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) Reflect.deleteProperty(process.env, key)
    }
  })
})

describe('windowsPowerShellEnv', () => {
  it('drops PSModulePath in any case, so Windows PowerShell 5.1 does not load PowerShell 7 modules', () => {
    const saved = { ...process.env }
    try {
      process.env['PSModulePath'] = 'C:\\Program Files\\PowerShell\\7\\Modules'
      process.env['psmodulepath_other'] = 'kept'
      const env = windowsPowerShellEnv({ VEYDR_FILE: 'x' })
      expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PSMODULEPATH')).toEqual([])
      expect(env['psmodulepath_other']).toBe('kept')
      expect(env['VEYDR_FILE']).toBe('x')
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) Reflect.deleteProperty(process.env, key)
      Object.assign(process.env, saved)
    }
  })
})

describe('ASAR rewriting', () => {
  async function fixture(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'veydr-asar-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'src/out/main'), { recursive: true })
    writeFileSync(join(dir, 'src/package.json'), '{"main":"out/main/index.js"}')
    writeFileSync(join(dir, 'src/out/main/index.js'), 'console.log("original main bundle")\n'.repeat(50))
    writeFileSync(join(dir, 'src/out/z-after.js'), 'after\n')
    await electronAsar.createPackageWithOptions(join(dir, 'src'), join(dir, 'app.asar'), {})
    return dir
  }

  it('reads what @electron/asar packs, with its per-file integrity', async () => {
    const dir = await fixture()
    const asar = readAsar(join(dir, 'app.asar'))
    expect(asar.files).toEqual(['/out/main/index.js', '/out/z-after.js', '/package.json'])
    expect(asar.headerJson).toBe(electronAsar.getRawHeader(join(dir, 'app.asar')).headerString)
    const main = asar.read('/out/main/index.js')
    expect(main.equals(readFileSync(join(dir, 'src/out/main/index.js')))).toBe(true)
    const stored = (asar.header.files?.['out']?.files?.['main']?.files?.['index.js'])?.integrity
    expect(stored).toEqual(integrityOf(main))
  })

  it('replaces a file with one of another size: a consistent header that @electron/asar reads back, and only the header hash differs', async () => {
    const dir = await fixture()
    const original = readAsar(join(dir, 'app.asar'))
    const data = Buffer.from('require("fs").writeFileSync("marker","x")\n')
    const rewritten = replaceFile(original, '/out/main/index.js', data)
    writeFileSync(join(dir, 'rewritten.asar'), rewritten)
    // @electron/asar looks files up by native path (backslashes on Windows).
    expect(electronAsar.extractFile(join(dir, 'rewritten.asar'), join('out', 'main', 'index.js')).equals(data)).toBe(true)
    expect(electronAsar.extractFile(join(dir, 'rewritten.asar'), join('out', 'z-after.js')).toString()).toBe('after\n')
    expect(electronAsar.extractFile(join(dir, 'rewritten.asar'), 'package.json').toString()).toBe('{"main":"out/main/index.js"}')
    const parsed = parseAsar(rewritten)
    expect(parsed.files).toEqual(original.files)
    expect(parsed.header.files?.['out']?.files?.['main']?.files?.['index.js']?.integrity).toEqual(integrityOf(data))
    expect(parsed.headerJson).not.toBe(original.headerJson)
    expect(() => replaceFile(original, '/missing.js', data)).toThrow(/not in the archive/)
  })

  it('overwrites bytes in place: same size, header untouched, per-file hash now stale', async () => {
    const dir = await fixture()
    const bytes = readFileSync(join(dir, 'app.asar'))
    const main = parseAsar(bytes).read('/out/main/index.js')
    const data = Buffer.alloc(main.length, ' ')
    Buffer.from('require("fs").writeFileSync("marker","x")').copy(data)
    const out = overwriteInPlace(bytes, '/out/main/index.js', data)
    expect(out.length).toBe(bytes.length)
    const parsed = parseAsar(out)
    expect(parsed.headerJson).toBe(parseAsar(bytes).headerJson)
    expect(parsed.read('/out/main/index.js').equals(data)).toBe(true)
    expect(parsed.read('/package.json').equals(parseAsar(bytes).read('/package.json'))).toBe(true)
    expect(() => overwriteInPlace(bytes, '/out/main/index.js', Buffer.from('short'))).toThrow(/bytes/)
  })

  it('rejects data that is not an archive', () => {
    expect(() => parseAsar(Buffer.from('not an archive at all'))).toThrow(/not an ASAR/)
  })
})

describe('the Windows install record (design D3, task 3.1)', () => {
  /** A dist\ directory holding a fake installer of `version`, and where the record goes. */
  function fakeDist(version = '1.2.3-rc.1', content = 'not really an installer\n'): { dist: string; record: string; digest: string } {
    const dir = mkdtempSync(join(tmpdir(), 'veydr-install-record-'))
    dirs.push(dir)
    const dist = join(dir, 'dist')
    mkdirSync(dist)
    writeFileSync(join(dist, installerName(version)), content)
    return { dist, record: join(dir, 'test-results', 'windows-install', 'steps.jsonl'), digest: createHash('sha256').update(content).digest('hex') }
  }
  const lines = (record: string): Record<string, unknown>[] => readFileSync(record, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>)

  it('starts the record with the installer\'s line as SHA256SUMS writes it', async () => {
    const { dist, record, digest } = fakeDist()
    expect(await startRecordFor({ dist, packageVersion: '1.2.3-rc.1', record })).toBe(`${digest}  Veydr-1.2.3-rc.1-x64-setup.exe`)
    const [first, ...rest] = lines(record)
    expect(rest).toEqual([])
    expect(first).toMatchObject({ step: 'installer', ok: true, detail: { installer: `${digest}  Veydr-1.2.3-rc.1-x64-setup.exe` } })
    expect(Object.keys(first ?? {}).sort()).toEqual(['at', 'detail', 'ok', 'step'])
    expect(readFileSync(record, 'utf8')).toMatch(/^[^\r]*\n$/)
  })

  it('replaces the record of an earlier run instead of appending to it', async () => {
    const { dist, record, digest } = fakeDist('1.2.3')
    await startRecordFor({ dist, packageVersion: '1.2.3', record })
    recordStep('administrator/install', true, { code: 0 }, record)
    expect(lines(record)).toHaveLength(2)
    await startRecordFor({ dist, packageVersion: '1.2.3', record })
    expect(lines(record)).toEqual([expect.objectContaining({ step: 'installer', detail: { installer: `${digest}  Veydr-1.2.3-x64-setup.exe` } })])
  })

  it('fails without an installer of the package version, or for a name that is not an installer\'s', async () => {
    const { dist, record } = fakeDist('1.2.3')
    await expect(startRecordFor({ dist, packageVersion: '1.2.4', record })).rejects.toThrow(/Veydr-1\.2\.4-x64-setup\.exe is missing: run `npm run dist:windows`/)
    await expect(startRecordFor({ dist, packageVersion: '1.2.3+build', record })).rejects.toThrow(/not a semantic version/)
    writeFileSync(join(dist, 'Veydr-1.2.3-x64-setup.EXE'), 'x')
    await expect(startInstallRecord(join(dist, 'Veydr-1.2.3-x64-setup.EXE'), record)).rejects.toThrow(/not an installer name/)
    mkdirSync(join(dist, 'Veydr-9.9.9-x64-setup.exe'))
    await expect(startInstallRecord(join(dist, 'Veydr-9.9.9-x64-setup.exe'), record)).rejects.toThrow(/not a regular file/)
    expect(existsSync(record)).toBe(false)
  })

  it('appends one { at, step, ok, detail } line per step, and records a failed step before rethrowing', async () => {
    const { dist, record } = fakeDist()
    expect(() => recordStep('administrator/install', true, null, record)).toThrow(/global setup did not run/)
    await startRecordFor({ dist, packageVersion: '1.2.3-rc.1', record })
    recordStep('administrator/install', true, { code: 0 }, record)
    recordStep('administrator/smoke', false, undefined, record)
    for (const bad of ['', 'Administrator/install', 'a b', 'x\n{"step":"forged"}', 'a//b', 'a/', '/a', 'a--b', '-a']) expect(() => recordStep(bad, true, null, record), bad).toThrow(/not a step name/)
    const [, install, smoke] = lines(record)
    expect(install).toMatchObject({ step: 'administrator/install', ok: true, detail: { code: 0 } })
    expect(smoke).toMatchObject({ step: 'administrator/smoke', ok: false, detail: null })
    expect(lines(record)).toHaveLength(3)
  })
})

describe('recordedStep', () => {
  it('records a step\'s result, or its error before rethrowing it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'veydr-install-record-'))
    dirs.push(dir)
    const record = join(dir, 'steps.jsonl')
    writeFileSync(record, '{"step":"installer"}\n')
    expect(await recordedStep('administrator/install', () => ({ code: 0 }), record)).toEqual({ code: 0 })
    await expect(recordedStep('administrator/smoke', () => Promise.reject(new Error('x'.repeat(5000))), record)).rejects.toThrow('xxx')
    await recordedStep('administrator/no-process', () => undefined, record)
    const [, ok, failed, empty] = readFileSync(record, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(ok).toMatchObject({ step: 'administrator/install', ok: true, detail: { code: 0 } })
    expect(failed).toMatchObject({ step: 'administrator/smoke', ok: false, detail: { error: 'x'.repeat(4000) } })
    expect(empty).toMatchObject({ step: 'administrator/no-process', ok: true, detail: null })
  })
})

describe('aclChunks', () => {
  it('splits paths so each chunk\'s JSON fits the limit, keeping their order', () => {
    const paths = Array.from({ length: 500 }, (_, i) => `C:\\Users\\runneradmin\\AppData\\Local\\Programs\\veydr\\locales\\file-${i}.pak`)
    const chunks = aclChunks(paths, 2_000)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.flat()).toEqual(paths)
    for (const chunk of chunks) expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(2_000)
    expect(aclChunks(['a'])).toEqual([['a']])
    expect(aclChunks([])).toEqual([])
    expect(() => aclChunks(['x'.repeat(100)], 50)).toThrow(/path too long/)
  })
})

// The standard user's installation (task 4.3, design D5): how its result lines are judged, the file
// order that puts it after the administrator's install, and the launcher output kept for the log.

describe('standardUserStepPassed', () => {
  const line = (id: string, answer: ResultLine['answer'], data: Record<string, unknown> = {}): ResultLine => ({ id, answer, detail: answer === 'yes' ? '' : 'why', data })
  const at = '2026-11-12T00:00:00.000Z'
  const adminSmoke = (ok: boolean): InstallRecordLine => ({ at, step: 'administrator/smoke', ok, detail: null })
  const first: InstallRecordLine = { at, step: 'installer', ok: true, detail: { installer: 'x' } }

  it('passes a step other than the smoke step only with yes', () => {
    for (const id of ['install-std-installer', 'install-std-install', 'install-std-permissions', 'install-std-helper', 'install-std-uninstall']) {
      expect(standardUserStepPassed(line(id, 'yes'), [first]), id).toBe(true)
      expect(standardUserStepPassed(line(id, 'no'), [first]), id).toBe(false)
      // A step answered null is never a pass, even marked not testable.
      expect(standardUserStepPassed(line(id, null, { smokeCase: 'not-testable' }), [first, adminSmoke(true), { at, step: 'administrator/stock-window', ok: true, detail: null }]), id).toBe(false)
    }
  })

  it('passes the smoke step when it passed, or when it was not testable while the administrator\'s smoke test of the same run passed', () => {
    expect(standardUserStepPassed(line('install-std-smoke', 'yes', { smokeCase: 'passed' }), [first])).toBe(true)
    // A yes that does not say it passed is malformed.
    expect(standardUserStepPassed(line('install-std-smoke', 'yes', {}), [first])).toBe(false)
    const notTestable = line('install-std-smoke', null, { smokeCase: 'not-testable' })
    const stockWindow = (ok: boolean): InstallRecordLine => ({ at, step: 'administrator/stock-window', ok, detail: null })
    expect(standardUserStepPassed(notTestable, [first, adminSmoke(true), stockWindow(true)])).toBe(true)
    expect(standardUserStepPassed(notTestable, [first, adminSmoke(false), stockWindow(true)])).toBe(false)
    // The control itself must be known to work where windows do: without that, a broken control would excuse any failure.
    expect(standardUserStepPassed(notTestable, [first, adminSmoke(true)])).toBe(false)
    expect(standardUserStepPassed(notTestable, [first, adminSmoke(true), stockWindow(false)])).toBe(false)
    // The administrator's smoke test did not run (yet): no evidence, no pass.
    expect(standardUserStepPassed(notTestable, [first])).toBe(false)
    expect(standardUserStepPassed(notTestable, [first, { at, step: 'administrator/reinstall', ok: true, detail: null }])).toBe(false)
    // A failure with the stock binary working, a null for another reason, or an unavailable account.
    expect(standardUserStepPassed(line('install-std-smoke', 'no', { smokeCase: 'failed' }), [first, adminSmoke(true)])).toBe(false)
    expect(standardUserStepPassed(line('install-std-smoke', null, {}), [first, adminSmoke(true)])).toBe(false)
    expect(standardUserStepPassed(line('install-std-smoke', null, { unavailable: true }), [first, adminSmoke(true)])).toBe(false)
  })
})

describe('the test file order (test/support/sequencer.ts)', () => {
  const spec = (project: string, moduleId: string) => ({ project: { name: project }, moduleId })

  it('runs the standard user\'s installation after every other file, keeping vitest\'s order otherwise', () => {
    expect(RUN_LAST).toEqual({ 'packaging-windows': ['standard-user-install.test.ts'] })
    const std = spec('packaging-windows', 'C:\\a\\veydr\\test\\packaging-windows\\standard-user-install.test.ts')
    const installer = spec('packaging-windows', 'C:\\a\\veydr\\test\\packaging-windows\\installer.test.ts')
    const fuses = spec('packaging-windows', '/repo/test/packaging-windows/fuses.test.ts')
    expect(runLastOrder([std, fuses, installer])).toEqual([fuses, installer, std])
    expect(runLastOrder([fuses, installer])).toEqual([fuses, installer])
    // Only that project's file, and only by its whole name.
    const otherProject = spec('unit', '/repo/test/unit/standard-user-install.test.ts')
    const similar = spec('packaging-windows', '/repo/test/packaging-windows/not-standard-user-install.test.ts')
    expect(runLastOrder([otherProject, similar, fuses])).toEqual([otherProject, similar, fuses])
  })
})

describe('the packaging-windows project', () => {
  it('runs one file at a time, which the sequencer\'s "standard user last" relies on', async () => {
    const config = (await import('../../vitest.config')).default as { test?: { sequence?: { sequencer?: unknown }; projects?: { test?: { name?: string; fileParallelism?: boolean } }[] } }
    const sequencer = (await import('../support/sequencer')).default
    expect(config.test?.sequence?.sequencer).toBe(sequencer)
    const project = config.test?.projects?.find((p) => p.test?.name === 'packaging-windows')
    expect(project?.test?.fileParallelism).toBe(false)
  })
})

describe('loggable', () => {
  it('drops workflow commands, so the launcher\'s ::add-mask:: line never reaches the log', () => {
    expect(loggable('::add-mask::s3cr3t\r\nstandard-user.ps1: created the account veydr-probe\n  ::warning::x\n')).toBe('standard-user.ps1: created the account veydr-probe')
  })
})
