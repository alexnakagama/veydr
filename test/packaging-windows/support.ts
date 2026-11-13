import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { ACL_CHUNK_CHARS, aclChunks, READ_ACL_SCRIPT, type AclReport } from '../../scripts/windows-probe/install-acl.mjs'
import { SMOKE_ID } from '../../scripts/windows-probe/installer-standard-user.mjs'
import { smokeReportOf, type RunResult } from '../packaging/support'
import type { ResultLine } from '../support/standard-user'

// The Windows packaging tests (add-windows-packaging design D3) inspect and run what
// `npm run dist:windows` produced in `dist\`. The smoke report reader is shared with the Linux
// packaging tests; everything that differs on Windows is here.

export { ACL_CHUNK_CHARS, aclChunks, smokeReportOf, type RunResult }

export const repoRoot = resolve(__dirname, '../..')
export const distDir = join(repoRoot, 'dist')
export const unpackedDir = join(distDir, 'win-unpacked')
export const resourcesDir = join(unpackedDir, 'resources')
export const unpackedBinary = join(unpackedDir, 'Veydr.exe')
export const unpackedHelper = join(resourcesDir, 'veydr-helper.exe')
/** The helper `dist:windows` built from source in the same run, which electron-builder copied. */
export const builtHelper = join(repoRoot, 'out-helper', 'veydr-helper.exe')

/** The seven checks of `--smoke-test` on a packaged build, in order. */
export const ALL_SMOKE_CHECKS = ['process-sandbox', 'config-dir-writable', 'platform', 'ui-loaded', 'preload-bridge', 'renderer-isolation', 'devtools-disabled']

/** A semantic version without build metadata, as package.json and the release workflow use it. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/

/**
 * The installer's file name for `version`, as `nsis.artifactName` in electron-builder.yml writes it
 * (`${productName}-${version}-x64-setup.${ext}`). Throws for anything that is not a semantic
 * version, so a malformed version can never produce a name with a path in it.
 */
export function installerName(version: string, productName = 'Veydr'): string {
  if (!SEMVER.test(version)) throw new Error(`not a semantic version without build metadata: ${JSON.stringify(version)}`)
  return `${productName}-${version}-x64-setup.exe`
}

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string; productName: string }
export const version = pkg.version
export const installerPath = join(distDir, installerName(pkg.version, pkg.productName))

/** The prefix of the build copies fuses.test.ts makes below dist\ (same volume, for hard links). */
export const PROBE_COPY_PREFIX = '.fuse-probe-'

/**
 * Fails with a hint instead of a confusing error when the package was not built, and removes build
 * copies an aborted fuses run left in dist\, so they are never mistaken for package output.
 */
export function requirePackages(): void {
  for (const path of [unpackedBinary, unpackedHelper, installerPath]) {
    if (!existsSync(path)) throw new Error(`${path} is missing: run \`npm run dist:windows\` (or \`npm run test:packaging:windows\`) first`)
  }
  for (const name of readdirSync(distDir)) {
    if (name.startsWith(PROBE_COPY_PREFIX)) rmSync(join(distDir, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  }
}

/**
 * The test runner's environment without anything that changes how Electron or Node runs. Windows
 * environment names are case-insensitive, so names are compared that way, and an `extra` value
 * replaces every spelling of its name.
 */
export function cleanEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const overridden = new Set(Object.keys(extra).map((key) => key.toUpperCase()))
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase()
    if (value === undefined || upper.startsWith('ELECTRON_') || upper === 'NODE_OPTIONS' || overridden.has(upper)) continue
    env[key] = value
  }
  return { ...env, ...extra }
}

export interface WindowsRunResult extends RunResult {
  /** The process was still running after the timeout and was killed. */
  readonly timedOut: boolean
}

/**
 * Runs `file` hidden, without a shell, and resolves when it exits. After `timeoutMs` the process is
 * killed; that rejects, unless `allowTimeout` is set, for a run whose expected outcome is "did not
 * start the app" (a binary that refuses may wait on an error dialog nobody can close).
 */
