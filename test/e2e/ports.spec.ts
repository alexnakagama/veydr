import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { Config } from '../../src/shared/config'
import { fixture, killTagged, readLedger, TAG_VARIABLE, taggedProcesses, type LedgerEntry } from '../support/proc'
import { expect, expectNoOutboundConnections, launchVeydr, test, type VeydrApp } from './support/fixtures'
import { seed } from './support/seed'

// Task 8.3: the ports view against real listeners, managed and not.

const PROJECT_ID = '7a2e9b5d-4d2f-4f66-8b8c-1e7e2a3c0b12'
const DEV_ID = '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01'
const NESTED_ID = '0b7c9f7e-2a64-4d1a-8f0e-5f7d8c9b1a22'
const probePath = join(__dirname, 'support/ports-probe.cjs')

interface Scene {
  readonly dir: string
  readonly tag: string
  readonly ledger: string
  readonly env: Record<string, string>
}

function scene(): Scene {
  const dir = mkdtempSync(join(tmpdir(), 'veydr-e2e-ports-'))
  const tag = crypto.randomUUID()
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  return { dir, tag, ledger: join(dir, 'ledger.jsonl'), env: { ...env, [TAG_VARIABLE]: tag } }
}

function seededConfig(s: Scene): Config {
  const env = [{ key: TAG_VARIABLE, value: s.tag, secret: false }]
  const listen = (args: readonly string[]) => ({ mode: 'direct' as const, file: process.execPath, args: [fixture('listen'), '--ledger', s.ledger, ...args] })
  return {
    schemaVersion: 1,
    projects: [
      {
        id: PROJECT_ID,
        name: 'fixtures',
        path: s.dir,
        commands: [
          { id: DEV_ID, name: 'dev', execution: listen(['--role', 'dev']), cwd: '.', env, stopTimeoutMs: 5000 },
          // Leader → intermediate → listener: the port is opened by a grandchild.
          { id: NESTED_ID, name: 'nested', execution: listen(['--role', 'nested', '--depth', '2']), cwd: '.', env, stopTimeoutMs: 5000 },
        ],
      },
    ],
    settings: { editor: null },
  }
}

/** Starts a listener outside Veydr (an unmanaged process). */
function startUnmanaged(s: Scene, role: string): void {
  spawn(process.execPath, [fixture('listen'), '--ledger', s.ledger, '--role', role], { env: s.env, stdio: 'ignore' })
}

async function recorded(s: Scene, role: string): Promise<LedgerEntry> {
  await expect.poll(() => readLedger(s.ledger).some((e) => e.role === role), { message: `${role} listening` }).toBe(true)
  const entry = readLedger(s.ledger).find((e) => e.role === role)
  if (entry?.port === undefined || entry.port === null) throw new Error(`${role} recorded no port`)
  return entry
}

const portRow = (window: Page, table: 'ports-managed-table' | 'ports-all-table', port: number): Locator =>
  window.getByTestId(table).locator(`[data-testid="port-row"][data-port="${port}"]`)

async function openPorts(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Ports', exact: true }).click()
  await expect(window.getByRole('heading', { level: 1, name: 'Ports' })).toBeVisible()
  await expect(window.getByTestId('ports-refreshed')).toBeVisible()
}

async function cleanup(veydr: VeydrApp | null, s: Scene, extra: readonly string[] = []): Promise<void> {
  await veydr?.app.close().catch(() => undefined)
  killTagged(s.tag)
  if (veydr !== null) rmSync(veydr.workDir, { recursive: true, force: true })
  for (const path of [s.dir, ...extra]) rmSync(path, { recursive: true, force: true })
}

