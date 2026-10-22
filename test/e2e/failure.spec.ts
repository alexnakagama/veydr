import { spawn } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appEnv, expect, launchVeydr, noDialogPath, repoRoot, test } from './support/fixtures'

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
    rmSync(dir, { recursive: true, force: true })
  }
})
