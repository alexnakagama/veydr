import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { aclViolations } from '../../scripts/windows-probe/install-acl.mjs'
import { controlOutcome, WINDOWS_STEPS } from '../../scripts/windows-probe/installer-standard-user.mjs'
import { createWindowsPlatform } from '../../src/main/platform/windows'
import { createPortService } from '../../src/main/ports/service'
import { createPlanner } from '../../src/main/supervisor/plan'
import { createProcessStateRegistry } from '../../src/main/supervisor/state'
import { createSupervisor, type LaunchTarget } from '../../src/main/supervisor/supervisor'
import type { CommandConfig } from '../../src/shared/config'
import { fixture, readLedger, scenario, sleep, TAG_VARIABLE, waitUntil, type Scenario } from '../support/proc'
import { taggedProcesses } from '../support/processes'
import { command, project, quietLog } from '../unit/support/config'
import {
  ALL_SMOKE_CHECKS,
  cleanEnv,
  installerPath,
  powershellJson,
  powershellPath,
  readAcls,
  recordedStep,
  repoRoot,
  recordStep,
  requirePackages,
  resourcesDir,
  run,
  sha256File,
  smokeReportOf,
  unpackedBinary,
  unpackedHelper,
  version,
} from './support'

// The installer run as the runner's administrator, a per-user install into the runner's real
// profile (add-windows-packaging design D3, D4; tasks 3.2–3.5). It changes the profile, so it runs
// only in CI, on a VM that is discarded, and refuses to start over an existing installation. Every
// step is appended to the install record (test-results/windows-install/steps.jsonl). The tests run
// in order and build on each other: install, inspect, run, reinstall, uninstall.

/** Set by GitHub Actions; the suite installs into the real profile only there. */
const notCi = process.env['CI'] !== 'true'

/** electron-builder's limits for a silent install or uninstall (as the W0 probe measured them). */
const INSTALL_MS = 180_000
/** The uninstaller copies itself to a temporary file and returns; the directory goes after that. */
const UNINSTALL_GONE_MS = 120_000
/** How long the Start menu entry is held open at the start of the uninstall: less than the 10 s build/windows/installer.nsh retries for. */
const HOLD_LINK_MS = 5_000
const SMOKE_MS = 120_000
/** How long a process the silent install might have started is looked for. */
const NO_PROCESS_WATCH_MS = 5_000

/** Files of Veydr's own in its configuration directory: the configuration, its copies, the run ledger, a smoke-test probe. */
const VEYDR_OWNED = /^(?:config\b|runtime$|\.smoke-test-)/i
/** The smoke report's `platform` detail when listening sockets were read through the helper. */
const PLATFORM_DETAIL = /^windows: \d+ environment variables(?: \([^)]*\))?, \d+ listening sockets readable$/
/** The PNGs build/windows/icon.ico holds (scripts/windows-icon.mjs). */
const ICON_SIZES = [16, 32, 48, 64, 128, 256]

/** Windows paths compare without case. */
const samePath = (a: string, b: string): boolean => win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase()
const isBelow = (path: string, dir: string): boolean => win32.resolve(path).toLowerCase().startsWith(`${win32.resolve(dir).toLowerCase()}\\`)

interface Shortcut {
  readonly folder: string
  readonly path: string
  readonly target: string
}
interface RegistryValue {
  readonly key: string
  readonly name: string
  readonly data: string
}
interface UninstallEntry {
  readonly key: string
  readonly displayName: string
  readonly displayVersion: string
  readonly uninstallString: string
  readonly quietUninstallString: string
  readonly installLocation: string
}
interface InstallState {
  /** `Veydr.lnk` in the user's Start menu Programs folder, with its target, or null. */
  readonly startMenu: Shortcut | null
  /** Every `.lnk` directly in the desktops and Startup folders, the user's and the machine's. */
  readonly shortcuts: readonly Shortcut[]
  /** Every value of the Run and RunOnce keys, the user's and the machine's (64- and 32-bit views). */
  readonly logon: readonly RegistryValue[]
  readonly uninstallUser: readonly UninstallEntry[]
  readonly uninstallMachine: readonly UninstallEntry[]
  readonly processes: readonly { readonly pid: number; readonly path: string | null }[]
}

/**
 * What an install leaves outside its directory, read in one Windows PowerShell 5.1 run. Everything is
 * listed; the tests decide what names Veydr. Folders come from the shell's own known-folder lookup.
 */
