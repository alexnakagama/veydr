import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appImagePath, cleanEnv, debPath, repoRoot, requirePackages, run, unpackedDir } from './support'

interface AsarEntry {
  readonly files?: Record<string, AsarEntry>
  readonly size?: number
  readonly offset?: string
  readonly unpacked?: boolean
}

/** Reads an ASAR archive's header (https://github.com/electron/asar#format) and file contents. */
function readAsar(path: string): { files: string[]; read: (file: string) => Buffer } {
  const bytes = readFileSync(path)
  const headerSize = bytes.readUInt32LE(4)
  const jsonSize = bytes.readUInt32LE(12)
  const header = JSON.parse(bytes.subarray(16, 16 + jsonSize).toString('utf8')) as AsarEntry
  const base = 8 + headerSize
  const entries = new Map<string, AsarEntry>()
  const walk = (entry: AsarEntry, prefix: string): void => {
    for (const [name, child] of Object.entries(entry.files ?? {})) {
      const path = `${prefix}/${name}`
      if (child.files === undefined) entries.set(path, child)
      else walk(child, path)
    }
  }
  walk(header, '')
  return {
    files: [...entries.keys()].sort(),
    read(file) {
      const entry = entries.get(file)
      if (entry?.offset === undefined || entry.size === undefined) throw new Error(`${file} is not in the archive`)
      const start = base + Number(entry.offset)
      return bytes.subarray(start, start + entry.size)
    },
  }
}

