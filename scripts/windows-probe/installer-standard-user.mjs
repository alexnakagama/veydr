#!/usr/bin/env node
// Installs Veydr as the temporary standard user (add-windows-packaging design D5, task 4.2), for
// test/packaging-windows/standard-user-install.test.ts. standard-user.ps1 starts it as that account,
// with the installer given by its -Installer parameter copied next to this file:
//
//   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows-probe/standard-user.ps1 -Results <results-file> -Timeout <seconds> -Driver installer-standard-user.mjs -Installer <full path of Veydr-<version>-x64-setup.exe>
//
// Its command line is `<installer name> <sha256> <electron.exe> --user standard [--unavailable
// <reason>]`, all of it written by the launcher: the installer's file name, the SHA-256 the launcher
// checked it with (lower-case hex), and the full path of the stock electron.exe in
// node_modules\electron\dist. Nothing else is run: the installer, what it installed, Windows
// PowerShell for the reads below, and that electron.exe with stock-window.cjs.
//
// It is built on driver.mjs, so it reports the context checks first (ctx-standard-user among them,
// the control that the token is not an administrator's) and answers every line with the reason when
// the standard user is unavailable. Like ports-standard-user.mjs it is not a probe area: its result
// lines are not checks of checks.mjs, it has no prediction, and summary.mjs and windows-probe.yml
// never see it. One line per step, in this order:
// - install-std-installer: the SHA-256 of its copy of the installer, `data.installer` being
//   `<sha256>  <name>` as SHA256SUMS writes it; `yes` when it equals the launcher's digest;
// - install-std-install: a silent install (/S) into the account's %LOCALAPPDATA%\Programs\veydr,
//   below its own profile, with Veydr.exe, one uninstaller, app.asar and the helper, a Start menu
//   entry Veydr.lnk pointing at Veydr.exe, one uninstall entry under HKCU, and no Veydr.exe running;
// - install-std-permissions: the access control lists of every installed path, judged by
//   install-acl.mjs's aclViolations for the account's own SID (design D4);
// - install-std-helper: the installed helper run directly: `version` prints the protocol version,
//   and `ports` lists a listener this driver opened, owned by the driver and readable (`known`);
// - install-std-smoke: the installed app's --smoke-test, with the stock-Electron control (below);
// - install-std-uninstall: a silent uninstall, after which the directory, the Start menu entry and
//   the uninstall entry are gone within UNINSTALL_GONE_MS.
//
// The smoke step follows the rule design D5 fixed before anything was measured. When the smoke test
// fails, the stock electron.exe is also started as the account, with `--version` and with
// stock-window.cjs, which opens a hidden window; the administrator's test runs the same control
// where windows are known to work (administrator/stock-window), so a broken control can never
// excuse a failure. `data.smokeCase` records the case:
// - `passed`: the smoke test passed (`yes`);
// - `not-testable`: it failed, and the stock binary could not open a window either (null, with the
//   reason): a limit of the runner's secondary logon, which the test accepts only if the same
//   installer's smoke test passed for the administrator in the same run;
// - `failed`: it failed, while the stock binary opened its window, or Windows refused to create the
//   control's process at all, so nothing shows the runner is the cause (`no`): a defect.
//
// The uninstall runs whenever the install left an uninstaller, whatever the steps between found.
// Exit codes: 0 written, 1 failure, 2 usage error.
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { DriverUsageError, driverMain, isEntryPoint, parseDriverArgs, runDriver, runProgram, windowsPowerShell } from './driver.mjs'
import { describeExit } from './helper-build.mjs'
import { aclChunks, aclViolations, READ_ACL_SCRIPT } from './install-acl.mjs'
import { runHelperPorts } from './ports-standard-user.mjs'
import { appEnv, outputTail, runSmoke } from './smoke-run.mjs'

/** Windows paths, also when the unit tests run elsewhere. */
const winJoin = win32.join

/** The driver's own area, outside checks.mjs's PROBE_AREAS. */
export const AREA = 'installer-standard-user'

export const INSTALLER_ID = 'install-std-installer'
export const INSTALL_ID = 'install-std-install'
export const PERMISSIONS_ID = 'install-std-permissions'
export const HELPER_ID = 'install-std-helper'
export const SMOKE_ID = 'install-std-smoke'
export const UNINSTALL_ID = 'install-std-uninstall'

/** The step lines, in the order they are written after the context checks. */
export const STEP_IDS = Object.freeze([INSTALLER_ID, INSTALL_ID, PERMISSIONS_ID, HELPER_ID, SMOKE_ID, UNINSTALL_ID])