const INSPECT_SCRIPT = `
Remove-TypeData -TypeName System.Array -ErrorAction SilentlyContinue
$shell = New-Object -ComObject WScript.Shell
function Shortcut($folder, $path) {
  [pscustomobject]@{ folder = $folder; path = $path; target = [string]$shell.CreateShortcut($path).TargetPath }
}
function Links($folder) {
  $dir = [Environment]::GetFolderPath($folder)
  if ($dir -eq '' -or -not (Test-Path -LiteralPath $dir -PathType Container)) { return }
  foreach ($item in Get-ChildItem -LiteralPath $dir -Filter *.lnk -File -Force) { Shortcut $folder $item.FullName }
}
function Values($path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  $key = Get-Item -LiteralPath $path
  foreach ($name in $key.GetValueNames()) {
    [pscustomobject]@{ key = $path; name = $name; data = [string]$key.GetValue($name, $null, 'DoNotExpandEnvironmentNames') }
  }
}
function Entries($path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  foreach ($sub in Get-ChildItem -LiteralPath $path) {
    [pscustomobject]@{
      key = $sub.Name
      displayName = [string]$sub.GetValue('DisplayName')
      displayVersion = [string]$sub.GetValue('DisplayVersion')
      uninstallString = [string]$sub.GetValue('UninstallString')
      quietUninstallString = [string]$sub.GetValue('QuietUninstallString')
      installLocation = [string]$sub.GetValue('InstallLocation')
    }
  }
}
$startMenuPath = Join-Path ([Environment]::GetFolderPath('Programs')) 'Veydr.lnk'
$run = 'Software\\Microsoft\\Windows\\CurrentVersion'
$wow = 'Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion'
$state = [pscustomobject]@{
  startMenu = $(if (Test-Path -LiteralPath $startMenuPath -PathType Leaf) { Shortcut 'Programs' $startMenuPath } else { $null })
  shortcuts = @(foreach ($folder in 'Desktop', 'CommonDesktopDirectory', 'Startup', 'CommonStartup') { Links $folder })
  logon = @(foreach ($key in "HKCU:\\$run\\Run", "HKCU:\\$run\\RunOnce", "HKLM:\\$run\\Run", "HKLM:\\$run\\RunOnce", "HKLM:\\$wow\\Run", "HKLM:\\$wow\\RunOnce") { Values $key })
  uninstallUser = @(Entries "HKCU:\\$run\\Uninstall")
  uninstallMachine = @(foreach ($key in "HKLM:\\$run\\Uninstall", "HKLM:\\$wow\\Uninstall") { Entries $key })
  processes = @(Get-Process -Name Veydr -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ pid = $_.Id; path = $_.Path } })
}
ConvertTo-Json -InputObject $state -Depth 6 -Compress
`

const inspect = async (): Promise<InstallState> => (await powershellJson(INSPECT_SCRIPT)) as InstallState

/** The uninstall entries of Veydr: named so, or pointing into the install directory. */
const veydrEntries = (entries: readonly UninstallEntry[], installDir: string): UninstallEntry[] =>
  entries.filter((e) => /^veydr\b/i.test(e.displayName) || [e.uninstallString, e.quietUninstallString, e.installLocation].some((s) => s.toLowerCase().includes(installDir.toLowerCase())))

const namesVeydr = (...texts: readonly string[]): boolean => texts.some((text) => /veydr/i.test(text))

const signatureStatus = async (file: string): Promise<unknown> =>
  powershellJson('(Get-AuthenticodeSignature -LiteralPath $env:VEYDR_FILE).Status.ToString() | ConvertTo-Json -Compress', { VEYDR_FILE: file })