export function run(
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  { timeoutMs = 60_000, cwd, allowTimeout = false }: { timeoutMs?: number; cwd?: string; allowTimeout?: boolean } = {},
): Promise<WindowsRunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, ...(cwd === undefined ? {} : { cwd }) })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    child.stdout.on('data', (chunk: Buffer) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk: Buffer) => (stderr += String(chunk)))
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
      // If taskkill failed or timed out, end at least the process itself, so the promise settles.
      child.kill('SIGKILL')
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      reject(error)
    })
    // Resolved on `close`, once the pipes are drained; but a descendant that inherited them (a
    // crash handler) may keep them open, so `exit` ends the wait after a grace period.
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (timedOut && !allowTimeout) reject(new Error(`${file} did not exit within ${timeoutMs} ms; stderr: ${stderr.slice(-2000)}`))
      else resolvePromise({ code, signal, stdout, stderr, timedOut })
    }
    child.once('close', finish)
    child.once('exit', (code, signal) => {
      // Descendants are not killed here: after the parent exited, `taskkill /T` can no longer find
      // them by its PID. A copy they still hold is removed later (fuses.test.ts afterAll, requirePackages).
      setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        finish(code, signal)
      }, PIPE_GRACE_MS).unref()
    })
  })
}

/** How long the pipes may stay open after the process exited. */
const PIPE_GRACE_MS = 5_000

/** Ends a process and its descendants (`taskkill /T /F`, by its full path); a process already gone is no error. */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  const taskkill = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 30_000 })
}

/** Windows PowerShell 5.1 by its full path, so a `powershell.exe` earlier on PATH is never run. */
export const powershellPath = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/**
 * `cleanEnv(extra)` without `PSModulePath`. A step of the runner runs in PowerShell 7, whose module
 * path every child inherits; Windows PowerShell 5.1 would then load PowerShell 7's copy of modules
 * such as Microsoft.PowerShell.Security (`Get-AuthenticodeSignature`, `Get-Acl`) and fail. Without
 * the variable, 5.1 builds its own default module path.
 */
export function windowsPowerShellEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(cleanEnv(extra)).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'))
}

/**
 * Runs a PowerShell script and parses its stdout as JSON. Values reach the script only through
 * `env` (read there as `$env:NAME`), never by interpolation into the script text.
 */
