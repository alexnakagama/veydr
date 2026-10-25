import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SMOKE_REPORT_PREFIX, type SmokeReport } from '../../src/main/app/smoke'

// Packaging tests (task group L8) inspect and run what `npm run dist:linux` produced in `dist/`.
export const repoRoot = resolve(__dirname, '../..')
export const distDir = join(repoRoot, 'dist')
export const unpackedDir = join(distDir, 'linux-unpacked')
export const unpackedBinary = join(unpackedDir, 'veydr')

const version = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version
export const appImagePath = join(distDir, `Veydr-${version}-x86_64.AppImage`)
export const debPath = join(distDir, `Veydr-${version}-amd64.deb`)

/** Fails with a hint instead of a confusing error when the packages were not built. */
export function requirePackages(): void {
  for (const path of [unpackedBinary, appImagePath, debPath]) {
    if (!existsSync(path)) throw new Error(`${path} is missing: run \`npm run dist:linux\` (or \`npm run test:packaging\`) first`)
  }
}

/** The test runner's environment without anything that changes how Electron runs. */
export function cleanEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith('ELECTRON_') || key === 'NODE_OPTIONS' || key.startsWith('APPIMAGE')) continue
    env[key] = value
  }
  return { ...env, ...extra }
}

export interface RunResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

export function run(file: string, args: readonly string[], env: Readonly<Record<string, string>>, timeoutMs = 60_000, cwd?: string): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'], ...(cwd === undefined ? {} : { cwd }) })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk: Buffer) => (stderr += String(chunk)))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${file} did not exit within ${timeoutMs} ms; stderr: ${stderr.slice(-2000)}`))
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolvePromise({ code, signal, stdout, stderr })
    })
  })
}

/**
 * The report line of `--smoke-test`. Searched anywhere in a line: when the AppImage runtime
 * extracts itself it lists the files on stdout, and its last line has no line break.
 */
export function smokeReportOf(result: RunResult): SmokeReport {
  const line = result.stdout.split('\n').find((l) => l.includes(SMOKE_REPORT_PREFIX))
  if (line === undefined) throw new Error(`no smoke-test report (exit ${String(result.code)}); stderr: ${result.stderr.slice(-2000)}`)
  return JSON.parse(line.slice(line.indexOf(SMOKE_REPORT_PREFIX) + SMOKE_REPORT_PREFIX.length)) as SmokeReport
}

/** `libfuse.so.2` is what the AppImage runtime needs to mount itself. */
export function hasLibfuse2(): boolean {
  const out = spawnSync('ldconfig', ['-p'], { encoding: 'utf8' })
  return out.status === 0 && /\blibfuse\.so\.2\b/.test(out.stdout)
}

/**
 * Environment for running the AppImage: without `libfuse2` the runtime cannot mount the image, so
 * it extracts it to a temporary directory and runs it from there (same AppRun, same variables).
 */
export function appImageEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return cleanEnv(hasLibfuse2() ? extra : { APPIMAGE_EXTRACT_AND_RUN: '1', ...extra })
}

export interface ProcInfo {
  readonly pid: number
  readonly exe: string
  readonly cmdline: string[]
}

/** Processes of this user whose executable matches `accept`. */
export function findProcesses(accept: (info: ProcInfo) => boolean): ProcInfo[] {
  const found: ProcInfo[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const info = {
        pid: Number(name),
        exe: readlinkSync(`/proc/${name}/exe`),
        cmdline: readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter((a) => a !== ''),
      }
      if (accept(info)) found.push(info)
    } catch {
      // Exited, or another user's process.
    }
  }
  return found
}

/** Initial environment of a process (only meaningful for processes that do not rewrite their title). */
export function environOf(pid: number): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
    const eq = entry.indexOf('=')
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return env
}

export async function waitFor<T>(probe: () => T | null | undefined, timeoutMs: number, what: string): Promise<T> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== null && value !== undefined) return value
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}
