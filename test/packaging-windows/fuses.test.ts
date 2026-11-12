import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { overwriteInPlace, readAsar, replaceFile } from './asar'
import { cleanEnv, distDir, PROBE_COPY_PREFIX, requirePackages, resourcesDir, run, smokeReportOf, unpackedBinary, unpackedDir, type WindowsRunResult } from './support'

// The fuses and the archive validation of the packaged Windows binary, `dist\win-unpacked\Veydr.exe`
// (add-windows-packaging design D3, task 2.4). Every refusal has a control with the stock Electron
// binary, which shows that the same input would otherwise run: a marker file written by the
// modified code. Copies of a build are hard links below dist\ (one volume), each made fresh.

const electronBinary = createRequire(__filename)('electron') as string
const MAIN_BUNDLE = '/out/main/index.js'

/** Electron's fuse wire (https://github.com/electron/fuses): sentinel, version byte, length byte, one byte per fuse. */
const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
const FUSES = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
] as const

function readFuses(binary: string): Record<string, 'enabled' | 'disabled' | 'removed' | 'unknown'> {
  const bytes = readFileSync(binary)
  const at = bytes.indexOf(SENTINEL)
  if (at === -1 || bytes.lastIndexOf(SENTINEL) !== at) throw new Error(`expected exactly one fuse sentinel in ${binary}`)
  const wire = at + SENTINEL.length
  if (bytes[wire] !== 1) throw new Error(`unexpected fuse wire version ${String(bytes[wire])}`)
  const length = bytes[wire + 1] ?? 0
  const states: Record<string, 'enabled' | 'disabled' | 'removed' | 'unknown'> = {}
  for (let i = 0; i < length; i += 1) {
    const state = bytes[wire + 2 + i]
    states[FUSES[i] ?? `fuse${i}`] = state === 0x31 ? 'enabled' : state === 0x30 ? 'disabled' : state === 0x72 ? 'removed' : 'unknown'
  }
  return states
}

/** Hard-links every file below `from` into `to` (top-level entries filtered by `accept`). */
function linkTree(from: string, to: string, accept: (name: string) => boolean = () => true): void {
  for (const name of readdirSync(from)) {
    if (!accept(name)) continue
    const source = join(from, name)
    if (statSync(source).isDirectory()) {
      mkdirSync(join(to, name))
      linkTree(source, join(to, name))
    } else {
      linkSync(source, join(to, name))
    }
  }
}

const copies: string[] = []

/**
 * A fresh copy of the build in `from` (the unpacked package or stock Electron) whose `resources\`
 * holds what `resources` writes into it. Returns the copy's directory.
 */
function copyOf(from: string, resources: (dir: string) => void): string {
  const copy = mkdtempSync(join(distDir, PROBE_COPY_PREFIX))
  copies.push(copy)
  linkTree(from, copy, (name) => name !== 'resources')
  mkdirSync(join(copy, 'resources'))
  resources(join(copy, 'resources'))
  return copy
}

/** A main bundle that writes `marker` and exits, in place of Veydr's. */
const markerScript = (marker: string): string => `require("fs").writeFileSync(${JSON.stringify(marker)},"x");process.exit(0);`

/** The packaged archive with the main bundle replaced by `markerScript`, the header rewritten to match (case a). */
function archiveWithIndexChanged(marker: string): Buffer {
  return replaceFile(readAsar(join(resourcesDir, 'app.asar')), MAIN_BUNDLE, Buffer.from(markerScript(marker)))
}

/** The packaged archive with the main bundle's bytes overwritten in place, same size, header untouched (case b). */
function archiveWithBytesChanged(marker: string): Buffer {
  const bytes = readFileSync(join(resourcesDir, 'app.asar'))
  const size = readAsar(join(resourcesDir, 'app.asar')).read(MAIN_BUNDLE).length
  const script = Buffer.from(markerScript(marker))
  if (script.length > size) throw new Error('the main bundle is shorter than the marker script')
  const data = Buffer.alloc(size, ' ')
  script.copy(data)
  return overwriteInPlace(bytes, MAIN_BUNDLE, data)
}