test('[spec:port-inspection/dev-server-port-shown] [spec:port-inspection/port-opened-by-a-child-process] shows the ports of running commands, including one opened by a grandchild', async () => {
  const s = scene()
  const seeded = seed({ 'config.json': JSON.stringify(seededConfig(s)) })
  let veydr: VeydrApp | null = null
  try {
    veydr = await launchVeydr({ configHome: seeded.configHome })
    const { window } = veydr
    for (const [id, name] of [[DEV_ID, 'dev'], [NESTED_ID, 'nested']] as const) {
      const row = window.locator(`[data-command-id="${id}"]`)
      await row.getByRole('button', { name: `Start ${name}`, exact: true }).click()
      await expect(row.getByTestId('command-status')).toHaveText('Running')
    }
    const dev = await recorded(s, 'dev')
    const nested = await recorded(s, 'nested')
    // The nested listener is a grandchild of the command's leader.
    const leader = readLedger(s.ledger).find((e) => e.role === 'intermediate-2')
    const middle = readLedger(s.ledger).find((e) => e.role === 'intermediate-1')
    expect(middle?.ppid).toBe(leader?.pid)
    expect(nested.ppid).toBe(middle?.pid)

    await openPorts(window)
    const devRow = portRow(window, 'ports-managed-table', dev.port ?? 0)
    await expect(devRow).toHaveCount(1)
    await expect(devRow.getByTestId('port-command')).toHaveText('fixtures › dev')
    await expect(devRow.getByTestId('port-process')).toHaveText(`node PID ${dev.pid}`)
    await expect(devRow).toContainText('127.0.0.1')
    const nestedRow = portRow(window, 'ports-managed-table', nested.port ?? 0)
    await expect(nestedRow.getByTestId('port-command')).toHaveText('fixtures › nested')
    await expect(nestedRow.getByTestId('port-process')).toHaveText(`node PID ${nested.pid}`)
    // Both also appear in the list of all listeners, as managed.
    await expect(portRow(window, 'ports-all-table', dev.port ?? 0)).toHaveAttribute('data-managed', 'true')
    await expect(portRow(window, 'ports-all-table', nested.port ?? 0)).toHaveAttribute('data-managed', 'true')

    // Stopping a command removes its port at the next refresh.
    await window.getByRole('button', { name: 'Projects', exact: true }).click()
    const nestedCommand = window.locator(`[data-command-id="${NESTED_ID}"]`)
    await nestedCommand.getByRole('button', { name: 'Stop nested', exact: true }).click()
    await expect(nestedCommand.getByTestId('command-status')).toHaveText('Exited')
    await openPorts(window)
    await expect(portRow(window, 'ports-all-table', nested.port ?? 0)).toHaveCount(0)
    await expect(portRow(window, 'ports-managed-table', dev.port ?? 0)).toHaveCount(1)

    expectNoOutboundConnections(await veydr.close())
    expect(taggedProcesses(s.tag)).toEqual([])
  } finally {
    await cleanup(veydr, s, [seeded.root])
  }
})

test('[spec:port-inspection/unmanaged-listener-owned-by-user] [spec:port-inspection/no-actions-on-unrelated-processes] [spec:port-inspection/refresh] lists unmanaged listeners without actions and refreshes on demand and every 3 s', async () => {
  const s = scene()
  const reads = join(s.dir, 'port-reads.log')
  let veydr: VeydrApp | null = null
  try {
    veydr = await launchVeydr({ preloads: [probePath], env: { VEYDR_TEST_PORT_READS: reads } })
    const { window } = veydr
    const readCount = (): number => (existsSync(reads) ? readFileSync(reads, 'utf8').split('\n').filter(Boolean).length : 0)
    // Nothing is read until the view is opened.
    await expect(window.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible()
    expect(readCount()).toBe(0)

    await openPorts(window)
    const refreshed = window.getByTestId('ports-refreshed')
    const first = await refreshed.getAttribute('dateTime')

    // A listener started now appears by itself at the next periodic refresh (every 3 s).
    startUnmanaged(s, 'periodic')
    const periodic = await recorded(s, 'periodic')
    await expect(portRow(window, 'ports-all-table', periodic.port ?? 0)).toHaveCount(1, { timeout: 7_000 })
    expect(await refreshed.getAttribute('dateTime')).not.toBe(first)

    // A listener started now appears on Refresh, without waiting for the period.
    startUnmanaged(s, 'manual')
    const manual = await recorded(s, 'manual')
    const before = await refreshed.getAttribute('dateTime')
    const clicked = Date.now()
    await window.getByRole('button', { name: 'Refresh', exact: true }).click()
    const row = portRow(window, 'ports-all-table', manual.port ?? 0)
    await expect(row).toHaveCount(1, { timeout: 2_000 })
    expect(Date.now() - clicked).toBeLessThan(2_000)
    const after = await refreshed.getAttribute('dateTime')
    expect(after).not.toBe(before)
    expect(Date.parse(after ?? '')).toBeGreaterThanOrEqual(clicked - 1_000)

    // Not started by Veydr: PID and name, marked not managed, and no action of any kind.
    await expect(row).toHaveAttribute('data-managed', 'false')
    await expect(row.getByTestId('port-process')).toHaveText(`node PID ${manual.pid}`)
    await expect(row.getByTestId('port-command')).toHaveText('Not managed')
    await expect(row.locator('button, a, input, select, [role="button"], [role="menu"]')).toHaveCount(0)
    await expect(window.getByTestId('ports-managed-table')).toHaveCount(0)
    await row.click({ button: 'right' })
    await expect(window.getByRole('menu')).toHaveCount(0)

    // Requests happen only while the view is shown: none while another view is open…
    await window.getByRole('button', { name: 'Settings', exact: true }).click()
    await window.waitForTimeout(500)
    const settled = readCount()
    await window.waitForTimeout(4_000)
    expect(readCount()).toBe(settled)
    // …nor while the window is hidden; showing the view again refreshes at once.
    await window.getByRole('button', { name: 'Ports', exact: true }).click()
    await expect.poll(readCount).toBe(settled + 1)
    // (Hiding the window does not change its visibility state under every compositor, so the
    // change is simulated in the page.)
    const setVisibility = (state: 'hidden' | 'visible'): Promise<void> =>
      window.evaluate((next) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => next })
        document.dispatchEvent(new Event('visibilitychange'))
      }, state)
    await setVisibility('hidden')
    await window.waitForTimeout(500)
    const hidden = readCount()
    await window.waitForTimeout(4_000)
    expect(readCount()).toBe(hidden)
    await setVisibility('visible')
    await expect.poll(readCount).toBe(hidden + 1)

    expectNoOutboundConnections(await veydr.close())
  } finally {
    await cleanup(veydr, s)
  }
})

