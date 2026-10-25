import { randomBytes } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { contract } from '../../shared/api'
import type { PortInspector } from '../platform/types'

/** `veydr --smoke-test`: checks a build can run on this system, then exits (task 9.2). */
export const SMOKE_TEST_SWITCH = 'smoke-test'
/** Prefix of the one stdout line carrying the JSON report. */
export const SMOKE_REPORT_PREFIX = 'VEYDR_SMOKE_TEST '
export const SMOKE_TIMEOUT_MS = 30_000

/** What the hidden window showed after loading the bundled UI. */
export interface SmokeUi {
  readonly url: string
  /** Top-level keys of `window.veydr`. */
  readonly bridge: readonly string[]
  /** The React root rendered content. */
  readonly rendered: boolean
  /** Effective `webPreferences` of the window. */
  readonly sandbox: boolean
  readonly contextIsolation: boolean
  /** Whether asking the window to open DevTools opened them; `null` if not tried (unpackaged builds). */
  readonly devToolsOpened: boolean | null
}

export interface SmokeCheck {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

export interface SmokeReport {
  readonly result: 'pass' | 'fail'
  readonly packaged: boolean
  readonly appPath: string
  readonly checks: readonly SmokeCheck[]
}

export interface SmokeFs {
  mkdir(path: string): Promise<void>
  /** Creates a new file (fails if it exists). */
  writeNew(path: string, data: string): Promise<void>
  remove(path: string): Promise<void>
}

export const nodeSmokeFs: SmokeFs = {
  async mkdir(path) {
    await mkdir(path, { recursive: true, mode: 0o700 })
  },
  writeNew: (path, data) => writeFile(path, data, { flag: 'wx', mode: 0o600 }),
  remove: (path) => rm(path, { force: true }),
}

export interface SmokeDeps {
  readonly packaged: boolean
  readonly appPath: string
  /** Veydr's configuration directory (`app.getPath('userData')`, which throws if it cannot be created). */
  configDir(): string
  /** The selected platform implementation (named so to stay clear of the `.platform` lint rule). */
  readonly implementation: { readonly name: string; readonly supported: boolean; readonly portInspector: PortInspector }
  /** `--no-sandbox` on Veydr's command line (read before `app.enableSandbox()` removes it). */
  readonly noSandbox: boolean
  /** Loads the bundled UI in a hidden window and reports what it shows. */
  loadUi(): Promise<SmokeUi>
  readonly fs?: SmokeFs
  readonly timeoutMs?: number
}

/** API groups the preload must expose (design D3). */
const BRIDGE_GROUPS: readonly string[] = Object.keys(contract)

/**
 * Runs every check and reports each one. Nothing here reads or writes the configuration or the
 * run ledger, and no supervisor exists, so no command can start.
 */
export async function runSmokeTest(deps: SmokeDeps): Promise<SmokeReport> {
  const fs = deps.fs ?? nodeSmokeFs
  const checks: SmokeCheck[] = []
  const check = async (name: string, run: () => Promise<string> | string): Promise<void> => {
    try {
      checks.push({ name, ok: true, detail: await run() })
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  // Veydr refuses to run without the sandbox, so nothing else is checked then.
  if (deps.noSandbox) {
    return { result: 'fail', packaged: deps.packaged, appPath: deps.appPath, checks: [{ name: 'process-sandbox', ok: false, detail: 'started with --no-sandbox' }] }
  }
  checks.push({ name: 'process-sandbox', ok: true, detail: 'no --no-sandbox switch' })

  const work = async (): Promise<void> => {

    // The directory is created as the app would create it; only a uniquely named probe file is
    // written and removed, never config.json or the ledger.
    await check('config-dir-writable', async () => {
      const dir = deps.configDir()
      await fs.mkdir(dir)
      const probe = join(dir, `.smoke-test-${randomBytes(6).toString('hex')}`)
      await fs.writeNew(probe, 'veydr smoke test\n')
      await fs.remove(probe)
      return dir
    })
    // Chromium keeps its profile there too; without it the window cannot be loaded meaningfully.
    if (checks.at(-1)?.ok !== true) return

    await check('platform', async () => {
      const { name, supported, portInspector } = deps.implementation
      if (!supported) throw new Error(`no platform implementation for ${name}`)
      // A read-only use of the implementation: the listening sockets from /proc.
      const snapshot = await portInspector.list()
      return `${name}: ${snapshot.ports.length} listening sockets readable`
    })

    let ui: SmokeUi | null = null
    await check('ui-loaded', async () => {
      ui = await deps.loadUi()
      if (!ui.rendered) throw new Error(`${ui.url} loaded but the interface did not render`)
      return ui.url
    })
    const loaded = ui as SmokeUi | null
    if (loaded !== null) {
      await check('preload-bridge', () => {
        const missing = BRIDGE_GROUPS.filter((group) => !loaded.bridge.includes(group))
        const extra = loaded.bridge.filter((group) => !BRIDGE_GROUPS.includes(group))
        if (missing.length > 0 || extra.length > 0) throw new Error(`window.veydr groups: missing [${missing.join(', ')}], unexpected [${extra.join(', ')}]`)
        return loaded.bridge.join(', ')
      })
      await check('renderer-isolation', () => {
        if (!loaded.sandbox || !loaded.contextIsolation) throw new Error(`sandbox=${String(loaded.sandbox)} contextIsolation=${String(loaded.contextIsolation)}`)
        return 'sandbox and context isolation on'
      })
      if (deps.packaged) {
        await check('devtools-disabled', () => {
          if (loaded.devToolsOpened !== false) throw new Error(loaded.devToolsOpened === null ? 'not checked' : 'DevTools opened in a packaged build')
          return 'DevTools did not open when requested'
        })
      }
    }
  }

  const timeoutMs = deps.timeoutMs ?? SMOKE_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  const outcome = await Promise.race([work().then(() => 'done' as const), timedOut])
  clearTimeout(timer)
  if (outcome === 'timeout') checks.push({ name: 'timeout', ok: false, detail: `not finished within ${timeoutMs} ms` })

  return {
    result: checks.every((c) => c.ok) ? 'pass' : 'fail',
    packaged: deps.packaged,
    appPath: deps.appPath,
    checks: checks.slice(),
  }
}

export function formatSmokeReport(report: SmokeReport): string {
  return `${SMOKE_REPORT_PREFIX}${JSON.stringify(report)}`
}
