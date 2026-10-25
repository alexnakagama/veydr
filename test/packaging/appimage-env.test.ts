import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appImageEnv, appImagePath, cleanEnv, findProcesses, repoRoot, requirePackages, run, waitFor } from './support'

const PROJECT_ID = '3c1e0d7a-9b2f-4e5d-8a6c-7f1e2d3c4b5a'
const COMMAND_ID = '4d2f1e8b-0c3a-4f6e-9b7d-8a2f3e4d5c6b'
/** Inside the AppImage the launcher adds these; outside it they were unset. */
const LAUNCHER_ONLY = ['LD_LIBRARY_PATH', 'GSETTINGS_SCHEMA_DIR']
const RUNTIME_VARIABLES = ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'CHROME_DESKTOP', 'NO_AT_BRIDGE']
const LAUNCH_DATA_DIRS = '/usr/local/share:/usr/share'

/** Matches entries inside an AppImage's mount point or extraction directory. */
const APPIMAGE_DIR = /^\/tmp\/(\.mount_Veydr[^/]*|appimage_extracted_[^/]+)(\/|$)/

/**
 * Starts the AppImage with a seeded command, starts the command through the UI's API over the
 * Chromium debugging port, and returns the environment the command reported. `shell` is the
 * user's login shell (`$SHELL`); a missing one makes Veydr fall back to its own environment.
 */
async function observe(work: string, shell: string): Promise<Record<string, string>> {
  const project = join(work, 'project')
  const out = join(work, 'env.json')
  const home = join(work, 'home')
  const configHome = join(work, 'config')
  mkdirSync(project, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(join(configHome, 'Veydr'), { recursive: true, mode: 0o700 })
  writeFileSync(
    join(configHome, 'Veydr/config.json'),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          id: PROJECT_ID,
          name: 'appimage',
          path: project,
          commands: [
            {
              id: COMMAND_ID,
              name: 'inspect',
              execution: { mode: 'direct', file: process.execPath, args: [join(repoRoot, 'test/fixtures/proc/inspect.mjs'), '--out', out] },
              cwd: '.',
              env: [],
              stopTimeoutMs: 5000,
            },
          ],
        },
      ],
      settings: { editor: null },
    }),
    { mode: 0o600 },
  )

  const env = appImageEnv({ XDG_CONFIG_HOME: configHome, HOME: home, SHELL: shell, XDG_DATA_DIRS: LAUNCH_DATA_DIRS })
  for (const key of LAUNCHER_ONLY) delete env[key]
  const app = spawn(appImagePath, ['--remote-debugging-port=0'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  app.stderr.on('data', (chunk: Buffer) => (stderr += String(chunk)))
  const exited = new Promise<void>((resolve) => app.once('exit', () => resolve()))
  const isVeydr = (exe: string): boolean => /\/(\.mount_Veydr[^/]*|appimage_extracted_[^/]+)\/veydr$/.test(exe)
  try {
    const port = await waitFor(
      () => {
        const file = join(configHome, 'Veydr/DevToolsActivePort')
        return existsSync(file) ? Number(readFileSync(file, 'utf8').split('\n')[0]) || null : null
      },
      60_000,
      `the debugging port (stderr: ${stderr.slice(-500)})`,
    )
    // The port opens before the window exists, and the page may be listed before its preload ran.
    const until = Date.now() + 30_000
    let page: { url: string; webSocketDebuggerUrl: string } | undefined
    while (page === undefined) {
      const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { url: string; webSocketDebuggerUrl: string }[]
      page = pages.find((p) => p.url === 'app://veydr/index.html')
      if (page === undefined && Date.now() > until) throw new Error(`no Veydr page in ${JSON.stringify(pages)}`)
      if (page === undefined) await new Promise((r) => setTimeout(r, 100))
    }
    while ((await evaluate(page.webSocketDebuggerUrl, `document.readyState === 'complete' && typeof window.veydr === 'object'`)) !== true) {
      if (Date.now() > until) throw new Error('the Veydr API did not appear in the page')
      await new Promise((r) => setTimeout(r, 100))
    }
    const started = await evaluate(page.webSocketDebuggerUrl, `window.veydr.processes.start({ commandId: ${JSON.stringify(COMMAND_ID)} })`)
    expect(started).toMatchObject({ ok: true })
    return await waitFor(() => (existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as { env: Record<string, string> }).env : null), 30_000, 'the command report')
  } finally {
    // Veydr stops what it runs on SIGTERM and exits; the AppImage runtime then exits as well.
    for (const p of findProcesses((info) => isVeydr(info.exe) && !info.cmdline.some((a) => a.startsWith('--type=')))) process.kill(p.pid, 'SIGTERM')
    await Promise.race([exited, new Promise((r) => setTimeout(r, 20_000))])
    if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL')
  }
}

