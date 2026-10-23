import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { declaredOperations } from '../../src/shared/api/channels'
import { expect, expectNoOutboundConnections, launchVeydr, repoRoot, test } from './support/fixtures'

const APP_URL = 'app://veydr/index.html'

test('[spec:desktop-shell/renderer-has-no-node-js-access] renderer has no Node.js globals', async ({ window }) => {
  const globals = await window.evaluate(() => {
    const g = globalThis as Record<string, unknown>
    return {
      require: typeof g['require'],
      process: typeof g['process'],
      module: typeof g['module'],
      exports: typeof g['exports'],
      Buffer: typeof g['Buffer'],
      global: typeof g['global'],
      setImmediate: typeof g['setImmediate'],
    }
  })
  expect(globals).toEqual({
    require: 'undefined',
    process: 'undefined',
    module: 'undefined',
    exports: 'undefined',
    Buffer: 'undefined',
    global: 'undefined',
    setImmediate: 'undefined',
  })
})

test('[spec:desktop-shell/renderer-cannot-load-arbitrary-modules] module loading fails in the renderer', async ({
  window,
}) => {
  const outcome = await window.evaluate(async () => {
    const attempts: Record<string, string> = {}
    for (const specifier of ['node:fs', 'electron', 'node:child_process']) {
      try {
        await import(/* @vite-ignore */ specifier)
        attempts[specifier] = 'loaded'
      } catch {
        attempts[specifier] = 'failed'
      }
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- deliberate: eval must be blocked by CSP
      ;(new Function('return 1') as () => number)()
      attempts['eval'] = 'allowed'
    } catch {
      attempts['eval'] = 'blocked'
    }
    return attempts
  })
  expect(outcome).toEqual({ 'node:fs': 'failed', electron: 'failed', 'node:child_process': 'failed', eval: 'blocked' })
})

test('[spec:desktop-shell/navigation-blocked] navigation away from bundled content is prevented', async ({
  veydr,
  window,
}) => {
  for (const target of ['https://example.invalid/', 'file:///etc/passwd', 'app://other/index.html']) {
    await window.evaluate((url) => {
      globalThis.location.href = url
    }, target)
    await window.waitForTimeout(300)
    expect(window.url()).toBe(APP_URL)
  }
  // The anchor route is blocked the same way.
  await window.evaluate(() => {
    const a = document.createElement('a')
    a.href = 'https://example.invalid/'
    document.body.append(a)
    a.click()
  })
  await window.waitForTimeout(300)
  expect(window.url()).toBe(APP_URL)
  expect(await veydr.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
})

test('[spec:desktop-shell/new-window-denied] window.open creates no window', async ({ veydr, window }) => {
  const opened = await window.evaluate(() => {
    const results = [globalThis.open('app://veydr/index.html'), globalThis.open('https://example.invalid/', '_blank')]
    return results.map((w) => w === null)
  })
  expect(opened).toEqual([true, true])
  await window.waitForTimeout(300)
  expect(await veydr.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  expect(veydr.app.windows()).toHaveLength(1)
})

test('[spec:desktop-shell/inline-script-blocked] inline scripts and handlers do not execute', async ({ window }) => {
  const executed = await window.evaluate(async () => {
    const flags = globalThis as Record<string, unknown>
    const violations: string[] = []
    document.addEventListener('securitypolicyviolation', (e) => violations.push(e.effectiveDirective))
    const script = document.createElement('script')
    script.textContent = 'globalThis.__inlineRan = true'
    document.body.append(script)

    const holder = document.createElement('div')
    holder.innerHTML = '<img src="data:," onerror="globalThis.__handlerRan = true">'
    document.body.append(holder)

    const remote = document.createElement('script')
    remote.src = 'https://example.invalid/x.js'
    document.body.append(remote)

    await new Promise((r) => setTimeout(r, 300))
    return {
      inline: flags['__inlineRan'] === true,
      handler: flags['__handlerRan'] === true,
      violations: [...new Set(violations)].sort(),
    }
  })
  // Blocked by the CSP header, not by accident: each attempt reports a violation.
  expect(executed).toEqual({
    inline: false,
    handler: false,
    violations: ['script-src-attr', 'script-src-elem'],
  })
})

test('permission requests are denied', async ({ window }) => {
  const results = await window.evaluate(async () => {
    const notification = await Notification.requestPermission()
    let media = 'granted'
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      media = 'denied'
    }
    let geolocation = 'granted'
    await new Promise<void>((done) =>
      navigator.geolocation.getCurrentPosition(
        () => done(),
        () => {
          geolocation = 'denied'
          done()
        },
        { timeout: 2000 },
      ),
    )
    return { notification, media, geolocation }
  })
  expect(results).toEqual({ notification: 'denied', media: 'denied', geolocation: 'denied' })
})

test('[spec:desktop-shell/only-declared-operations-are-available] window.veydr exposes only declared operations', async ({
  window,
}) => {
  const surface = await window.evaluate(() => {
    const api = globalThis.window.veydr as unknown as Record<string, unknown>
    const out: Record<string, Record<string, string>> = {}
    for (const group of Object.keys(api)) {
      const members = api[group] as Record<string, unknown>
      out[group] = Object.fromEntries(Object.keys(members).map((k) => [k, typeof members[k]]))
    }
    return out
  })
  const expected = Object.fromEntries(
    Object.entries(declaredOperations).map(([group, ops]) => [group, Object.fromEntries(ops.map((op) => [op, 'function']))]),
  )
  expect(surface).toEqual(expected)

  const forbidden = /invoke|send|emit|channel|exec|spawn|run|readFile|writeFile|require/i
  for (const [group, ops] of Object.entries(surface)) {
    for (const op of Object.keys(ops)) expect(`${group}.${op}`).not.toMatch(forbidden)
  }

  const result = await window.evaluate(() => globalThis.window.veydr.app.getInfo())
  expect(result.ok).toBe(true)

  // Event subscriptions hand back an idempotent unsubscribe function.
  const unsubscribe = await window.evaluate(() => {
    const off = globalThis.window.veydr.processes.onState(() => undefined)
    const type = typeof off
    off()
    off()
    return type
  })
  expect(unsubscribe).toBe('function')

  // Operations of later task groups answer with a typed error, not a rejected promise.
  const pending = await window.evaluate(() => globalThis.window.veydr.ports.list())
  expect(pending).toEqual({ ok: false, error: { code: 'not_implemented', message: 'ports.list is not implemented yet' } })
  const invalid = await window.evaluate(() =>
    globalThis.window.veydr.processes.start({ commandId: 'not-a-uuid' }),
  )
  expect(invalid).toMatchObject({ ok: false, error: { code: 'validation' } })
})

test('the Chromium sandbox is active for every process (not launched with --no-sandbox)', async ({ veydr }) => {
  const mainArgv = await veydr.app.evaluate(() => process.argv)
  expect(mainArgv).not.toContain('--no-sandbox')

  const processes = await veydr.app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ type: m.type, pid: m.pid })))
  const cmdlines = processes.map((p) => ({
    type: p.type,
    // Chromium child processes rewrite their title, so match on the whole command line.
    cmdline: readFileSync(`/proc/${p.pid}/cmdline`, 'utf8').replaceAll('\0', ' '),
  }))
  expect(cmdlines.some((p) => p.cmdline.includes('--type=renderer'))).toBe(true)
  for (const p of cmdlines) expect(p.cmdline, `${p.type} process`).not.toContain('--no-sandbox')

  const prefs = await veydr.app.evaluate(({ BrowserWindow }) => {
    // `getLastWebPreferences` is real but absent from Electron's type definitions.
    const contents = BrowserWindow.getAllWindows()[0]?.webContents as unknown as
      | { getLastWebPreferences(): Record<string, unknown> }
      | undefined
    const p = contents?.getLastWebPreferences() ?? {}
    return { sandbox: p['sandbox'], contextIsolation: p['contextIsolation'], nodeIntegration: p['nodeIntegration'], webviewTag: p['webviewTag'] }
  })
  expect(prefs).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false })
})