/** runDriver's catalog for this driver. */
export const CATALOG = Object.freeze({
  areas: Object.freeze([AREA]),
  checks: Object.freeze(STEP_IDS.map((id) => Object.freeze({ kind: 'check', id, area: AREA, context: Object.freeze({ console: 'none', user: 'standard' }) }))),
})

/** The smoke step's cases (design D5). */
export const SMOKE_CASES = Object.freeze(['passed', 'not-testable', 'failed'])

/**
 * The protocol version the installed helper must print for `version`: PROTOCOL_VERSION of
 * src/main/platform/windows/protocol.ts. This driver runs from a copy of this directory and imports
 * nothing outside it, so the value is repeated here; a unit test checks that the two agree.
 */
export const PROTOCOL_VERSION = 3

/**
 * The installer's file name: nsis.artifactName of electron-builder.yml for a semantic version
 * without build metadata. The same pattern as $InstallerPattern of standard-user.ps1, which a unit
 * test compares.
 */
export const INSTALLER_NAME = /^Veydr-(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?-x64-setup\.exe$/

/** Where the launcher's stock electron.exe must be, below the checkout. */
const ELECTRON_TAIL = '\\node_modules\\electron\\dist\\electron.exe'

/** electron-builder names the install directory after package.json's `name` (design D1). */
export const INSTALL_DIRECTORY = 'veydr'
export const APP_NAME = 'Veydr.exe'
export const UNINSTALLER_NAME = 'Uninstall Veydr.exe'
export const RESOURCES = Object.freeze(['app.asar', 'veydr-helper.exe'])

/** electron-builder's limits for a silent install or uninstall (as the W0 probe measured them). */
export const INSTALL_MS = 180_000
/** The uninstaller copies itself to a temporary file and returns; the directory goes after that. */
export const UNINSTALL_GONE_MS = 120_000
/** How long a Veydr.exe the silent install might have started is looked for. */
export const NO_PROCESS_WATCH_MS = 5_000
const POLL_MS = 1_000
const HELPER_VERSION_MS = 30_000
const POWERSHELL_MS = 60_000
/** stock-window.cjs gives up after 60 s; this leaves it room to start and report. */
export const CONTROL_WINDOW_MS = 90_000
const CONTROL_VERSION_MS = 60_000

/** The seven checks of `--smoke-test` on a packaged build, in order. */
export const SMOKE_CHECKS = Object.freeze(['process-sandbox', 'config-dir-writable', 'platform', 'ui-loaded', 'preload-bridge', 'renderer-isolation', 'devtools-disabled'])
/** The smoke report's `platform` detail when listening sockets were read through the helper. */
const PLATFORM_DETAIL = /^windows: \d+ environment variables(?: \([^)]*\))?, \d+ listening sockets readable$/

/** The file stock-window.cjs writes when its window loaded, and what it writes. */
const STOCK_WINDOW_SCRIPT = fileURLToPath(new URL('./stock-window.cjs', import.meta.url))
const STOCK_WINDOW_LOADED = 'loaded'

const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim()
const messageOf = (error) => oneLine(error instanceof Error ? error.message : String(error))
/** Windows paths compare without case. */
const samePath = (a, b) => win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase()
const isBelow = (path, dir) => win32.resolve(path).toLowerCase().startsWith(`${win32.resolve(dir).toLowerCase()}\\`)

/**
 * Parses `<installer name> <sha256> <electron.exe> --user standard [--unavailable <reason>]`.
 * Throws DriverUsageError for anything else, before anything runs.
 */
export function parseInstallerArgs(args) {
  const { user, unavailable, positional } = parseDriverArgs(args)
  if (user !== 'standard') throw new DriverUsageError(`runs only as the standard user, not ${user}`)
  if (positional.length !== 3) throw new DriverUsageError(`expected <installer name> <sha256> <electron.exe>, got ${JSON.stringify(positional)}`)
  const [installerName, sha256, electron] = positional
  if (!INSTALLER_NAME.test(installerName)) throw new DriverUsageError(`not an installer name: ${JSON.stringify(installerName)}`)
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new DriverUsageError(`not a lower-case SHA-256: ${JSON.stringify(sha256)}`)
  if (!/^[A-Za-z]:\\[^\\]/.test(electron) || win32.normalize(electron) !== electron || !electron.endsWith(ELECTRON_TAIL)) {
    throw new DriverUsageError(`not the full path of node_modules\\electron\\dist\\electron.exe: ${JSON.stringify(electron)}`)
  }
  return { installerName, sha256, electron, unavailable }
}

