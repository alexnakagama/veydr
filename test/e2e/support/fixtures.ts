import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test'
import { collectNetworkReport, type NetworkReport } from './network'

export const repoRoot = resolve(__dirname, '../../..')
const netGuardPath = join(__dirname, 'net-guard.cjs')
/** Replaces the blocking native error dialog with a stderr line so fatal paths can be tested. */
export const noDialogPath = join(__dirname, 'no-dialog.cjs')

export type Build = 'out' | 'out-probe'

export interface LaunchOptions {
  readonly build?: Build
  readonly env?: Readonly<Record<string, string>>
  /** Reuse an existing `XDG_CONFIG_HOME` (e.g. to launch a second instance). */
  readonly configHome?: string
  /** Extra scripts loaded into the main process with `-r` before the app starts. */
  readonly preloads?: readonly string[]
}

export interface VeydrApp {
  readonly app: ElectronApplication
  readonly window: Page
  /** Value of `XDG_CONFIG_HOME`; the app's config directory is `<configHome>/Veydr`. */
  readonly configHome: string
  readonly workDir: string
  /** Closes the app and returns what the network observers saw. */
  close(): Promise<NetworkReport>
}

/** Directory to pass to Electron for a build; `out-probe` gets its own package.json. */
export function appDirFor(build: Build): string {
  if (build === 'out') return repoRoot
  const dir = join(repoRoot, build)
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'veydr', productName: 'Veydr', version: '0.0.0', main: 'main/index.js' }),
  )
  return dir
}

/** Environment for an app launch: the test runner's, minus anything that changes Electron's mode. */
export function appEnv(configHome: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith('ELECTRON_') || key === 'NODE_OPTIONS') continue
    env[key] = value
  }
  return { ...env, XDG_CONFIG_HOME: configHome, ...extra }
}

export async function launchVeydr(options: LaunchOptions = {}): Promise<VeydrApp> {
  const workDir = mkdtempSync(join(tmpdir(), 'veydr-e2e-'))
  const configHome = options.configHome ?? join(workDir, 'config')
  const nodeLog = join(workDir, 'node-net.jsonl')
  const netLog = join(workDir, 'netlog.json')

  const app = await electron.launch({
    // Playwright defaults to --no-sandbox for Electron; the OS sandbox is part of what is under test.
    chromiumSandbox: true,
    // Playwright drops NODE_OPTIONS, so the guard is preloaded with `-r` like its own loader.
    args: ['-r', netGuardPath, ...(options.preloads ?? []).flatMap((p) => ['-r', p]), appDirFor(options.build ?? 'out'), `--log-net-log=${netLog}`, '--net-log-capture-mode=Everything'],
    env: appEnv(configHome, {
      VEYDR_NET_GUARD_LOG: nodeLog,
      ...options.env,
    }),
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')

  return {
    app,
    window,
    configHome,
    workDir,
    async close() {
      await app.close()
      return collectNetworkReport(nodeLog, netLog)
    },
  }
}

export function expectNoOutboundConnections(report: NetworkReport): void {
  expect(report.guardInstalled, 'Node network guard was not loaded').toBe(true)
  expect(report.netLogPresent, 'Chromium net-log was not written').toBe(true)
  expect(report.attempts).toEqual([])
}

interface Fixtures {
  veydr: VeydrApp
  window: Page
}

/**
 * Every test using `veydr` runs under the no-network guard: on teardown the
 * app is closed and the test fails if any outbound connection was attempted.
 */
export const test = base.extend<Fixtures>({
  veydr: async ({}, use) => {
    const veydr = await launchVeydr()
    try {
      await use(veydr)
      expectNoOutboundConnections(await veydr.close())
    } finally {
      await veydr.app.close().catch(() => undefined)
      rmSync(veydr.workDir, { recursive: true, force: true })
    }
  },
  window: async ({ veydr }, use) => {
    await use(veydr.window)
  },
})

export { expect }
