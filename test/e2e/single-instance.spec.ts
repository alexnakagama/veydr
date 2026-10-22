import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { appDirFor, appEnv, expect, test } from './support/fixtures'

const electronBinary = createRequire(__filename)('electron') as string

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

function launchSecondInstance(configHome: string): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary, [appDirFor('out')], { env: appEnv(configHome), stdio: 'ignore' })
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

test('[spec:desktop-shell/second-launch-focuses-existing-instance] a second launch focuses the first window and exits', async ({
  veydr,
}) => {
  const configDir = join(veydr.configHome, 'Veydr')

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
  const result = await launchSecondInstance(veydr.configHome)
  const after = snapshot(configDir)

  expect(result).toEqual({ code: 0, signal: null })
  expect(after).toEqual(before)

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