// ---------------------------------------------------------------------------------------------
// The answers, one pure function per step

/** A program that did not start or was stopped: the reason, or undefined if it ran to its end. */
function notFinished(what, run, timeoutMs) {
  if (run.error !== undefined) return `${what} did not start: ${oneLine(run.error)}`
  if (run.signal !== null) return `${what} did not finish within ${timeoutMs / 1000} s`
  return undefined
}

/** install-std-installer: the copy's digest against the launcher's. */
export function installerAnswer({ installerName, expected, actual }) {
  const data = { installer: `${actual}  ${installerName}`, expected }
  if (actual !== expected) return { answer: 'no', detail: `the copy's SHA-256 ${actual} differs from the one the launcher checked, ${expected}`, data }
  return { answer: 'yes', detail: '', data }
}

/** The uninstall entries of Veydr: named so, or pointing into the install directory. */
export function veydrEntries(entries, installDir) {
  const dir = installDir.toLowerCase()
  return entries.filter((e) => /^veydr\b/i.test(e.displayName) || [e.uninstallString, e.installLocation].some((s) => s.toLowerCase().includes(dir)))
}

/**
 * The Veydr.exe processes that may be the installed app: below the install directory, or of a path
 * that cannot be read. An unreadable path is counted because it cannot be ruled out; it could also be
 * another account's Veydr.exe, which this assumes is not running: the account is temporary, and the
 * sequencer runs this test after every other packaging test, with no other file in parallel.
 */
export const installedProcesses = (processes, installDir) => processes.filter((p) => p.path === null || isBelow(p.path, installDir))

/** install-std-install, from the run of the installer and what it left (`state`, InstallState). */
export function installAnswer({ run, installDir, profile, state, processes }) {
  const data = { installDir, code: run.code, ...(run.ms === undefined ? {} : { ms: run.ms }) }
  const stopped = notFinished('the installer', run, INSTALL_MS)
  if (stopped !== undefined) return { answer: null, detail: stopped, data }
  if (run.code !== 0) return { answer: 'no', detail: `the silent install ${describeExit(run)}: ${outputTail(`${run.stdout} ${run.stderr}`)}`, data }
  const problems = []
  if (!isBelow(installDir, profile)) problems.push(`${installDir} is not below the account's profile ${profile}`)
  if (!state.directory) problems.push(`the silent install exited with 0, but ${installDir} does not exist`)
  else {
    const programs = [...state.programs].sort()
    if (JSON.stringify(programs) !== JSON.stringify([UNINSTALLER_NAME, APP_NAME])) problems.push(`the install directory holds the programs ${JSON.stringify(programs)}, not ${APP_NAME} and one uninstaller`)
    const resources = [...state.resources].sort()
    if (JSON.stringify(resources) !== JSON.stringify(RESOURCES)) problems.push(`resources\\ holds ${JSON.stringify(resources)}, not ${RESOURCES.join(' and ')}`)
  }
  if (state.startMenu === null) problems.push('there is no Start menu entry Veydr.lnk')
  else if (!samePath(state.startMenu.target, winJoin(installDir, APP_NAME))) problems.push(`the Start menu entry points at ${JSON.stringify(state.startMenu.target)}, not the installed ${APP_NAME}`)
  const entries = veydrEntries(state.uninstall, installDir)
  if (entries.length !== 1) problems.push(`there are ${entries.length} uninstall entries of Veydr under HKCU, not one`)
  const running = installedProcesses(processes, installDir)
  if (running.length > 0) problems.push(`Veydr.exe is running after the silent install: ${JSON.stringify(running)}`)
  Object.assign(data, { startMenu: state.startMenu, uninstallEntries: entries.map((e) => e.key) })
  return problems.length === 0 ? { answer: 'yes', detail: '', data } : { answer: 'no', detail: problems.join('; '), data }
}

