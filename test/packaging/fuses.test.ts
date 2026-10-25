import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cleanEnv, distDir, requirePackages, run, smokeReportOf, unpackedBinary, unpackedDir } from './support'

const electronBinary = createRequire(__filename)('electron') as string

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

let work: string
beforeAll(() => {
  requirePackages()
  work = mkdtempSync(join(tmpdir(), 'veydr-fuses-'))
})
afterAll(() => rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

describe('packaged binary fuses (design D2, task 9.1)', () => {
  it('has the fuses of design D2 set in dist/linux-unpacked/veydr', () => {
    const fuses = readFuses(unpackedBinary)
    expect(fuses).toMatchObject({
      RunAsNode: 'disabled',
      EnableCookieEncryption: 'enabled',
      EnableNodeOptionsEnvironmentVariable: 'disabled',
      EnableNodeCliInspectArguments: 'disabled',
      EnableEmbeddedAsarIntegrityValidation: 'enabled',
      OnlyLoadAppFromAsar: 'enabled',
    })
    // The reader is not trivially satisfied: the stock Electron binary has the defaults.
    expect(readFuses(electronBinary)).toMatchObject({ RunAsNode: 'enabled', EnableNodeOptionsEnvironmentVariable: 'enabled', OnlyLoadAppFromAsar: 'disabled' })
  })

  it('[spec:desktop-shell/run-as-node-disabled] does not run JavaScript as Node.js with ELECTRON_RUN_AS_NODE', async () => {
    const marker = join(work, 'ran-as-node')
    const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`
    // Control: the stock binary does run it.
    const control = await run(electronBinary, ['-e', script], cleanEnv({ ELECTRON_RUN_AS_NODE: '1' }))
    expect(control.code).toBe(0)
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)
    // The packaged binary starts as Veydr instead (in smoke-test mode, so it exits by itself).
    const result = await run(unpackedBinary, ['-e', script, '--smoke-test'], cleanEnv({ ELECTRON_RUN_AS_NODE: '1', XDG_CONFIG_HOME: join(work, 'config-run-as-node') }))
    expect(existsSync(marker)).toBe(false)
    expect(smokeReportOf(result).packaged).toBe(true)
  })

  it('ignores NODE_OPTIONS and --inspect', async () => {
    const marker = join(work, 'node-options')
    const preload = join(work, 'preload.cjs')
    writeFileSync(preload, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')\n`)
    const result = await run(
      unpackedBinary,
      ['--inspect=0', '--smoke-test'],
      cleanEnv({ NODE_OPTIONS: `--require ${preload}`, XDG_CONFIG_HOME: join(work, 'config-node-options') }),
    )
    expect(smokeReportOf(result).result).toBe('pass')
    expect(existsSync(marker)).toBe(false)
    expect(result.stderr).not.toMatch(/Debugger listening/)
  })

  it('does not load application code from outside app.asar', async () => {
    const marker = join(work, 'loaded-app-folder')
    const withAppFolder = (from: string): string => {
      // A copy of the package (hard links, same file system) whose resources hold an `app` folder only.
      const copy = mkdtempSync(join(distDir, '.fuse-probe-'))
      linkTree(from, copy, (name) => name !== 'resources')
      mkdirSync(join(copy, 'resources/app'), { recursive: true })
      writeFileSync(join(copy, 'resources/app/package.json'), JSON.stringify({ name: 'probe', main: 'main.js' }))
      writeFileSync(join(copy, 'resources/app/main.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(0)\n`)
      return copy
    }
    const stock = withAppFolder(dirname(electronBinary))
    const packaged = withAppFolder(unpackedDir)
    try {
      // Control: the stock binary loads the folder.
      await run(join(stock, 'electron'), [], cleanEnv({ XDG_CONFIG_HOME: join(work, 'config-app-folder-stock') }), 30_000)
      expect(existsSync(marker)).toBe(true)
      rmSync(marker)
      const result = await run(join(packaged, 'veydr'), ['--smoke-test'], cleanEnv({ XDG_CONFIG_HOME: join(work, 'config-app-folder') }), 30_000)
      expect(existsSync(marker)).toBe(false)
      expect(result.code).not.toBe(0)
    } finally {
      rmSync(stock, { recursive: true, force: true })
      rmSync(packaged, { recursive: true, force: true })
    }
  })

  it('known limitation: a modified app.asar still loads, because Electron validates ASAR integrity only on macOS and Windows', async () => {
    const copy = mkdtempSync(join(distDir, '.asar-probe-'))
    try {
      linkTree(unpackedDir, copy, (name) => name !== 'resources')
      mkdirSync(join(copy, 'resources'))
      const asar = readFileSync(join(unpackedDir, 'resources/app.asar'))
      const title = asar.indexOf('<title>Veydr</title>')
      expect(title).toBeGreaterThan(0)
      asar.write('<title>Tampr</title>', title)
      writeFileSync(join(copy, 'resources/app.asar'), asar)
      const result = await run(join(copy, 'veydr'), ['--smoke-test'], cleanEnv({ XDG_CONFIG_HOME: join(work, 'config-tampered') }))
      // If this starts failing, Electron validates the archive on Linux too: update docs/security-baseline.md.
      expect(smokeReportOf(result).result).toBe('pass')
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })
})