test('[spec:port-inspection/port-owned-by-another-user] shows a port whose owner is hidden from the user as restricted', async () => {
  const s = scene()
  let veydr: VeydrApp | null = null
  try {
    // The probe presents `restricted-listener` as a process of root: its open files are unreadable,
    // its status shows root's user IDs, and its socket is listed with uid 0.
    veydr = await launchVeydr({ preloads: [probePath] })
    startUnmanaged(s, 'restricted-listener')
    startUnmanaged(s, 'visible')
    const restricted = await recorded(s, 'restricted-listener')
    const visible = await recorded(s, 'visible')
    const { window } = veydr
    await openPorts(window)

    const row = portRow(window, 'ports-all-table', restricted.port ?? 0)
    await expect(row).toHaveAttribute('data-owner', 'restricted')
    await expect(row.getByTestId('port-process')).toHaveText('Restricted')
    await expect(row.getByTestId('port-process')).not.toContainText(String(restricted.pid))
    await expect(row.locator('button, a, input, select')).toHaveCount(0)
    await expect(portRow(window, 'ports-all-table', visible.port ?? 0)).toHaveAttribute('data-owner', 'known')
    await expect(window.getByText(/the port belongs to another user or to the system/)).toBeVisible()

    // Listeners of other users on this machine (e.g. a system print service), if any, are restricted too.
    const uid = process.geteuid?.() ?? -1
    const foreign = readFileSync('/proc/net/tcp', 'utf8')
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields[3] === '0A' && Number(fields[7]) !== uid)
      .map((fields) => Number.parseInt(fields[1]?.split(':')[1] ?? '', 16))
    for (const port of foreign) {
      await expect(window.getByTestId('ports-all-table').locator(`[data-port="${port}"][data-family="ipv4"]`).first()).toHaveAttribute('data-owner', 'restricted')
    }

    expectNoOutboundConnections(await veydr.close())
  } finally {
    await cleanup(veydr, s)
  }
})

test('the ports view is reachable by keyboard and its refresh time is announced as text', async () => {
  const s = scene()
  let veydr: VeydrApp | null = null
  try {
    veydr = await launchVeydr()
    const { window } = veydr
    await expect(window.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible()
    await window.keyboard.press('Tab')
    await window.keyboard.press('Tab')
    await expect(window.getByRole('button', { name: 'Ports', exact: true })).toBeFocused()
    await window.keyboard.press('Enter')
    await expect(window.getByRole('heading', { level: 1, name: 'Ports' })).toBeVisible()
    await expect(window.getByTestId('ports-status')).toContainText(/^Last refreshed \S+.* · refreshed every 3 s while this view is open$/)
    await window.keyboard.press('Tab')
    await expect(window.getByRole('button', { name: 'Settings', exact: true })).toBeFocused()
    expectNoOutboundConnections(await veydr.close())
  } finally {
    await cleanup(veydr, s)
  }
})