/** install-std-permissions, from the ACL report of every installed path (design D4). */
export function permissionsAnswer({ report, installDir, required }) {
  const listed = report.paths.map((p) => p.path)
  const missing = required.filter((path) => !listed.some((p) => samePath(p, path)))
  // The four named paths' lists, by SID, as the administrator's test records them.
  const observed = report.paths
    .filter((p) => [installDir, ...required].some((named) => samePath(named, p.path)))
    .map((p) => ({ path: p.path, owner: p.owner, access: p.access.map((a) => `${String(a.sid)} ${a.type} 0x${Number(a.rights).toString(16)}${a.inherited === true ? ' inherited' : ''}`) }))
  const data = { user: report.user, checked: report.paths.length, observed }
  if (missing.length > 0) return { answer: 'no', detail: `the ACL report misses ${missing.join(', ')}`, data }
  let violations
  try {
    violations = aclViolations(report)
  } catch (error) {
    return { answer: 'no', detail: `the ACL report cannot be judged: ${messageOf(error)}`, data }
  }
  if (violations.length > 0) return { answer: 'no', detail: violations.map((v) => `${v.path}: ${String(v.sid)} ${v.problem}`).join('; '), data: { ...data, violations } }
  return { answer: 'yes', detail: '', data }
}

/**
 * install-std-helper, from `version` (a ProgramResult), `ports` (a HelperRun of ports-standard-user.mjs)
 * and `listener` (`{ port, pid }`, the driver's own listening socket on 127.0.0.1).
 */
export function helperAnswer({ version, ports, listener }) {
  const data = { versionCode: version.code, versionOutput: oneLine(version.stdout).slice(0, 200), listener }
  const stopped = notFinished('the helper\'s `version`', version, HELPER_VERSION_MS)
  if (stopped !== undefined) return { answer: null, detail: stopped, data }
  if (version.code !== 0) return { answer: 'no', detail: `the helper's \`version\` ${describeExit(version)}: ${outputTail(version.stderr)}`, data }
  if (version.stdout.trim() !== String(PROTOCOL_VERSION)) return { answer: 'no', detail: `the helper's \`version\` printed ${JSON.stringify(version.stdout.trim().slice(0, 200))}, not the protocol version ${PROTOCOL_VERSION}`, data }

  Object.assign(data, { portsCode: ports.code, portsMs: ports.ms })
  if (ports.error !== undefined) return { answer: null, detail: `the helper's \`ports\` did not start: ${oneLine(ports.error)}`, data }
  if (ports.stopped !== undefined) return { answer: null, detail: `the helper's \`ports\` was stopped (${ports.stopped})`, data }
  if (ports.code !== 0) return { answer: 'no', detail: `the helper's \`ports\` exited with ${String(ports.code ?? ports.signal)}: ${oneLine(ports.stderr)}`, data }
  let listing
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(ports.stdout)
    const lines = text.split('\n')
    if (lines.length !== 2 || lines[1] !== '') throw new Error('not exactly one line ending in a line feed')
    listing = JSON.parse(lines[0])
    if (listing?.type !== 'ports' || !Array.isArray(listing.listeners) || !Array.isArray(listing.owners)) throw new Error('not a port listing')
  } catch (error) {
    return { answer: 'no', detail: `the helper's \`ports\` printed no port listing: ${messageOf(error)}`, data }
  }
  Object.assign(data, { listeners: listing.listeners.length })
  const found = listing.listeners.filter((l) => l?.family === 'ipv4' && l.address === '7f000001' && l.port === listener.port)
  if (found.length === 0) return { answer: 'no', detail: `the helper's \`ports\` does not list the driver's listener on 127.0.0.1:${listener.port}`, data }
  if (found.some((l) => l.pid !== listener.pid)) return { answer: 'no', detail: `127.0.0.1:${listener.port} is listed with PID ${found.map((l) => String(l.pid)).join(', ')}, not the driver's ${listener.pid}`, data }
  const owner = listing.owners.find((o) => o?.pid === listener.pid)
  Object.assign(data, { ownerState: owner?.state ?? null })
  if (owner?.state !== 'known') return { answer: 'no', detail: `the driver's own process is listed as ${JSON.stringify(owner?.state ?? 'missing')}, not known`, data }
  return { answer: 'yes', detail: '', data }
}

/** Whether the installed app's smoke run passed: undefined if it did, else why not. */
export function smokeProblem(smoke, installDir) {
  if (smoke.report === undefined) return smoke.problem ?? 'the app printed no smoke report'
  const { report } = smoke
  const failed = report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${oneLine(c.detail)}`)
  if (failed.length > 0) return `failed checks: ${failed.join('; ')}`
  const names = report.checks.map((c) => c.name)
  if (JSON.stringify(names) !== JSON.stringify(SMOKE_CHECKS)) return `the report's checks are ${JSON.stringify(names)}, not the seven of a packaged build`
  if (report.result !== 'pass' || report.packaged !== true) return `the report says ${String(report.result)}, packaged ${String(report.packaged)}`
  if (typeof report.appPath !== 'string' || !samePath(report.appPath, winJoin(installDir, 'resources', 'app.asar'))) return `the UI came from ${JSON.stringify(report.appPath)}, not the installed app.asar`
  const platform = report.checks.find((c) => c.name === 'platform')?.detail ?? ''
  if (!PLATFORM_DETAIL.test(platform)) return `the platform check reports ${JSON.stringify(platform)}, not readable listening sockets`
  const run = smoke.reportVia === 'file' ? smoke.fileRun : smoke.run
  if (run?.code !== 0) return `the app ${run === undefined ? 'did not run' : describeExit(run)} although its report passed`
  return undefined
}