test('[spec:desktop-shell/request-from-unexpected-origin-rejected] IPC from another window is rejected and logged', async ({
  veydr,
}) => {
  const stderr: string[] = []
  veydr.app.process().stderr?.on('data', (chunk: Buffer) => stderr.push(String(chunk)))

  // A second window showing our own bundled content with our preload is still not the application window.
  const result = await veydr.app.evaluate(
    async ({ BrowserWindow }, preloadPath) => {
      const win = new BrowserWindow({
        show: false,
        webPreferences: { preload: preloadPath, sandbox: true, contextIsolation: true },
      })
      try {
        await win.loadURL('app://veydr/index.html')
        return (await win.webContents.executeJavaScript('window.veydr.app.getInfo()')) as unknown
      } finally {
        win.destroy()
      }
    },
    join(repoRoot, 'out/preload/index.js'),
  )
  expect(result).toEqual({ ok: false, error: { code: 'forbidden', message: 'Request rejected: unexpected sender' } })
  await expect.poll(() => stderr.join('')).toContain('ipc.rejected-sender')

  // The legitimate window is unaffected.
  expect((await veydr.window.evaluate(() => globalThis.window.veydr.app.getInfo())).ok).toBe(true)
})

test('target=_blank links, <webview> elements, and form posts open nothing and navigate nowhere', async ({
  veydr,
  window,
}) => {
  const contentsBefore = await veydr.app.evaluate(({ webContents }) => webContents.getAllWebContents().length)
  await window.evaluate(() => {
    const a = document.createElement('a')
    a.href = 'https://example.invalid/'
    a.target = '_blank'
    document.body.append(a)
    a.click()

    document.body.append(document.createElement('webview'))

    const form = document.createElement('form')
    form.method = 'post'
    form.action = 'https://example.invalid/post'
    document.body.append(form)
    form.requestSubmit?.()
  })
  await window.waitForTimeout(500)
  expect(window.url()).toBe(APP_URL)
  expect(await veydr.app.evaluate(({ webContents }) => webContents.getAllWebContents().length)).toBe(contentsBefore)
  expect(await veydr.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
})

test('a dev-server URL in the environment is ignored by non-dev builds', async () => {
  const veydr = await launchVeydr({ env: { ELECTRON_RENDERER_URL: 'http://127.0.0.1:9/' } })
  try {
    expect(veydr.window.url()).toBe(APP_URL)
    expect((await veydr.window.evaluate(() => globalThis.window.veydr.app.getInfo())).ok).toBe(true)
    expectNoOutboundConnections(await veydr.close())
  } finally {
    rmSync(veydr.workDir, { recursive: true, force: true })
  }
})