describe.skipIf(process.platform !== 'win32')('[windows-only: the Windows installer] installation as the administrator', () => {
  const localAppData = process.env['LOCALAPPDATA'] ?? ''
  const appData = process.env['APPDATA'] ?? ''
  /** electron-builder names it after package.json's `name` (design D1; measured in W0). */
  const installDir = join(localAppData, 'Programs', 'veydr')
  const installedExe = join(installDir, 'Veydr.exe')
  const uninstaller = join(installDir, 'Uninstall Veydr.exe')
  const installedAsar = join(installDir, 'resources', 'app.asar')
  const installedHelper = join(installDir, 'resources', 'veydr-helper.exe')
  /** `app.getPath('userData')` on Windows. */
  const configDir = join(appData, 'Veydr')

  /** Set once this suite ran the installer, so afterAll never removes an installation it did not make. */
  let installerRan = false
  let marker: string | null = null
  const scenarios: Scenario[] = []

  const veydrOwned = (): string[] => (existsSync(configDir) ? readdirSync(configDir).filter((name) => VEYDR_OWNED.test(name)).sort() : [])

  /** What is left of the installation: the directory, the Start menu entry, the uninstall entry. */
  const leftovers = (state: InstallState): string[] => [
    ...(existsSync(installDir) ? [`the directory ${installDir}`] : []),
    ...(state.startMenu === null ? [] : [`the Start menu entry ${state.startMenu.path}`]),
    ...veydrEntries(state.uninstallUser, installDir).map((e) => `the uninstall entry ${e.key}`),
  ]

  /** Waits up to UNINSTALL_GONE_MS for nothing to be left; returns what is still there. */
  async function waitUntilUninstalled(): Promise<string[]> {
    const deadline = Date.now() + UNINSTALL_GONE_MS
    for (;;) {
      const left = leftovers(await inspect())
      if (left.length === 0 || Date.now() > deadline) return left
      await sleep(1_000)
    }
  }

  /**
   * Opens `file` for reading without delete sharing, as a virus scanner or the search indexer may,
   * and keeps it open for `ms`. Resolves once the file is open; `closed` resolves with the exit code.
   * While it is open, a Delete of the file fails with a sharing violation.
   */
  function holdOpen(file: string, ms: number): Promise<{ closed: Promise<number | null> }> {
    const script = "$f = [IO.File]::Open($env:VEYDR_HOLD_FILE, 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Milliseconds ([int]$env:VEYDR_HOLD_MS); $f.Close()"
    const child = spawn(powershellPath, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...cleanEnv(), VEYDR_HOLD_FILE: file, VEYDR_HOLD_MS: String(ms) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const closed = new Promise<number | null>((resolveClosed) => child.on('close', (code) => resolveClosed(code)))
    return new Promise((resolveHeld, reject) => {
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString()
        if (out.includes('held')) resolveHeld({ closed })
      })
      child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()))
      void closed.then((code) => reject(new Error(`could not hold ${file} open (exit ${String(code)}): ${err.trim()}`)))
    })
  }

  /** Runs the installed app's `--smoke-test` and checks its report; returns what the record keeps. */
  async function smokeInstalled(): Promise<Record<string, unknown>> {
    const before = veydrOwned()
    const result = await run(installedExe, ['--smoke-test'], cleanEnv(), { timeoutMs: SMOKE_MS })
    const report = smokeReportOf(result)
    expect(report.checks.filter((c) => !c.ok)).toEqual([])
    expect(report.checks.map((c) => c.name)).toEqual(ALL_SMOKE_CHECKS)
    expect(report).toMatchObject({ result: 'pass', packaged: true })
    // The UI was loaded from the installed archive, not from dist\.
    expect(samePath(report.appPath, installedAsar), report.appPath).toBe(true)
    const platform = report.checks.find((c) => c.name === 'platform')?.detail ?? ''
    expect(platform).toMatch(PLATFORM_DETAIL)
    // The configuration directory it probed is the user's %APPDATA%\Veydr.
    const probed = report.checks.find((c) => c.name === 'config-dir-writable')?.detail ?? ''
    expect(samePath(probed, configDir), probed).toBe(true)
    expect(result.code).toBe(0)
    // Of Veydr's own files only the probe was written, and it was removed again: no configuration,
    // no run ledger. (Chromium keeps its profile in the same directory, as on Linux.)
    expect(veydrOwned()).toEqual(before)
    return { appPath: report.appPath, platform, configDir: probed }
  }

  beforeAll(() => {
    if (notCi) return
    for (const [name, value] of [['LOCALAPPDATA', localAppData], ['APPDATA', appData]] as const) {
      if (!win32.isAbsolute(value)) throw new Error(`${name} is not an absolute path: ${JSON.stringify(value)}`)
    }
    // Never install over, or later uninstall, an installation this suite did not make.
    if (existsSync(installDir)) throw new Error(`${installDir} exists: the installer tests run only on a fresh CI machine, and refuse to start over an existing installation`)
    requirePackages()
  })

  afterAll(async () => {
    for (const s of scenarios.splice(0)) s.cleanup()
    if (marker !== null) rmSync(marker, { force: true })
    if (!installerRan || !existsSync(installDir)) return
    // A test failed before the uninstall test removed the installation: remove it here, and record
    // whether the machine was restored. Only warns: the failed test already fails the run.
    let ok = false
    let detail: unknown
    try {
      if (existsSync(uninstaller)) await run(uninstaller, ['/S'], cleanEnv(), { timeoutMs: INSTALL_MS })
      const left = await waitUntilUninstalled()
      ok = left.length === 0
      detail = { left }
      if (!ok) console.warn(`afterAll: still there after the uninstall: ${left.join('; ')}`)
    } catch (error) {
      detail = { error: error instanceof Error ? error.message : String(error) }
      console.warn(`afterAll: the uninstall failed: ${String((detail as { error: string }).error)}`)
    }
    try {
      recordStep('administrator/cleanup', ok, detail)
    } catch (error) {
      console.warn(`afterAll: could not record the cleanup: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  it.skipIf(notCi)('installs silently (/S) with exit code 0 into %LOCALAPPDATA%\\Programs\\veydr', async () => {
    await recordedStep('administrator/install', async () => {
      installerRan = true
      const started = Date.now()
      const result = await run(installerPath, ['/S'], cleanEnv(), { timeoutMs: INSTALL_MS })
      expect(result.code, result.stderr).toBe(0)
      expect(existsSync(installDir), installDir).toBe(true)
      return { installDir, code: result.code, ms: Date.now() - started }
    })
  })

  it.skipIf(notCi)('installs Veydr.exe, one uninstaller, app.asar and the helper, as the build produced them, with no update metadata', async () => {
    await recordedStep('administrator/installed-files', async () => {
      const programs = readdirSync(installDir).filter((name) => /\.exe$/i.test(name)).sort()
      expect(programs).toEqual(['Uninstall Veydr.exe', 'Veydr.exe'])
      expect(readdirSync(join(installDir, 'resources')).sort()).toEqual(['app.asar', 'veydr-helper.exe'])
      // What was installed is what dist\win-unpacked holds, which the package tests checked.
      for (const [installed, built] of [[installedExe, unpackedBinary], [installedAsar, join(resourcesDir, 'app.asar')], [installedHelper, unpackedHelper]] as const) {
        expect(await sha256File(installed), installed).toBe(await sha256File(built))
      }
      const metadata = readdirSync(installDir, { recursive: true, encoding: 'utf8' }).filter((path) => /(?:^|\\)(?:app-update\.yml|latest[\w-]*\.yml)$|\.blockmap$/i.test(path))
      expect(metadata).toEqual([])
      // The uninstaller is generated inside the installer's payload, so it is checked here (design D8).
      expect(await signatureStatus(uninstaller)).toBe('NotSigned')
      const bytes = readFileSync(uninstaller)
      const root = join(__dirname, '../..')
      for (const size of ICON_SIZES) expect(bytes.includes(readFileSync(join(root, 'build/icons', `${size}x${size}.png`))), `${size} px icon in the uninstaller`).toBe(true)
      return { programs, uninstaller: 'NotSigned' }
    })
  })

  it.skipIf(notCi)('adds the Start menu entry Veydr.lnk and one uninstall entry under HKCU, nothing under HKLM, and no desktop shortcut', async () => {
    await recordedStep('administrator/entries', async () => {
      const state = await inspect()
      expect(state.startMenu, 'Start menu entry').not.toBeNull()
      expect(samePath(state.startMenu?.target ?? '', installedExe), state.startMenu?.target).toBe(true)
      const entries = veydrEntries(state.uninstallUser, installDir)
      expect(entries).toHaveLength(1)
      const entry = entries[0] as UninstallEntry
      expect(entry.displayVersion).toBe(version)
      expect(entry.uninstallString.toLowerCase()).toContain(uninstaller.toLowerCase())
      // Per-user: nothing was written for the whole machine.
      expect(veydrEntries(state.uninstallMachine, installDir)).toEqual([])
      const desktop = state.shortcuts.filter((s) => /Desktop/.test(s.folder) && namesVeydr(s.path, s.target))
      expect(desktop).toEqual([])
      return { startMenu: state.startMenu, uninstallEntry: entry.key, displayName: entry.displayName }
    })
  })

  it.skipIf(notCi)('[spec:desktop-shell/no-start-at-logon] leaves no Run or RunOnce value and no Startup shortcut for Veydr', async () => {
    await recordedStep('administrator/no-start-at-logon', async () => {
      const state = await inspect()
      expect(state.logon.filter((v) => namesVeydr(v.name, v.data))).toEqual([])
      expect(state.shortcuts.filter((s) => /Startup/.test(s.folder) && namesVeydr(s.path, s.target))).toEqual([])
      return { logonValues: state.logon.length, startupShortcuts: state.shortcuts.filter((s) => /Startup/.test(s.folder)).length }
    })
  })

  it.skipIf(notCi)('leaves no Veydr.exe running after the silent install', async () => {
    await recordedStep('administrator/no-process', async () => {
      const deadline = Date.now() + NO_PROCESS_WATCH_MS
      for (;;) {
        // A Veydr.exe whose path cannot be read is counted: it could be the installed one.
        const started = (await inspect()).processes.filter((p) => p.path === null || isBelow(p.path, installDir))
        expect(started).toEqual([])
        if (Date.now() > deadline) break
        await sleep(1_000)
      }
      return null
    })
  })

  it.skipIf(notCi)('[spec:desktop-shell/installed-application-passes-its-self-check] the installed application passes all seven smoke checks, the platform check included, and writes no configuration', async () => {
    await recordedStep('administrator/smoke', smokeInstalled)
  })

  // The control of the standard user's smoke step (design D5), run where windows are known to work:
  // the standard user's smoke step may be "not testable" only if this step passed, so a control that
  // is itself broken can never excuse a failed smoke test (standardUserStepPassed).
  it.skipIf(notCi)('the stock Electron binary opens a hidden window for the administrator, the control the standard user\'s smoke step relies on', async () => {
    await recordedStep('administrator/stock-window', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'veydr-stock-window-'))
      try {
        const control = await WINDOWS_STEPS.control(join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe'), dir)
        expect(controlOutcome(control), JSON.stringify({ ...control.window, version: control.version.stdout })).toBe('opened')
        expect(control.version.code).toBe(0)
        return { version: control.version.stdout.trim(), windowCode: control.window.code }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  it.skipIf(notCi)('[spec:desktop-shell/command-started-through-the-installed-helper] starts a command tree through the installed helper, lists its listener as the command\'s, and ends the tree', async () => {
    await recordedStep('administrator/helper-command', async () => {
      const s = scenario()
      scenarios.push(s)
      // The product's own Windows platform, given the installed helper (design D2, D3).
      const platform = createWindowsPlatform({ helperPath: installedHelper, log: quietLog() })
      // The command (Node) starts a child, which listens (test/fixtures/proc/listen.mjs --depth 1).
      const config: CommandConfig = command({
        stopTimeoutMs: 5_000,
        execution: { mode: 'direct', file: process.execPath, args: [fixture('listen'), '--ledger', s.ledger, '--depth', '1'] },
        env: [{ key: TAG_VARIABLE, value: s.tag, secret: false }],
      })
      const target: LaunchTarget = { project: project({ path: s.dir, commands: [config] }), command: config }
      const supervisor = createSupervisor({
        processTree: platform.processTree,
        states: createProcessStateRegistry(() => undefined),
        lookup: (id) => (id === config.id ? target : null),
        plan: createPlanner({ resolver: platform.commandResolver, environment: platform.envProvider, envNames: platform.conventions.envNames }),
        log: quietLog(),
      })
      const ports = createPortService({ inspector: platform.portInspector, attribution: () => supervisor.attribution() })

      const state = await supervisor.start(config.id)
      expect(state, JSON.stringify(state.error)).toMatchObject({ status: 'running' })
      await waitUntil(() => readLedger(s.ledger).some((e) => e.role === 'listener'), `the listener in ${s.ledger}`, 30_000)
      const ledger = readLedger(s.ledger)
      const parent = ledger.find((e) => e.role === 'intermediate-1')
      const listener = ledger.find((e) => e.role === 'listener')
      if (parent === undefined || listener === undefined || typeof listener.port !== 'number') throw new Error(`unexpected ledger: ${JSON.stringify(ledger)}`)
      expect(parent.pid).toBe(state.pid)
      expect(listener.ppid).toBe(parent.pid)
      // Older than the helper's fence margin, so the listing attributes it (add-windows-port-inspection design D1).
      await sleep(100)

      const listed = (await ports.list()).ports.filter((p) => p.port === listener.port)
      expect(listed).toEqual([{ family: 'ipv4', address: '127.0.0.1', port: listener.port, owner: { kind: 'known', pid: listener.pid, name: expect.any(String) as string, commandId: config.id } }])
      // Both processes run, as read independently of Veydr.
      expect(taggedProcesses(s.tag).map((p) => p.pid).sort()).toEqual([parent.pid, listener.pid].sort())

      expect(await supervisor.stop(config.id)).toMatchObject({ status: 'exited', survivors: [] })
      expect(taggedProcesses(s.tag)).toEqual([])
      expect((await ports.list()).ports.filter((p) => p.port === listener.port)).toEqual([])
      return { command: parent.pid, child: listener.pid, port: listener.port }
    })
  })

  it.skipIf(notCi)('[spec:desktop-shell/install-directory-not-writable-by-others] grants write rights on the install directory, Veydr.exe, app.asar, the helper and every other installed file to no SID outside the allowed set', async () => {
    await recordedStep('administrator/permissions', async () => {
      const below = readdirSync(installDir, { recursive: true, encoding: 'utf8' }).map((path) => join(installDir, path))
      const paths = [installDir, ...below]
      for (const required of [installedExe, installedAsar, installedHelper]) expect(paths, required).toContain(required)
      const report = await readAcls(paths)
      expect(report.paths.map((p) => p.path)).toEqual(paths)
      const violations = aclViolations(report)
      // The lists of the four named paths, by SID, are recorded below group 3 of tasks.md.
      const observed = report.paths
        .filter((p) => [installDir, installedExe, installedAsar, installedHelper].some((named) => samePath(named, p.path)))
        .map((p) => ({ path: p.path, owner: p.owner, access: p.access.map((a) => `${String(a.sid)} ${a.type} 0x${a.rights.toString(16)}${a.inherited === true ? ' inherited' : ''}`) }))
      console.log(`install directory ACLs (user ${report.user}): ${JSON.stringify(observed)}`)
      expect(violations).toEqual([])
      return { user: report.user, checked: paths.length, observed }
    })
  })

  it.skipIf(notCi)('[spec:desktop-shell/installing-over-an-existing-installation] installs over the existing installation, and the installed application passes its smoke test again', async () => {
    await recordedStep('administrator/reinstall', async () => {
      const result = await run(installerPath, ['/S'], cleanEnv(), { timeoutMs: INSTALL_MS })
      expect(result.code, result.stderr).toBe(0)
      expect(readdirSync(installDir).filter((name) => /\.exe$/i.test(name)).sort()).toEqual(['Uninstall Veydr.exe', 'Veydr.exe'])
      expect(await sha256File(installedHelper)).toBe(await sha256File(unpackedHelper))
      const state = await inspect()
      expect(veydrEntries(state.uninstallUser, installDir)).toHaveLength(1)
      expect(state.processes.filter((p) => p.path === null || isBelow(p.path, installDir))).toEqual([])
      return { code: result.code, smoke: await smokeInstalled() }
    })
  })

  it.skipIf(notCi)('[spec:desktop-shell/silent-uninstallation] removes the install directory, the Start menu entry and the uninstall entry, and keeps the configuration, with the Start menu entry briefly held open', async () => {
    await recordedStep('administrator/uninstall', async () => {
      mkdirSync(configDir, { recursive: true })
      marker = join(configDir, `uninstall-marker-${randomBytes(6).toString('hex')}.txt`)
      writeFileSync(marker, 'written before the uninstall; must survive it\n', { flag: 'wx' })
      // The Start menu entry is held open without delete sharing for the first HOLD_LINK_MS of the
      // uninstall, as a scanner may hold it: a simulation of the most likely cause of the two CI runs
      // that left Veydr.lnk behind. electron-builder's own single Delete then fails (run 43476576477);
      // build/windows/installer.nsh retries for up to 10 s.
      const link = (await inspect()).startMenu?.path
      expect(link, 'the Start menu entry before the uninstall').toBeDefined()
      const holder = await holdOpen(link as string, HOLD_LINK_MS)
      const started = Date.now()
      const result = await run(uninstaller, ['/S'], cleanEnv(), { timeoutMs: INSTALL_MS })
      expect(result.code, result.stderr).toBe(0)
      const returnedMs = Date.now() - started
      const holderCode = await holder.closed
      const heldMs = Date.now() - started
      expect(holderCode, 'the process holding the Start menu entry').toBe(0)
      const left = await waitUntilUninstalled()
      const ms = Date.now() - started
      expect(left, `still there ${UNINSTALL_GONE_MS / 1000} s after the uninstall`).toEqual([])
      expect(existsSync(marker), marker).toBe(true)
      rmSync(marker)
      marker = null
      return { code: result.code, ms, uninstallerReturnedMs: returnedMs, linkHeldMs: heldMs }
    })
  })
})
