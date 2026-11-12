import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Running W0's standard-user launcher (scripts/windows-probe/standard-user.ps1) from a test: it
// creates the temporary local account veydr-probe, runs one driver as that account, appends the
// driver's result lines to a results file, and removes the account whatever happens. Shared by the
// standard user's port listing (test/integration/windows-ports.test.ts) and installation
// (test/packaging-windows/standard-user-install.test.ts). Windows only; both run it in CI only.

export const STANDARD_USER_ACCOUNT = 'veydr-probe'

const systemRoot = (): string => process.env['SystemRoot'] ?? 'C:\\Windows'
/** Windows PowerShell 5.1 by its full path, which the launcher runs under (W0 design D2). */
const windowsPowerShell = (): string => join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const launcherScript = join(__dirname, '../../scripts/windows-probe/standard-user.ps1')

/** A result line as driver.mjs writes it. */
export interface ResultLine {
  readonly id: string
  readonly answer: 'yes' | 'no' | null
  readonly detail: string
  readonly data: Record<string, unknown>
}

export interface LauncherRun {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Runs standard-user.ps1 with `args` and resolves with its exit code and output; ends its tree after `timeoutMs`. */
export function runLauncher(args: readonly string[], timeoutMs: number): Promise<LauncherRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcherScript, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    const timer = setTimeout(() => {
      spawnSync(join(systemRoot(), 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 30_000 })
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`standard-user.ps1 could not start: ${error.message}`))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
  })
}

/**
 * Whether the account exists, read with Get-LocalUser in Windows PowerShell 5.1. PSModulePath is
 * dropped: a CI step's PowerShell 7 module path would make 5.1 load the wrong modules.
 */
export function accountExists(): boolean {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'))
  const script = `$ErrorActionPreference = 'Stop'; [bool](Get-LocalUser -Name '${STANDARD_USER_ACCOUNT}' -ErrorAction SilentlyContinue)`
  const run = spawnSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    env,
  })
  if (run.status !== 0) throw new Error(`cannot read whether the account ${STANDARD_USER_ACCOUNT} exists: ${run.error?.message ?? run.stderr}`)
  return run.stdout.trim() === 'True'
}

/**
 * Runs standard-user.ps1 -Cleanup if the account still exists, and throws, naming `earlier` (the
 * launch's own error, if any) too: the launcher must remove the account whatever happens.
 * -Cleanup also removes C:\veydr-probe-std and stops the account's processes.
 */
export function removeLeftoverAccount(earlier: unknown): void {
  if (!accountExists()) return
  const cleanup = spawnSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcherScript, '-Cleanup'], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  const before = earlier === undefined ? '' : `; before that, ${loggable(earlier instanceof Error ? earlier.message : (JSON.stringify(earlier) ?? 'an unknown error'))}`
  throw new Error(`standard-user.ps1 left the account ${STANDARD_USER_ACCOUNT} behind; -Cleanup exited with ${String(cleanup.status)}: ${loggable(`${cleanup.stdout}\n${cleanup.stderr}`)}${before}`)
}

/**
 * The launcher's output for the job log, without workflow commands: its first line masks the
 * account's password with `::add-mask::`, which must reach the runner itself, not this log, or the
 * password would be printed in clear.
 */
export const loggable = (text: string): string =>
  text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('::'))
    .join('\n')
    .trim()

/** The result lines in `file`, one JSON object per non-empty line. */
export function readResultLines(file: string): ResultLine[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ResultLine)
}
