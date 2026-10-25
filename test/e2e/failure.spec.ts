import { spawn } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SMOKE_REPORT_PREFIX, type SmokeReport } from '../../src/main/app/smoke'
import { appEnv, expect, launchVeydr, noDialogPath, repoRoot, test } from './support/fixtures'
import { seed } from './support/seed'

const electronBinary = createRequire(__filename)('electron') as string

test('a crashed renderer is reported and the app exits with an error', async () => {
  const veydr = await launchVeydr({ preloads: [noDialogPath] })
  const stderr: string[] = []
  const child = veydr.app.process()
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(String(chunk)))
  const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
  try {
    await veydr.app
      .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer())
      .catch(() => undefined)
    expect(await exit).toBe(1)
    const output = stderr.join('')
    expect(output).toContain('window.renderer-gone')
    expect(output).toContain('ERRORBOX Veydr cannot continue')
  } finally {
    rmSync(veydr.workDir, { recursive: true, force: true })
  }
})

test('an incomplete installation (renderer bundle missing) is reported and exits with an error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veydr-e2e-broken-'))
  try {
    cpSync(join(repoRoot, 'out/main'), join(dir, 'app/main'), { recursive: true })
    cpSync(join(repoRoot, 'out/preload'), join(dir, 'app/preload'), { recursive: true })
    writeFileSync(join(dir, 'app/package.json'), JSON.stringify({ name: 'veydr', version: '0.0.0', main: 'main/index.js' }))
    // The main bundle requires `zod` at runtime; `electron` is provided by the binary.
    cpSync(join(repoRoot, 'node_modules/zod'), join(dir, 'app/node_modules/zod'), { recursive: true })

    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(electronBinary, ['-r', noDialogPath, join(dir, 'app')], {
        env: appEnv(join(dir, 'config')),
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let output = ''
      child.stderr.on('data', (chunk: Buffer) => (output += String(chunk)))
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`did not exit; stderr so far: ${output}`))
      }, 20_000)
      child.once('exit', (code) => {
        clearTimeout(timer)
        resolve({ code, output })
      })
    })
    expect(result.code).toBe(1)
    expect(result.output).toContain('app.fatal')
    expect(result.output).toContain('renderer bundle missing')
  } finally {
    // Chromium helper processes may still write into the profile briefly after the main process exited.
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

/** Runs the built app with `args` (after the app directory) until it exits. */
function runBuiltApp(args: readonly string[], configHome: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary, ['-r', noDialogPath, repoRoot, ...args], {
      env: appEnv(configHome),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk: Buffer) => (stderr += String(chunk)))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`did not exit; stderr so far: ${stderr}`))
    }, 40_000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

test('refuses to run with --no-sandbox (task 9.4): explains why and exits with an error before reading the configuration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veydr-e2e-nosandbox-'))
  try {
    const result = await runBuiltApp(['--no-sandbox'], join(dir, 'config'))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('ERRORBOX Veydr cannot start: Veydr was started with --no-sandbox')
    expect(result.stderr).toContain('app.no-sandbox-refused')
    expect(existsSync(join(dir, 'config/Veydr/config.json'))).toBe(false)
    expect(existsSync(join(dir, 'config/Veydr/runtime'))).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('--smoke-test (task 9.2) passes for the built app, leaves the configuration untouched, and starts no command', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'veydr-e2e-smoke-project-'))
  const marker = join(projectDir, 'started')
  const config = {
    schemaVersion: 1,
    projects: [
      {
        id: '5f0c2b1e-7d4a-4c3b-9e8f-1a2b3c4d5e6f',
        name: 'smoke',
        path: projectDir,
        commands: [
          {
            id: '6a1d3c2f-8e5b-4d4c-8f9a-2b3c4d5e6f70',
            name: 'marker',
            execution: { mode: 'direct', file: '/usr/bin/touch', args: [marker] },
            cwd: '.',
            env: [],
            stopTimeoutMs: 5000,
          },
        ],
      },
    ],
    settings: { editor: null },
  }
  const seeded = seed({ 'config.json': JSON.stringify(config) })
  const configFile = join(seeded.configDir, 'config.json')
  const before = readFileSync(configFile)
  try {
    const result = await runBuiltApp(['--smoke-test'], seeded.configHome)
    const line = result.stdout.split('\n').find((l) => l.startsWith(SMOKE_REPORT_PREFIX))
    expect(line, result.stderr).toBeDefined()
    const report = JSON.parse((line ?? '').slice(SMOKE_REPORT_PREFIX.length)) as SmokeReport
    expect(report.result).toBe('pass')
    expect(report.packaged).toBe(false)
    expect(report.checks.map((c) => c.name)).toEqual(['process-sandbox', 'config-dir-writable', 'platform', 'ui-loaded', 'preload-bridge', 'renderer-isolation'])
    expect(result.code).toBe(0)
    expect(readFileSync(configFile).equals(before)).toBe(true)
    expect(readdirSync(seeded.configDir).filter((name) => name.startsWith('config') || name.startsWith('.smoke-test') || name === 'runtime')).toEqual(['config.json'])
    expect(existsSync(marker)).toBe(false)
  } finally {
    rmSync(seeded.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('--smoke-test fails at once with --no-sandbox', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veydr-e2e-smoke-nosandbox-'))
  try {
    const result = await runBuiltApp(['--smoke-test', '--no-sandbox'], join(dir, 'config'))
    const line = result.stdout.split('\n').find((l) => l.startsWith(SMOKE_REPORT_PREFIX)) ?? ''
    const report = JSON.parse(line.slice(SMOKE_REPORT_PREFIX.length)) as SmokeReport
    expect(report).toMatchObject({ result: 'fail', checks: [{ name: 'process-sandbox', ok: false }] })
    expect(report.checks).toHaveLength(1)
    expect(result.code).toBe(1)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('--smoke-test fails when the configuration directory cannot be written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veydr-e2e-smoke-ro-'))
  const configDir = join(dir, 'config/Veydr')
  try {
    mkdirSync(configDir, { recursive: true })
    chmodSync(configDir, 0o500)
    const result = await runBuiltApp(['--smoke-test'], join(dir, 'config'))
    // Chromium cannot take the single-instance lock there, so the check never gets to run.
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('the configuration directory is not writable')
    expect(result.stdout).not.toContain(SMOKE_REPORT_PREFIX)
  } finally {
    chmodSync(configDir, 0o700)
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