/** Runs a stock Electron copy whose `resources\app.asar` is `archive`, and returns whether it wrote `marker`. */
async function stockRunsArchive(archive: Buffer, marker: string): Promise<boolean> {
  const stock = copyOf(dirname(electronBinary), (dir) => writeFileSync(join(dir, 'app.asar'), archive))
  await run(join(stock, basename(electronBinary)), [], cleanEnv(), { timeoutMs: 60_000, allowTimeout: true })
  const wrote = existsSync(marker)
  rmSync(marker, { force: true })
  return wrote
}

/** Runs a packaged copy whose `resources\app.asar` is `archive`, with the helper beside it. */
function packagedRun(archive: Buffer): Promise<WindowsRunResult> {
  const copy = copyOf(unpackedDir, (dir) => {
    writeFileSync(join(dir, 'app.asar'), archive)
    linkSync(join(resourcesDir, 'veydr-helper.exe'), join(dir, 'veydr-helper.exe'))
  })
  // A binary that refuses its archive may wait on an error dialog: a timeout counts as not started.
  return run(join(copy, 'Veydr.exe'), ['--smoke-test'], cleanEnv(), { timeoutMs: 60_000, allowTimeout: true })
}

const started = (result: WindowsRunResult): boolean => result.stdout.includes('VEYDR_SMOKE_TEST ')