/**
 * How the stock-Electron control went: `opened` (stock-window.cjs loaded its window), `failed` (it
 * started but loaded none, including a start that failed inside the process, such as
 * STATUS_DLL_INIT_FAILED without a desktop), or `not-started` (Windows refused to create the process
 * at all: spawn failed). `not-started` counts as a defect, not as the runner's limit: it says nothing
 * about windows, and the launcher checked that electron.exe is readable to the account, so the
 * fallback is never granted on evidence that does not concern a window.
 */
export function controlOutcome({ window, loaded }) {
  if (window.error !== undefined) return 'not-started'
  return window.signal === null && window.code === 0 && loaded ? 'opened' : 'failed'
}

/** install-std-smoke, by the rule of design D5. */
export function smokeAnswer({ smoke, control, installDir }) {
  const problem = smokeProblem(smoke, installDir)
  const smokeRun = smoke.reportVia === 'file' ? smoke.fileRun : smoke.run
  const base = {
    reportVia: smoke.reportVia,
    code: smokeRun?.code ?? null,
    ...(smoke.report === undefined ? {} : { result: smoke.report.result, appPath: smoke.report.appPath ?? null, platform: smoke.report.checks.find((c) => c.name === 'platform')?.detail ?? null }),
    stderr: outputTail(smoke.run.stderr),
  }
  if (problem === undefined) return { answer: 'yes', detail: '', data: { smokeCase: 'passed', ...base } }
  if (control === undefined) throw new Error('a failed smoke test needs the stock-Electron control to be judged')
  const outcome = controlOutcome(control)
  const data = {
    ...base,
    control: {
      outcome,
      version: oneLine(control.version.stdout).slice(0, 100),
      versionCode: control.version.code,
      windowCode: control.window.code,
      windowSignal: control.window.signal,
      ...(control.window.error === undefined ? {} : { windowError: oneLine(control.window.error) }),
      windowStderr: outputTail(control.window.stderr),
    },
  }
  if (outcome === 'failed') {
    return {
      answer: null,
      detail: `not testable: the installed app's smoke test failed (${problem}), and the stock Electron binary could not open a window for this account either (${control.window.signal === null ? `exit code ${String(control.window.code)}` : 'stopped'}), so the runner's secondary logon is the cause`,
      data: { ...data, smokeCase: 'not-testable', problem },
    }
  }
  const why = outcome === 'opened' ? 'the stock Electron binary opened a window for this account' : `the stock Electron control did not start (${oneLine(control.window.error ?? '')}), so nothing shows the runner is the cause`
  return { answer: 'no', detail: `the installed app's smoke test failed: ${problem}; ${why}`, data: { ...data, smokeCase: 'failed', problem } }
}

/** What a silent uninstall must remove and `state` still shows: the directory, the Start menu entry, the uninstall entries. */
export function uninstallRemaining(state, installDir) {
  return [
    ...(state.directory ? [`the directory ${installDir}`] : []),
    ...(state.startMenu === null ? [] : [`the Start menu entry ${state.startMenu.path}`]),
    ...veydrEntries(state.uninstall, installDir).map((e) => `the uninstall entry ${e.key}`),
  ]
}

/**
 * Inspects the installation until uninstallRemaining finds nothing, or until UNINSTALL_GONE_MS have
 * passed, and returns the last state. All three are waited for, as the administrator's test does:
 * the uninstaller copies itself and returns, and once (group 5) Veydr.lnk outlived the directory.
 */
export async function waitUntilUninstalled(installDir, { inspect: inspectImpl, pause, now }) {
  const deadline = now() + UNINSTALL_GONE_MS
  for (;;) {
    const state = await inspectImpl(installDir)
    if (uninstallRemaining(state, installDir).length === 0 || now() >= deadline) return state
    await pause(POLL_MS)
  }
}

