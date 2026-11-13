import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '../../src/main/platform/windows/protocol'
import { readAsar } from './asar'
import {
  builtHelper,
  cleanEnv,
  distDir,
  installerName,
  powershellJson,
  powershellPath,
  repoRoot,
  requirePackages,
  resourcesDir,
  run,
  unpackedBinary,
  unpackedDir,
  unpackedHelper,
  version,
} from './support'

// What `npm run dist:windows` puts in `dist\` and in the unpacked build (add-windows-packaging design
// D1, D2, D3; task 2.3). The installed files are checked again by installer.test.ts.

/** Strings only the network-probe test build (`out-probe/`) contains (as in test/packaging/). */
const PROBE_STRINGS = ['veydr-network-probe', '192.0.2.1', 'VEYDR_NET_PROBE', 'RTCPeerConnection']
/** The sizes build/windows/icon.ico holds (scripts/windows-icon.mjs). */
const ICON_SIZES = [16, 32, 48, 64, 128, 256]
/** Update metadata electron-builder writes when a publish target is configured, or differential packages. */
const UPDATE_METADATA = /(?:^app-update\.yml$|^latest[\w-]*\.yml$|\.blockmap$)/i

const electronBinary = createRequire(__filename)('electron') as string

function filesBelow(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

describe.skipIf(process.platform !== 'win32')('[windows-only: the Windows package] package contents', () => {
  beforeAll(() => requirePackages())

  it('[spec:desktop-shell/helper-outside-the-archive] places the helper beside app.asar, and the archive holds no .exe, .dll or .node', () => {
    expect(readdirSync(resourcesDir).sort()).toEqual(['app.asar', 'veydr-helper.exe'])
    // The helper is the one built from source in this run (design D2), not a stale or foreign file.
    expect(readFileSync(unpackedHelper).equals(readFileSync(builtHelper))).toBe(true)
    const asar = readAsar(join(resourcesDir, 'app.asar'))
    expect(asar.files.filter((f) => /\.(?:exe|dll|node)$/i.test(f))).toEqual([])
  })

  it('answers `version` from the packaged helper with the protocol version Veydr needs', async () => {
    const result = await run(unpackedHelper, ['version'], cleanEnv(), { timeoutMs: 30_000 })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(String(PROTOCOL_VERSION))
  })

  it('holds the same archive files as the Linux package: the production bundle, package.json, and zod', () => {
    const asar = readAsar(join(resourcesDir, 'app.asar'))
    const own = asar.files.filter((f) => !f.startsWith('/node_modules/zod/'))
    const renderer = own.filter((f) => f.startsWith('/out/renderer/'))
    const windowIcon = own.filter((f) => /^\/out\/main\/chunks\/256x256-[\w-]+\.png$/.test(f))
    expect(windowIcon).toHaveLength(1)
    expect(own.filter((f) => !f.startsWith('/out/renderer/') && !windowIcon.includes(f))).toEqual(['/out/main/index.js', '/out/preload/index.js', '/package.json'])
    expect(renderer).toContain('/out/renderer/index.html')
    expect(renderer.every((f) => /^\/out\/renderer\/(index\.html|assets\/[\w-]+\.(js|css))$/.test(f))).toBe(true)
    expect(asar.files.some((f) => f.startsWith('/node_modules/zod/'))).toBe(true)
    expect(asar.files.filter((f) => f.startsWith('/node_modules/') && !f.startsWith('/node_modules/zod/'))).toEqual([])
    expect(asar.files.filter((f) => /\.map$|^\/(src|docs|test|out-probe|out-helper|scripts)\//.test(f))).toEqual([])
  })

  it('contains the production main bundle, not the network-probe build', () => {
    const asar = readAsar(join(resourcesDir, 'app.asar'))
    const main = asar.read('/out/main/index.js').toString('utf8')
    expect(main).toEqual(readFileSync(join(repoRoot, 'out/main/index.js'), 'utf8'))
    for (const probe of PROBE_STRINGS) expect(main, probe).not.toContain(probe)
    expect(main).not.toContain('ELECTRON_RENDERER_URL')
    const packaged = JSON.parse(asar.read('/package.json').toString('utf8')) as Record<string, unknown>
    expect(packaged['main']).toBe('out/main/index.js')
    expect(packaged['version']).toBe(version)
  })

  it('[spec:desktop-shell/no-update-metadata] builds no .blockmap, latest.yml or app-update.yml, and the application holds none', () => {
    // dist\ holds exactly one installer, named from package.json's version (a prerelease in CI).
    const topLevel = readdirSync(distDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
    expect(topLevel.filter((name) => /\.exe$/i.test(name)), 'dist\\ holds another installer: remove dist\\ and run `npm run dist:windows` again').toEqual([installerName(version)])
    expect(filesBelow(distDir).filter((path) => UPDATE_METADATA.test(basename(path)))).toEqual([])
    // What the installer installs is the unpacked build.
    expect(filesBelow(unpackedDir).filter((path) => /\.yml$|\.blockmap$/i.test(path))).toEqual([])
  })

  it('signs nothing: Veydr.exe, the helper and the installer carry no Authenticode signature (design D8)', async () => {
    // electron-builder logs "signing with signtool.exe" for every executable, then skips signing when
    // it finds no certificate; this reads what the files actually carry.
    const status = (file: string): Promise<unknown> =>
      powershellJson('(Get-AuthenticodeSignature -LiteralPath $env:VEYDR_FILE).Status.ToString() | ConvertTo-Json -Compress', { VEYDR_FILE: file })
    for (const file of [unpackedBinary, unpackedHelper, join(distDir, installerName(version))]) expect(await status(file), file).toBe('NotSigned')
    // Control: a Microsoft-signed system binary reads as validly signed, so the check can tell the
    // two apart. (The stock electron.exe is itself unsigned: CI run 43276268013 read it as NotSigned.)
    expect(await status(powershellPath)).toBe('Valid')
  })

  it('carries the version and the Veydr icon in Veydr.exe', async () => {
    const info = (await powershellJson(
      '(Get-Item -LiteralPath $env:VEYDR_EXE).VersionInfo | Select-Object FileVersion, ProductName, FileDescription | ConvertTo-Json -Compress',
      { VEYDR_EXE: unpackedBinary },
    )) as { FileVersion: string; ProductName: string; FileDescription: string }
    // electron-builder writes package.json's version as the FileVersion string, prerelease included.
    expect(info).toEqual({ FileVersion: version, ProductName: 'Veydr', FileDescription: 'Veydr' })
    // The icon's PNG entries are stored as the executable's icon resources byte for byte.
    const exe = readFileSync(unpackedBinary)
    const stock = readFileSync(electronBinary)
    for (const size of ICON_SIZES) {
      const png = readFileSync(join(repoRoot, 'build/icons', `${size}x${size}.png`))
      expect(exe.includes(png), `${size} px`).toBe(true)
      // Control: the stock binary does not carry it, so the check is not trivially satisfied.
      expect(stock.includes(png), `${size} px in the stock binary`).toBe(false)
    }
  })

  it('carries the Veydr icon in the installer', () => {
    // makensis puts win.icon into the installer's own icon resources. The uninstaller is generated
    // inside the installer's compressed payload; its icon is checked on the installed copy (group 3).
    const installer = readFileSync(join(distDir, installerName(version)))
    for (const size of ICON_SIZES) {
      expect(installer.includes(readFileSync(join(repoRoot, 'build/icons', `${size}x${size}.png`))), `${size} px`).toBe(true)
    }
  })

  it('[spec:desktop-shell/silent-installation-as-a-standard-user] requests no elevation: the installer\'s manifest asks for asInvoker only', () => {
    // Windows shows a UAC prompt for an executable whose manifest requests requireAdministrator or
    // highestAvailable, or, with no requested level, one its installer detection takes for a setup
    // program (a name with "setup"). makensis writes RequestExecutionLevel into the manifest of the
    // installer's stub, in plain UTF-8; the payload, where Veydr.exe and the uninstaller are, is
    // compressed. So every requested level in the file is the installer's own. The standard user's
    // install (standard-user-install.test.ts) shows that it then runs unelevated; this shows why no
    // prompt is asked for, for the interactive installer too.
    const installer = readFileSync(join(distDir, installerName(version))).toString('latin1')
    const levels = [...installer.matchAll(/<requestedExecutionLevel\s[^>]*\blevel=["']([A-Za-z]+)["']/g)].map((m) => m[1])
    expect(levels.length, 'requestedExecutionLevel in the installer').toBeGreaterThan(0)
    expect(new Set(levels)).toEqual(new Set(['asInvoker']))
    expect(installer).not.toMatch(/<requestedExecutionLevel\s[^>]*\buiAccess=["']true["']/)
  })
})
