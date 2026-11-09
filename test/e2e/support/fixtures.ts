import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test'
import { selectPlatform } from '../../../src/main/platform'
import type { AppInfo, PlatformName } from '../../../src/shared/api'
import { commandLines, type ProcessView, taggedProcesses } from '../../support/processes'
import { collectNetworkReport, type NetworkReport } from './network'
import { removeDir, tempDir } from './temp'

export const repoRoot = resolve(__dirname, '../../..')
/** The Electron executable the suite launches. */
const electronExecutable = createRequire(__filename)('electron') as string
const netGuardPath = join(__dirname, 'net-guard.cjs')
/** Replaces the blocking native error dialog with a stderr line so fatal paths can be tested. */
export const noDialogPath = join(__dirname, 'no-dialog.cjs')
/**
 * Keeps the configuration directory below `XDG_CONFIG_HOME` on every system (see the file). Every
 * Electron a test starts loads it with `-r`; `launchVeydr` does so itself.
 */
export const configHomePath = join(__dirname, 'config-home.cjs')

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
  const workDir = tempDir('veydr-e2e-')
  const configHome = options.configHome ?? join(workDir, 'config')
  const nodeLog = join(workDir, 'node-net.jsonl')
  const netLog = join(workDir, 'netlog.json')

  const app = await electron.launch({
    // Playwright defaults to --no-sandbox for Electron; the OS sandbox is part of what is under test.
    chromiumSandbox: true,
    // Playwright drops NODE_OPTIONS, so the guard is preloaded with `-r` like its own loader.
    args: ['-r', netGuardPath, '-r', configHomePath, ...(options.preloads ?? []).flatMap((p) => ['-r', p]), appDirFor(options.build ?? 'out'), `--log-net-log=${netLog}`, '--net-log-capture-mode=Everything'],
    env: appEnv(configHome, {
      VEYDR_NET_GUARD_LOG: nodeLog,
      ...options.env,
    }),
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  // The configuration really is the test's own (config-home.cjs): never the user's or the runner's.
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  if (userData !== join(configHome, 'Veydr')) {
    await app.close().catch(() => undefined)
    removeDir(workDir)
    throw new Error(`the app's configuration directory is ${userData}, not below the test's ${configHome}`)
  }

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

/**
 * Tagged processes other than Veydr's own, for tests that launch Veydr itself with the tag so its
 * commands inherit it. Veydr's main process is left out by PID, and Chromium's helper processes
 * (renderer, GPU, utility, crash handler) as processes of Electron's own executable started with a
 * `--type=` switch: they inherit the tag too, and whether their environment can be read varies by
 * system (on Linux the sandboxed ones are not readable, on Windows they are). A command's own
 * `--type=` argument does not hide it, since a command does not run Electron's executable.
 */
export function commandProcesses(veydr: VeydrApp, tag: string): ProcessView[] {
  const main = veydr.app.process().pid
  const tagged = taggedProcesses(tag).filter((p) => p.pid !== main)
  const lines = commandLines(tagged.map((p) => p.pid))
  // A process that exited since it was listed has no command line, and is no longer one of them.
  return tagged.filter((p) => {
    const line = lines.get(p.pid)
    if (line === undefined) return false
    return !(line.toLowerCase().includes(electronExecutable.toLowerCase()) && /(?:^|\s)--type=/.test(line))
  })
}

/** The platform the composition root selects on this system, read independently of the running app. */
export const hostPlatform: PlatformName = selectPlatform().name

/**
 * What the running app reports about its platform (`app.getInfo`). Tests read values that differ by
 * system from here, such as the platform label or the default shell, instead of branching.
 */
export async function appInfo(window: Page): Promise<AppInfo> {
  const result = await window.evaluate(() => globalThis.window.veydr.app.getInfo())
  if (!result.ok) throw new Error(`app.getInfo failed: ${result.error.message}`)
  return result.value
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
      removeDir(veydr.workDir)
    }
  },
  window: async ({ veydr }, use) => {
    await use(veydr.window)
  },
})

export { expect }