export async function powershellJson(script: string, env: Readonly<Record<string, string>> = {}): Promise<unknown> {
  // Windows PowerShell 5.1 writes the OEM code page by default; stdout is read as UTF-8.
  const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${script}`, 'utf16le').toString('base64')
  const result = await run(powershellPath, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], windowsPowerShellEnv(env), { timeoutMs: 60_000 })
  if (result.code !== 0) throw new Error(`PowerShell exited ${String(result.code)}: ${result.stderr.slice(-2000)}`)
  return JSON.parse(result.stdout) as unknown
}

// The Windows install record (add-windows-packaging design D3, task 3.1). The project's global setup
// starts it with the installer's line as `SHA256SUMS` would write it; every installer step then
// appends one line. The release attaches it as install-windows-steps.jsonl (design D6).

export const installRecordPath = join(repoRoot, 'test-results', 'windows-install', 'steps.jsonl')

/** One line of the install record. */
export interface InstallRecordLine {
  readonly at: string
  readonly step: string
  readonly ok: boolean
  readonly detail: unknown
}

/** The SHA-256 of `file`, as lower-case hex, read as a stream (the installer is about 100 MB). */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/**
 * Creates the record at `record`, replacing any earlier one, with a first line whose
 * `detail.installer` is `<sha256>  <file name>` of `installer`. `installer` must be a regular file
 * named as `nsis.artifactName` names it. Returns that line's `installer` value.
 */
export async function startInstallRecord(installer: string, record: string = installRecordPath): Promise<string> {
  const name = basename(installer)
  const version = /^Veydr-(.+)-x64-setup\.exe$/.exec(name)?.[1]
  // installerName throws for anything that is not a semantic version, so the name never carries a
  // line break or a path into the record.
  if (version === undefined || installerName(version) !== name) throw new Error(`not an installer name: ${JSON.stringify(name)}`)
  if (!statSync(installer).isFile()) throw new Error(`${installer} is not a regular file`)
  const line = `${await sha256File(installer)}  ${name}`
  mkdirSync(dirname(record), { recursive: true })
  const first: InstallRecordLine = { at: new Date().toISOString(), step: 'installer', ok: true, detail: { installer: line } }
  writeFileSync(record, `${JSON.stringify(first)}\n`, { flag: 'w' })
  return line
}

/**
 * Appends `{ at, step, ok, detail }` to the record. Fails if the record was not started, so a step is
 * never recorded without the installer it belongs to.
 */
export function recordStep(step: string, ok: boolean, detail: unknown = null, record: string = installRecordPath): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(step)) throw new Error(`not a step name: ${JSON.stringify(step)}`)
  if (!existsSync(record)) throw new Error(`${record} does not exist: the packaging-windows global setup did not run`)
  const line: InstallRecordLine = { at: new Date().toISOString(), step, ok, detail: detail ?? null }
  appendFileSync(record, `${JSON.stringify(line)}\n`)
}

/** Runs `body` and records its outcome as `step`: `ok` with what it returned, or not `ok` with the error. Rethrows. */
export async function recordedStep<T>(step: string, body: () => Promise<T> | T, record: string = installRecordPath): Promise<T> {
  let result: T
  try {
    result = await body()
  } catch (error) {
    recordStep(step, false, { error: (error instanceof Error ? error.message : String(error)).slice(0, 4000) }, record)
    throw error
  }
  recordStep(step, true, result ?? null, record)
  return result
}

/** The access control lists of `paths` (full paths), each identity as a SID (scripts/windows-probe/install-acl.mjs). */
export async function readAcls(paths: readonly string[]): Promise<AclReport> {
  let user: string | null = null
  const entries: AclReport['paths'][number][] = []
  for (const chunk of aclChunks(paths)) {
    const report = await powershellJson(READ_ACL_SCRIPT, { VEYDR_ACL_PATHS: JSON.stringify(chunk) })
    if (report === null || typeof report !== 'object' || !Array.isArray((report as { paths?: unknown }).paths)) throw new Error(`unexpected ACL report: ${JSON.stringify(report).slice(0, 2000)}`)
    const read = report as AclReport
    if (user !== null && read.user !== user) throw new Error(`the ACL reads ran as different accounts: ${user}, ${read.user}`)
    user = read.user
    entries.push(...read.paths)
  }
  if (user === null) throw new Error('no path to read')
  return { user, paths: entries }
}

/**
 * Whether a step line of installer-standard-user.mjs passed (add-windows-packaging design D5). The
 * smoke step passes as `passed`, or as `not-testable` when the driver found the stock Electron
 * binary unable to open a window for the account while the same installer's smoke test passed for
 * the administrator in the same run, and the same control opened its window for the administrator
 * (`administrator/smoke` and `administrator/stock-window` in `record`, which installer.test.ts
 * writes). Every other step passes only with `yes`.
 */
export function standardUserStepPassed(line: ResultLine, record: readonly InstallRecordLine[]): boolean {
  if (line.id !== SMOKE_ID) return line.answer === 'yes'
  if (line.answer === 'yes') return line.data['smokeCase'] === 'passed'
  if (line.answer !== null || line.data['smokeCase'] !== 'not-testable') return false
  // Both administrator steps of the same run: the installed app's smoke test, and the stock-Electron
  // control opening its window, so the control is known to work where windows do.
  return ['administrator/smoke', 'administrator/stock-window'].every((step) => record.some((r) => r.step === step && r.ok))
}