function sh(command: string, args: readonly string[]): string {
  const out = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (out.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${out.stderr}`)
  return out.stdout
}

/** One file of the .deb's data archive. */
function debFile(path: string): string {
  return spawnSync('sh', ['-c', 'dpkg-deb --fsys-tarfile "$1" | tar -xO "$2"', 'sh', debPath, path], { encoding: 'utf8' }).stdout
}

/** Strings only the network-probe test build (`out-probe/`) contains. */
const PROBE_STRINGS = ['veydr-network-probe', '192.0.2.1', 'VEYDR_NET_PROBE', 'RTCPeerConnection']

let work: string
beforeAll(() => {
  requirePackages()
  work = mkdtempSync(join(tmpdir(), 'veydr-contents-'))
})
afterAll(() => rmSync(work, { recursive: true, force: true }))

describe('application archive (task 9.1)', () => {
  it('holds only the production bundle, package.json, and zod', () => {
    const asar = readAsar(join(unpackedDir, 'resources/app.asar'))
    const own = asar.files.filter((f) => !f.startsWith('/node_modules/zod/'))
    const renderer = own.filter((f) => f.startsWith('/out/renderer/'))
    expect(own.filter((f) => !f.startsWith('/out/renderer/'))).toEqual(['/out/main/index.js', '/out/preload/index.js', '/package.json'])
    expect(renderer).toContain('/out/renderer/index.html')
    expect(renderer.every((f) => /^\/out\/renderer\/(index\.html|assets\/[\w-]+\.(js|css))$/.test(f))).toBe(true)
    expect(asar.files.some((f) => f.startsWith('/node_modules/zod/'))).toBe(true)
    expect(asar.files.filter((f) => f.startsWith('/node_modules/') && !f.startsWith('/node_modules/zod/'))).toEqual([])
    // Built output only, no source maps, sources, docs, tests, or the probe build.
    expect(asar.files.filter((f) => /\.map$|^\/(src|docs|test|out-probe|scripts)\//.test(f))).toEqual([])
  })

  it('contains the production main bundle, not the network-probe build', () => {
    const asar = readAsar(join(unpackedDir, 'resources/app.asar'))
    const main = asar.read('/out/main/index.js').toString('utf8')
    expect(main).toEqual(readFileSync(join(repoRoot, 'out/main/index.js'), 'utf8'))
    for (const probe of PROBE_STRINGS) expect(main, probe).not.toContain(probe)
    // The dev-server override is compiled out of non-dev builds.
    expect(main).not.toContain('ELECTRON_RENDERER_URL')
    const packaged = JSON.parse(asar.read('/package.json').toString('utf8')) as Record<string, unknown>
    expect(packaged['main']).toBe('out/main/index.js')
    expect(packaged['desktopName']).toBe('veydr.desktop')
  })

  it('ships no update metadata (auto-update is a non-goal)', () => {
    expect(sh('ls', [join(unpackedDir, 'resources')]).trim().split('\n').sort()).toEqual(['app.asar', 'apparmor-profile'])
  })
})

describe('.deb package (tasks 9.1, 9.4)', () => {
  const contents = (): string[] => sh('dpkg-deb', ['-c', debPath]).split('\n')
  const entry = (path: string): string | undefined => contents().find((line) => line.endsWith(` ${path}`))

  it('installs to /opt/Veydr with a desktop entry that never disables the sandbox', () => {
    expect(entry('./opt/Veydr/veydr')).toMatch(/^-rwxr-xr-x 0\/0 /)
    expect(entry('./opt/Veydr/resources/app.asar')).toBeDefined()
    const desktop = debFile('./usr/share/applications/veydr.desktop')
    expect(desktop).toContain('Exec=/opt/Veydr/veydr %U')
    expect(desktop).toContain('StartupWMClass=veydr')
    expect(desktop).not.toContain('no-sandbox')
  })

  it('ships the AppArmor profile for /opt/Veydr/veydr and installs it where AppArmor supports it', () => {
    const profile = debFile('./opt/Veydr/resources/apparmor-profile')
    expect(profile).toContain('abi <abi/4.0>,')
    expect(profile).toContain('profile veydr /opt/Veydr/veydr flags=(unconfined) {')
    expect(profile).toMatch(/^\s*userns,$/m)
    expect(profile).not.toContain('${')
    const control = join(work, 'control')
    sh('dpkg-deb', ['-e', debPath, control])
    const postinst = readFileSync(join(control, 'postinst'), 'utf8')
    expect(postinst).toContain("APPARMOR_PROFILE_SOURCE='/opt/Veydr/resources/apparmor-profile'")
    expect(postinst).toContain("APPARMOR_PROFILE_TARGET='/etc/apparmor.d/veydr'")
    expect(postinst).toContain('apparmor_parser --replace')
    expect(readFileSync(join(control, 'postrm'), 'utf8')).toContain('apparmor_parser --remove')
  })

  it('sets chrome-sandbox setuid only where user namespaces are unavailable', () => {
    // Shipped 0755; the post-install script decides.
    expect(entry('./opt/Veydr/chrome-sandbox')).toMatch(/^-rwxr-xr-x 0\/0 /)
    const control = join(work, 'control-sandbox')
    sh('dpkg-deb', ['-e', debPath, control])
    const postinst = readFileSync(join(control, 'postinst'), 'utf8')
    expect(postinst).toContain("chmod 4755 '/opt/Veydr/chrome-sandbox'")
    expect(postinst).toContain("chmod 0755 '/opt/Veydr/chrome-sandbox'")
  })

  it('depends on a package for every library the packaged binaries link against', () => {
    // Library (readelf NEEDED) -> Debian/Ubuntu package providing it (64-bit time_t name first).
    const providers: Record<string, string> = {
      'ld-linux-x86-64.so.2': 'libc6',
      'libc.so.6': 'libc6',
      'libdl.so.2': 'libc6',
      'libm.so.6': 'libc6',
      'libpthread.so.0': 'libc6',
      'libasound.so.2': 'libasound2t64 | libasound2',
      'libatk-1.0.so.0': 'libatk1.0-0t64 | libatk1.0-0',
      'libatk-bridge-2.0.so.0': 'libatk-bridge2.0-0t64 | libatk-bridge2.0-0',
      'libatspi.so.0': 'libatspi2.0-0t64 | libatspi2.0-0',
      'libcairo.so.2': 'libcairo2',
      'libcups.so.2': 'libcups2t64 | libcups2',
      'libdbus-1.so.3': 'libdbus-1-3',
      'libexpat.so.1': 'libexpat1',
      'libgbm.so.1': 'libgbm1',
      'libgcc_s.so.1': 'libgcc-s1',
      'libgio-2.0.so.0': 'libglib2.0-0t64 | libglib2.0-0',
      'libglib-2.0.so.0': 'libglib2.0-0t64 | libglib2.0-0',
      'libgobject-2.0.so.0': 'libglib2.0-0t64 | libglib2.0-0',
      'libgtk-3.so.0': 'libgtk-3-0t64 | libgtk-3-0',
      'libnspr4.so': 'libnspr4',
      'libnss3.so': 'libnss3',
      'libnssutil3.so': 'libnss3',
      'libsmime3.so': 'libnss3',
      'libpango-1.0.so.0': 'libpango-1.0-0',
      'libudev.so.1': 'libudev1',
      'libX11.so.6': 'libx11-6',
      'libxcb.so.1': 'libxcb1',
      'libXcomposite.so.1': 'libxcomposite1',
      'libXdamage.so.1': 'libxdamage1',
      'libXext.so.6': 'libxext6',
      'libXfixes.so.3': 'libxfixes3',
      'libxkbcommon.so.0': 'libxkbcommon0',
      'libXrandr.so.2': 'libxrandr2',
    }
    const bundled = new Set(sh('ls', [unpackedDir]).trim().split('\n'))
    const needed = new Set<string>()
    for (const file of ['veydr', 'chrome_crashpad_handler', 'chrome-sandbox', 'libffmpeg.so', 'libvk_swiftshader.so', 'libvulkan.so.1']) {
      for (const match of sh('readelf', ['-d', join(unpackedDir, file)]).matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/g)) {
        if (!bundled.has(match[1] ?? '')) needed.add(match[1] ?? '')
      }
    }
    // A library missing from the map is new (e.g. after an Electron upgrade): add it to deb.depends.
    expect([...needed].filter((lib) => !(lib in providers)).sort()).toEqual([])
    const depends = (/^Depends: (.*)$/m.exec(sh('dpkg-deb', ['-f', debPath]))?.[1] ?? '').split(', ')
    for (const lib of needed) expect(depends, lib).toContain(providers[lib])
  })

  it('is the amd64 package "veydr" without update metadata', () => {
    const info = sh('dpkg-deb', ['-f', debPath])
    expect(info).toMatch(/^Package: veydr$/m)
    expect(info).toMatch(/^Architecture: amd64$/m)
    expect(contents().some((line) => /app-update\.yml|latest-linux\.yml/.test(line))).toBe(false)
  })
})

describe('AppImage (tasks 9.1, 9.3, 9.4)', () => {
  let extracted: string
  beforeAll(async () => {
    extracted = mkdtempSync(join(tmpdir(), 'veydr-appimage-'))
    const result = await run(appImagePath, ['--appimage-extract'], cleanEnv(), 120_000, extracted)
    expect(result.code).toBe(0)
  })
  afterAll(() => rmSync(extracted, { recursive: true, force: true }))

  it('has a desktop entry without --no-sandbox', () => {
    const desktop = readFileSync(join(extracted, 'squashfs-root/veydr.desktop'), 'utf8')
    expect(desktop).toMatch(/^Exec=AppRun %U$/m)
    expect(desktop).not.toContain('no-sandbox')
  })

  it('has the launcher behavior Veydr compensates for: --no-sandbox without user namespaces, and its own path entries', () => {
    // Veydr refuses --no-sandbox (src/main/index.ts) and removes these entries from commands'
    // environments (src/main/platform/runtime-env.ts). If electron-builder changes AppRun, revisit both.
    const appRun = readFileSync(join(extracted, 'squashfs-root/AppRun'), 'utf8')
    expect(appRun).toContain('NO_SANDBOX=(--no-sandbox)')
    expect(appRun).toContain('export PATH="${APPDIR}:${APPDIR}/usr/sbin${PATH:+:${PATH}}"')
    expect(appRun).toContain('export XDG_DATA_DIRS="${APPDIR}/usr/share/${XDG_DATA_DIRS:+:${XDG_DATA_DIRS}}:/usr/share/gnome:/usr/local/share/:/usr/share/"')
    expect(appRun).toContain('export LD_LIBRARY_PATH="${APPDIR}/usr/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"')
    expect(appRun).toContain('export GSETTINGS_SCHEMA_DIR="${APPDIR}/usr/share/glib-2.0/schemas${GSETTINGS_SCHEMA_DIR:+:${GSETTINGS_SCHEMA_DIR}}"')
    expect(appRun.match(/^export /gm)).toHaveLength(4)
  })

  it('contains the same application archive as the unpacked build', () => {
    expect(readFileSync(join(extracted, 'squashfs-root/resources/app.asar')).equals(readFileSync(join(unpackedDir, 'resources/app.asar')))).toBe(true)
  })
})
