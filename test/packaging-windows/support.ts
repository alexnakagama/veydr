import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { smokeReportOf, type RunResult } from '../packaging/support'

// The Windows packaging tests (add-windows-packaging design D3) inspect and run what
// `npm run dist:windows` produced in `dist\`. The smoke report reader is shared with the Linux
// packaging tests; everything that differs on Windows is here.

export { smokeReportOf, type RunResult }

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

/** Fails with a hint instead of a confusing error when the package was not built. */
export function requirePackages(): void {
  for (const path of [unpackedBinary, unpackedHelper, installerPath]) {
    if (!existsSync(path)) throw new Error(`${path} is missing: run \`npm run dist:windows\` (or \`npm run test:packaging:windows\`) first`)
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
 * Runs a PowerShell script and parses its stdout as JSON. Values reach the script only through
 * `env` (read there as `$env:NAME`), never by interpolation into the script text.
 */
export async function powershellJson(script: string, env: Readonly<Record<string, string>> = {}): Promise<unknown> {
  const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'\n${script}`, 'utf16le').toString('base64')
  const result = await run(powershellPath, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], cleanEnv(env), { timeoutMs: 60_000 })
  if (result.code !== 0) throw new Error(`PowerShell exited ${String(result.code)}: ${result.stderr.slice(-2000)}`)
  return JSON.parse(result.stdout) as unknown
}