describe.skipIf(process.platform !== 'win32')('[windows-only: the packaged Windows binary] fuses and archive validation', () => {
  let work: string
  beforeAll(() => {
    requirePackages()
    work = mkdtempSync(join(tmpdir(), 'veydr-fuses-'))
  })
  // A leftover descendant (a crash handler) may still hold a copy's files; that must not fail the
  // tests that ran. requirePackages() removes any copy left behind before the next file runs.
  afterAll(() => {
    for (const dir of [...copies.splice(0), work]) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
      } catch (error) {
        console.warn(`could not remove ${dir}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })

  it('has the six fuses of design D2 set in dist\\win-unpacked\\Veydr.exe', () => {
    expect(readFuses(unpackedBinary)).toMatchObject({
      RunAsNode: 'disabled',
      EnableCookieEncryption: 'enabled',
      EnableNodeOptionsEnvironmentVariable: 'disabled',
      EnableNodeCliInspectArguments: 'disabled',
      EnableEmbeddedAsarIntegrityValidation: 'enabled',
      OnlyLoadAppFromAsar: 'enabled',
    })
    // The reader is not trivially satisfied: the stock Electron binary has the defaults.
    expect(readFuses(electronBinary)).toMatchObject({ RunAsNode: 'enabled', EnableNodeOptionsEnvironmentVariable: 'enabled', EnableEmbeddedAsarIntegrityValidation: 'disabled', OnlyLoadAppFromAsar: 'disabled' })
  })

  it('does not run JavaScript as Node.js with ELECTRON_RUN_AS_NODE', async () => {
    const marker = join(work, 'ran-as-node')
    const script = markerScript(marker)
    // Control: the stock binary does run it.
    const control = await run(electronBinary, ['-e', script], cleanEnv({ ELECTRON_RUN_AS_NODE: '1' }))
    expect(control.code).toBe(0)
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)
    // The packaged binary starts as Veydr instead (in smoke-test mode, so it exits by itself).
    const result = await run(unpackedBinary, ['-e', script, '--smoke-test'], cleanEnv({ ELECTRON_RUN_AS_NODE: '1' }))
    expect(existsSync(marker)).toBe(false)
    expect(smokeReportOf(result).packaged).toBe(true)
  })

  it('ignores NODE_OPTIONS and --inspect', async () => {
    const marker = join(work, 'node-options')
    const preload = join(work, 'preload.cjs')
    writeFileSync(preload, `${markerScript(marker).replace('process.exit(0);', '')}\n`)
    const nodeOptions = `--require ${JSON.stringify(preload)}`
    // Controls: the stock binary loads the preload from NODE_OPTIONS and honours --inspect.
    const control = await run(electronBinary, ['--inspect=0', '-e', 'setTimeout(() => {}, 200)'], cleanEnv({ ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: nodeOptions }))
    expect(existsSync(marker)).toBe(true)
    expect(control.stderr).toMatch(/Debugger listening/)
    rmSync(marker)
    const result = await run(unpackedBinary, ['--inspect=0', '--smoke-test'], cleanEnv({ NODE_OPTIONS: nodeOptions }))
    expect(smokeReportOf(result).result).toBe('pass')
    expect(existsSync(marker)).toBe(false)
    expect(result.stderr).not.toMatch(/Debugger listening/)
  })

  it('does not load application code from a resources\\app folder', async () => {
    const marker = join(work, 'loaded-app-folder')
    const appFolder = (dir: string): void => {
      mkdirSync(join(dir, 'app'))
      writeFileSync(join(dir, 'app', 'package.json'), JSON.stringify({ name: 'probe', main: 'main.js' }))
      writeFileSync(join(dir, 'app', 'main.js'), `${markerScript(marker)}\n`)
    }
    // Control: the stock binary loads the folder.
    const stock = copyOf(dirname(electronBinary), appFolder)
    await run(join(stock, basename(electronBinary)), [], cleanEnv(), { timeoutMs: 60_000, allowTimeout: true })
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)
    const packaged = copyOf(unpackedDir, appFolder)
    const result = await run(join(packaged, 'Veydr.exe'), ['--smoke-test'], cleanEnv(), { timeoutMs: 60_000, allowTimeout: true })
    expect(existsSync(marker)).toBe(false)
    expect(result.timedOut || result.code !== 0).toBe(true)
  })

  it('starts from an unmodified copy of the build (the control for the archive tests)', async () => {
    const result = await packagedRun(readFileSync(join(resourcesDir, 'app.asar')))
    expect(result.timedOut).toBe(false)
    expect(smokeReportOf(result).result).toBe('pass')
    expect(result.code).toBe(0)
  })

  it('[spec:desktop-shell/modified-archive-refused-on-windows] refuses to start with an archive whose index was changed, and the replaced code does not run', async () => {
    const marker = join(work, 'index-changed')
    const archive = archiveWithIndexChanged(marker)
    // Control: without integrity validation the replaced main bundle runs.
    expect(await stockRunsArchive(archive, marker)).toBe(true)
    const result = await packagedRun(archive)
    console.log(`archive with a changed index: exit ${String(result.code)}, timed out ${String(result.timedOut)}, marker ${String(existsSync(marker))}; stderr: ${result.stderr.slice(-500)}`)
    expect(existsSync(marker)).toBe(false)
    expect(started(result)).toBe(false)
    // Refused for the header hash, not for some other startup failure (CI run 43278811083).
    expect(result.timedOut).toBe(false)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/Integrity check failed for asar archive entry '<header>'/)
  })

  it('refuses to start with an archive whose file bytes alone changed, its index untouched, and the changed code does not run', async () => {
    const marker = join(work, 'bytes-changed')
    const archive = archiveWithBytesChanged(marker)
    // Control: without integrity validation the overwritten main bundle runs.
    expect(await stockRunsArchive(archive, marker)).toBe(true)
    const result = await packagedRun(archive)
    console.log(`archive with changed bytes and the same index: exit ${String(result.code)}, timed out ${String(result.timedOut)}, marker ${String(existsSync(marker))}; stderr: ${result.stderr.slice(-500)}`)
    // Measured in CI (task 2.4): besides the header hash embedded in Veydr.exe, Electron checks each
    // file it reads from the archive against the per-file hashes in the header, and exits with
    // "ASAR Integrity Violation: got a hash mismatch". Design D3 predicted the opposite; the docs
    // (tasks 6.1, 6.3) state the refusal, and the bytes-only limit is dropped.
    expect(existsSync(marker)).toBe(false)
    expect(started(result)).toBe(false)
    // Refused for the file's hash, not for some other startup failure (CI run 43278811083).
    expect(result.timedOut).toBe(false)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/ASAR Integrity Violation: got a hash mismatch/)
  })
})