/** install-std-uninstall, from the uninstaller's run and the state waitUntilUninstalled returned. */
export function uninstallAnswer({ run, state, installDir }) {
  const data = { code: run.code, ...(run.ms === undefined ? {} : { ms: run.ms }) }
  const stopped = notFinished('the uninstaller', run, INSTALL_MS)
  if (stopped !== undefined) return { answer: null, detail: stopped, data }
  if (run.code !== 0) return { answer: 'no', detail: `the silent uninstall ${describeExit(run)}: ${outputTail(`${run.stdout} ${run.stderr}`)}`, data }
  const remaining = uninstallRemaining(state, installDir)
  if (remaining.length > 0) return { answer: 'no', detail: `still there ${UNINSTALL_GONE_MS / 1000} s after the silent uninstall: ${remaining.join('; ')}`, data: { ...data, remaining } }
  return { answer: 'yes', detail: '', data }
}

// ---------------------------------------------------------------------------------------------
// The steps on Windows, each replaceable in the unit tests

/** The environment for Windows PowerShell 5.1: this one without PSModulePath, so 5.1 builds its own. */
const powershellEnv = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH')), ...extra })

/** Runs a Windows PowerShell 5.1 script, values only through `env`, and parses its stdout as JSON. */
export async function powershellJson(script, env = {}) {
  const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${script}`, 'utf16le').toString('base64')
  const run = await runProgram(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { timeoutMs: POWERSHELL_MS, env: powershellEnv(env) })
  const stopped = notFinished('Windows PowerShell', run, POWERSHELL_MS)
  if (stopped !== undefined) throw new Error(stopped)
  if (run.code !== 0) throw new Error(`Windows PowerShell exited with ${String(run.code)}: ${outputTail(run.stderr)}`)
  // runProgram reads Latin-1, which keeps every byte; the script wrote UTF-8.
  return JSON.parse(Buffer.from(run.stdout, 'latin1').toString('utf8'))
}

/**
 * What an install leaves outside its directory, for the account running it: the Start menu entry
 * (from the shell's own known-folder lookup), the HKCU uninstall entries, and the Veydr.exe processes.
 */
const INSPECT_SCRIPT = `
Remove-TypeData -TypeName System.Array -ErrorAction SilentlyContinue
$startMenuPath = Join-Path ([Environment]::GetFolderPath('Programs')) 'Veydr.lnk'
$startMenu = $null
if (Test-Path -LiteralPath $startMenuPath -PathType Leaf) {
  $shell = New-Object -ComObject WScript.Shell
  $startMenu = [pscustomobject]@{ path = $startMenuPath; target = [string]$shell.CreateShortcut($startMenuPath).TargetPath }
}
$key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
$uninstall = @(if (Test-Path -LiteralPath $key) {
  foreach ($sub in Get-ChildItem -LiteralPath $key) {
    [pscustomobject]@{ key = $sub.Name; displayName = [string]$sub.GetValue('DisplayName'); uninstallString = [string]$sub.GetValue('UninstallString'); installLocation = [string]$sub.GetValue('InstallLocation') }
  }
})
$processes = @(Get-Process -Name Veydr -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ pid = $_.Id; path = $_.Path } })
ConvertTo-Json -InputObject ([pscustomobject]@{ startMenu = $startMenu; uninstall = $uninstall; processes = $processes }) -Depth 5 -Compress
`

/** The install directory's programs and resources, and inspectOutside's state. */
async function inspect(installDir) {
  const outside = await powershellJson(INSPECT_SCRIPT)
  const directory = existsSync(installDir)
  const programs = directory ? readdirSync(installDir).filter((name) => /\.exe$/i.test(name)) : []
  const resourcesDir = winJoin(installDir, 'resources')
  const resources = directory && existsSync(resourcesDir) ? readdirSync(resourcesDir) : []
  return { directory, programs, resources, startMenu: outside.startMenu ?? null, uninstall: outside.uninstall ?? [], processes: outside.processes ?? [] }
}

/** Every Veydr.exe that may be the installed app, seen over NO_PROCESS_WATCH_MS. */
async function watchProcesses(installDir, inspectImpl = inspect) {
  const deadline = Date.now() + NO_PROCESS_WATCH_MS
  const seen = new Map()
  for (;;) {
    for (const p of installedProcesses((await inspectImpl(installDir)).processes, installDir)) seen.set(p.pid, p)
    if (Date.now() > deadline) return [...seen.values()]
    await sleep(POLL_MS)
  }
}

async function sha256File(file) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/** Throws unless `entries` (an ACL report's paths) are exactly `paths`, in order: a path left out would go unjudged. */
export function requireEveryPath(paths, entries) {
  const returned = entries.map((entry) => entry?.path)
  if (returned.length !== paths.length || returned.some((path, i) => path !== paths[i])) {
    throw new Error(`the ACL reads returned ${returned.length} paths for the ${paths.length} asked for, or not the same ones`)
  }
}

/** The access control lists of every path below `installDir` and the directory itself, read as this account. */
async function readPermissions(installDir) {
  const paths = [installDir, ...readdirSync(installDir, { recursive: true, encoding: 'utf8' }).map((path) => winJoin(installDir, path))]
  let user = null
  const entries = []
  for (const chunk of aclChunks(paths)) {
    const report = await powershellJson(READ_ACL_SCRIPT, { VEYDR_ACL_PATHS: JSON.stringify(chunk) })
    if (report === null || typeof report !== 'object' || !Array.isArray(report.paths)) throw new Error(`unexpected ACL report: ${JSON.stringify(report).slice(0, 500)}`)
    if (user !== null && report.user !== user) throw new Error(`the ACL reads ran as different accounts: ${user}, ${String(report.user)}`)
    user = report.user
    entries.push(...report.paths)
  }
  requireEveryPath(paths, entries)
  return { user, paths: entries }
}

/** Opens a listening socket on 127.0.0.1, on a port the system picks, in this process. */
function openListener() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ port: typeof address === 'object' && address !== null ? address.port : 0, pid: process.pid, close: () => new Promise((done) => server.close(() => done())) })
    })
  })
}

/** The installed helper run directly: `version`, then `ports` with the driver's own listener open. */
async function runInstalledHelper(helper) {
  const version = await runProgram(helper, ['version'], { timeoutMs: HELPER_VERSION_MS, cwd: win32.dirname(helper), env: appEnv() })
  const server = await openListener()
  try {
    // The listener's process is the driver, created long before the helper's fence.
    const ports = await runHelperPorts(helper)
    return { version, ports, listener: { port: server.port, pid: server.pid } }
  } finally {
    await server.close()
  }
}

/** The stock electron.exe as this account: `--version`, then stock-window.cjs with a hidden window. */
async function runControl(electron, dir) {
  const version = await runProgram(electron, ['--version'], { timeoutMs: CONTROL_VERSION_MS, env: appEnv() })
  const outFile = join(dir, 'stock-window.txt')
  const window = await runProgram(electron, [STOCK_WINDOW_SCRIPT], { timeoutMs: CONTROL_WINDOW_MS, env: { ...appEnv(), VEYDR_STOCK_WINDOW_FILE: outFile } })
  let loaded = false
  try {
    loaded = readFileSync(outFile, 'utf8') === STOCK_WINDOW_LOADED
  } catch {
    loaded = false
  }
  return { version, window, loaded }
}

const timed = async (body) => {
  const started = Date.now()
  const run = await body()
  return { ...run, ms: Date.now() - started }
}

/** The default steps; the unit tests replace them with recorded outcomes. */
export const WINDOWS_STEPS = Object.freeze({
  environment: () => ({ localAppData: process.env.LOCALAPPDATA, profile: process.env.USERPROFILE }),
  installerFile: (name) => fileURLToPath(new URL(`./${name}`, import.meta.url)),
  hash: async (file) => {
    // The launcher copied a regular file here; anything else is refused rather than hashed.
    if (!lstatSync(file).isFile()) throw new Error(`${file} is not a regular file`)
    return await sha256File(file)
  },
  exists: (path) => existsSync(path),
  install: (installer) => timed(() => runProgram(installer, ['/S'], { timeoutMs: INSTALL_MS, env: appEnv() })),
  inspect,
  watchProcesses: (installDir) => watchProcesses(installDir),
  permissions: readPermissions,
  helper: runInstalledHelper,
  smoke: (app, dir) => runSmoke(app, ['--smoke-test'], { dir }),
  control: runControl,
  uninstall: (uninstaller) => timed(() => runProgram(uninstaller, ['/S'], { timeoutMs: INSTALL_MS, env: appEnv() })),
  pause: (ms) => sleep(ms),
  now: () => Date.now(),
  tempDir: () => mkdtempSync(join(tmpdir(), 'veydr-install-std-')),
  removeDir: (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
})

/**
 * Runs the steps and reports one line per step through `report`. A step that throws answers null
 * with the error; a step that cannot run because an earlier one failed answers null saying so. The
 * uninstall runs whenever an uninstaller was installed.
 */
export async function installAsStandardUser(report, { installerName, sha256, electron }, steps = WINDOWS_STEPS) {
  const attempt = async (id, body) => {
    try {
      const result = await body()
      report(id, result.answer, result.detail, result.data ?? {})
      return result
    } catch (error) {
      report(id, null, `the step failed: ${messageOf(error)}`, {})
      return undefined
    }
  }
  const skip = (ids, reason) => {
    for (const id of ids) report(id, null, reason, {})
  }

  const installer = steps.installerFile(installerName)
  const hashed = await attempt(INSTALLER_ID, async () => installerAnswer({ installerName, expected: sha256, actual: await steps.hash(installer) }))
  // An installer that is not the one checked is never run.
  if (hashed?.answer !== 'yes') return skip([INSTALL_ID, PERMISSIONS_ID, HELPER_ID, SMOKE_ID, UNINSTALL_ID], 'not run: the installer copy was not the one the launcher checked')

  const { localAppData, profile } = steps.environment()
  if (typeof localAppData !== 'string' || !win32.isAbsolute(localAppData) || typeof profile !== 'string' || !win32.isAbsolute(profile)) {
    return skip([INSTALL_ID, PERMISSIONS_ID, HELPER_ID, SMOKE_ID, UNINSTALL_ID], `not run: LOCALAPPDATA (${JSON.stringify(localAppData)}) and USERPROFILE (${JSON.stringify(profile)}) must be absolute paths`)
  }
  const installDir = winJoin(localAppData, 'Programs', INSTALL_DIRECTORY)
  const app = winJoin(installDir, APP_NAME)
  const uninstaller = winJoin(installDir, UNINSTALLER_NAME)
  const resources = winJoin(installDir, 'resources')
  const helper = winJoin(resources, 'veydr-helper.exe')
  // A fresh account has none; one that has would be installed over, and removed, by this driver.
  if (steps.exists(installDir)) return skip([INSTALL_ID, PERMISSIONS_ID, HELPER_ID, SMOKE_ID, UNINSTALL_ID], `not run: ${installDir} exists before the install`)

  const installed = await attempt(INSTALL_ID, async () => {
    const run = await steps.install(installer)
    const state = await steps.inspect(installDir)
    const processes = run.code === 0 && state.directory ? await steps.watchProcesses(installDir) : state.processes
    return installAnswer({ run, installDir, profile, state, processes })
  })
  if (installed?.answer === 'yes') {
    await attempt(PERMISSIONS_ID, async () => permissionsAnswer({ report: await steps.permissions(installDir), installDir, required: [app, winJoin(resources, 'app.asar'), helper] }))
    await attempt(HELPER_ID, async () => helperAnswer(await steps.helper(helper)))
    await attempt(SMOKE_ID, async () => {
      // For the smoke report written to a file, and the control's result file.
      const dir = steps.tempDir()
      try {
        const smoke = await steps.smoke(app, dir)
        // The control is only needed to judge a failure (design D5), and costs up to 150 s.
        const control = smokeProblem(smoke, installDir) === undefined ? undefined : await steps.control(electron, dir)
        return smokeAnswer({ smoke, control, installDir })
      } finally {
        try {
          steps.removeDir(dir)
        } catch {
          // In the account's own profile, which the launcher removes with the account.
        }
      }
    })
  } else {
    skip([PERMISSIONS_ID, HELPER_ID, SMOKE_ID], 'not run: the install failed')
  }
  // Whatever the steps between found, an installed uninstaller is run, so the account leaves nothing.
  if (!steps.exists(uninstaller)) return skip([UNINSTALL_ID], `not run: ${uninstaller} does not exist`)
  await attempt(UNINSTALL_ID, async () => {
    const run = await steps.uninstall(uninstaller)
    // A failed uninstall is reported at once; what it left is not waited for.
    const state = run.code === 0 ? await waitUntilUninstalled(installDir, { inspect: steps.inspect, pause: steps.pause, now: steps.now }) : await steps.inspect(installDir)
    return uninstallAnswer({ run, state, installDir })
  })
}

/** Runs the driver for a parsed command line; `options` are passed on to runDriver (tests), but for `steps`. */
export async function runInstallerStandardUser(args, { steps = WINDOWS_STEPS, ...options } = {}) {
  const parsed = parseInstallerArgs(args)
  await runDriver({
    ...options,
    area: AREA,
    user: 'standard',
    ids: STEP_IDS,
    unavailable: parsed.unavailable,
    catalog: CATALOG,
    probe: (report) => installAsStandardUser(report, parsed, steps),
  })
}

if (isEntryPoint(import.meta.url)) driverMain('installer-standard-user.mjs', runInstallerStandardUser)