/** Evaluates `expression` in the page through the Chrome DevTools Protocol and returns its value. */
async function evaluate(url: string, expression: string): Promise<unknown> {
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('DevTools connection failed')), { once: true })
  })
  try {
    return await new Promise((resolve, reject) => {
      socket.addEventListener('message', (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: unknown }; exceptionDetails?: unknown } }
        if (message.id !== 1) return
        if (message.result?.exceptionDetails !== undefined) reject(new Error(JSON.stringify(message.result.exceptionDetails)))
        else resolve(message.result?.result?.value)
      })
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    })
  } finally {
    socket.close()
  }
}

/** Variables with an entry inside an AppImage directory. */
function appImageEntries(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([, value]) => value.split(':').some((entry) => APPIMAGE_DIR.test(entry)))
    .map(([key]) => key)
}

/**
 * What the package's own launcher (`AppRun`) hands to Veydr, observed with a stand-in `veydr` that
 * records its environment. The AppImage runtime exports APPDIR (also APPIMAGE, ARGV0, and OWD when
 * mounted) before running AppRun; the real Veydr cannot be observed this way, because Chromium
 * clears its processes' /proc/<pid>/environ.
 */
async function launcherEnvironment(work: string, launch: Record<string, string>): Promise<Record<string, string>> {
  const extracted = join(work, 'extract')
  mkdirSync(extracted, { recursive: true })
  const result = await run(appImagePath, ['--appimage-extract', 'AppRun'], cleanEnv(), 60_000, extracted)
  expect(result.code).toBe(0)
  const appDir = join(work, 'AppDir')
  mkdirSync(appDir, { recursive: true })
  copyFileSync(join(extracted, 'squashfs-root/AppRun'), join(appDir, 'AppRun'))
  const dump = join(work, 'launcher-env')
  writeFileSync(join(appDir, 'veydr'), `#!/bin/sh\nenv -0 > ${JSON.stringify(dump)}\n`, { mode: 0o755 })
  const ran = await run(join(appDir, 'AppRun'), [], { ...launch, APPDIR: appDir }, 30_000)
  expect(ran.code).toBe(0)
  const env: Record<string, string> = {}
  for (const entry of readFileSync(dump, 'utf8').split('\0')) {
    const eq = entry.indexOf('=')
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return env
}

let work: string
beforeAll(() => {
  requirePackages()
  work = mkdtempSync(join(tmpdir(), 'veydr-appimage-env-'))
})
afterAll(() => rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

describe('environment of commands started inside the AppImage (task 9.3)', () => {
  it("the launcher does change Veydr's environment (control)", async () => {
    const launch = cleanEnv({ XDG_DATA_DIRS: LAUNCH_DATA_DIRS })
    for (const key of LAUNCHER_ONLY) delete launch[key]
    const seen = await launcherEnvironment(join(work, 'launcher'), launch)
    const appDir = join(work, 'launcher/AppDir')
    expect(seen['APPDIR']).toBe(appDir)
    expect(seen['PATH']).toBe(`${appDir}:${appDir}/usr/sbin:${launch['PATH'] ?? ''}`)
    expect(seen['LD_LIBRARY_PATH']).toBe(`${appDir}/usr/lib`)
    expect(seen['GSETTINGS_SCHEMA_DIR']).toBe(`${appDir}/usr/share/glib-2.0/schemas`)
    expect(seen['XDG_DATA_DIRS']).toBe(`${appDir}/usr/share/:${LAUNCH_DATA_DIRS}:/usr/share/gnome:/usr/local/share/:/usr/share/`)
  })

  it('[spec:project-registry/runtime-variables-not-leaked] fallback environment: exactly the launch environment, none of the AppImage variables', async () => {
    const child = await observe(join(work, 'fallback'), '/nonexistent/veydr-test-shell')
    expect(Object.keys(child).filter((key) => key.startsWith('ELECTRON_') || RUNTIME_VARIABLES.includes(key))).toEqual([])
    expect(appImageEntries(child)).toEqual([])
    for (const key of LAUNCHER_ONLY) expect(child[key], key).toBeUndefined()
    expect(child['PATH']).toBe(process.env['PATH'])
    expect(child['XDG_DATA_DIRS']).toBe(LAUNCH_DATA_DIRS)
  })

  it('[spec:project-registry/runtime-variables-not-leaked] login-shell environment: none of the AppImage variables', async () => {
    const child = await observe(join(work, 'login'), '/bin/sh')
    expect(Object.keys(child).filter((key) => key.startsWith('ELECTRON_') || RUNTIME_VARIABLES.includes(key))).toEqual([])
    expect(appImageEntries(child)).toEqual([])
    for (const key of LAUNCHER_ONLY) expect(child[key], key).toBeUndefined()
    expect(child['XDG_DATA_DIRS']?.endsWith(':/usr/share/gnome:/usr/local/share/:/usr/share/') ?? false).toBe(false)
  })
})
