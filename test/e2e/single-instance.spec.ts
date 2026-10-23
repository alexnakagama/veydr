import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { appDirFor, appEnv, expect, test } from './support/fixtures'

const electronBinary = createRequire(__filename)('electron') as string
/** Records Node `fs` calls on paths inside a directory (see the file header). */
const fsGuardPath = join(__dirname, 'support', 'fs-guard.cjs')

interface FsGuardEntry {
  readonly api: string
  readonly path: string | null
  readonly kind?: string
}

function readFsGuardLog(logPath: string): FsGuardEntry[] {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as FsGuardEntry)
}

/** Every entry under `dir` with its size and modification time. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      const st = statSync(full, { throwIfNoEntry: false })
      if (st === undefined) continue
      out[full.slice(dir.length)] = `${entry.isDirectory() ? 'd' : 'f'}:${st.size}:${st.mtimeMs}`
      if (entry.isDirectory()) walk(full)
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

function launchSecondInstance(
  configHome: string,
  guard: { dir: string; log: string },
): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary, ['-r', fsGuardPath, appDirFor('out')], {
      env: appEnv(configHome, { VEYDR_FS_GUARD_DIR: guard.dir, VEYDR_FS_GUARD_LOG: guard.log }),
      stdio: 'ignore',
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('second instance did not exit within 15 s'))
    }, 15_000)
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

test('the fs guard records configuration access (control for the single-instance check)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veydr-fs-guard-'))
  try {
    const configFile = join(dir, 'config.json')
    writeFileSync(configFile, '{}')
    const log = join(dir, 'guard.jsonl')
    const script = [
      "const fs = require('node:fs')",
      `fs.readFileSync(${JSON.stringify(configFile)})`,
      `fs.promises.writeFile(${JSON.stringify(configFile)}, '{}').then(() => fs.stat(${JSON.stringify(configFile)}, () => {}))`,
    ].join(';')
    const run = spawnSync(process.execPath, ['-r', fsGuardPath, '-e', script], {
      env: { ...process.env, VEYDR_FS_GUARD_DIR: dir, VEYDR_FS_GUARD_LOG: log },
    })
    expect(run.status).toBe(0)
    const [installed, ...calls] = readFsGuardLog(log)
    expect(installed).toMatchObject({ api: 'guard', kind: 'installed' })
    // Some APIs call others internally (readFileSync → openSync), so only inclusion is asserted.
    expect(calls.map((e) => e.api)).toEqual(expect.arrayContaining(['fs.readFileSync', 'fs.promises.writeFile', 'fs.stat']))
    expect(new Set(calls.map((e) => e.path))).toEqual(new Set([configFile]))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[spec:desktop-shell/second-launch-focuses-existing-instance] [spec:config-storage/concurrent-instance-prevented] a second launch focuses the first window and exits without touching configuration', async ({
  veydr,
}) => {
  const configDir = join(veydr.configHome, 'Veydr')
  // The first instance created its configuration before showing the window.
  expect(existsSync(join(configDir, 'config.json'))).toBe(true)

  // The window shows itself on `ready-to-show`; wait for that before hiding it.
  await expect
    .poll(() => veydr.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
    .toBe(true)

  // Hide the first window and count show/focus calls, so bringing it back is observable.
  // (Hiding rather than minimizing: Wayland compositors do not report minimized state.)
  await veydr.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win === undefined) throw new Error('no window')
    const state = globalThis as unknown as { __calls: { show: number; focus: number } }
    state.__calls = { show: 0, focus: 0 }
    const show = win.show.bind(win)
    const focus = win.focus.bind(win)
    win.show = () => {
      state.__calls.show += 1
      show()
    }
    win.focus = () => {
      state.__calls.focus += 1
      focus()
    }
    win.hide()
  })
  await expect
    .poll(() => veydr.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
    .toBe(false)

  // Let the first instance settle so the snapshot only reflects the second launch.
  await veydr.window.waitForTimeout(1500)
  const before = snapshot(configDir)
  const guardLog = join(veydr.workDir, 'fs-guard.jsonl')
  const result = await launchSecondInstance(veydr.configHome, { dir: configDir, log: guardLog })
  const after = snapshot(configDir)

  expect(result).toEqual({ code: 0, signal: null })
  // Nothing in the configuration directory changed, and the second process
  // made no Node fs call on any path inside it (reads included).
  expect(after).toEqual(before)
  expect(readFsGuardLog(guardLog).map(({ api, path, kind }) => ({ api, path, kind }))).toEqual([
    { api: 'guard', path: null, kind: 'installed' },
  ])

  await expect
    .poll(() =>
      veydr.app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        const state = globalThis as unknown as { __calls: { show: number; focus: number } }
        return { visible: win?.isVisible(), calls: state.__calls }
      }),
    )
    .toEqual({ visible: true, calls: { show: 1, focus: 1 } })
  expect(await veydr.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
})
