import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { shortcuts } from '../../src/renderer/src/shortcuts'
import type { Config } from '../../src/shared/config'
import { fixture, killTagged, TAG_VARIABLE } from '../support/proc'
import { expect, expectNoOutboundConnections, launchVeydr, test } from './support/fixtures'
import { seed } from './support/seed'

// Task 10.3: accessibility and keyboard pass over every view and dialog: every control has an
// accessible name, Tab reaches controls in document order with a visible focus indicator, focus
// stays inside an open dialog, and the shortcut help lists every shortcut.

const PROJECT_ID = '7a2e9b5d-4d2f-4f66-8b8c-1e7e2a3c0b12'

function seededConfig(dir: string, tag: string): Config {
  const env = [
    { key: TAG_VARIABLE, value: tag, secret: false },
    { key: 'API_TOKEN', value: 'a11y-secret-value', secret: true },
  ]
  return {
    schemaVersion: 1,
    projects: [
      {
        id: PROJECT_ID,
        name: 'shop',
        path: dir,
        commands: [
          { id: '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01', name: 'web', execution: { mode: 'direct', file: process.execPath, args: [fixture('listen'), '--ledger', join(dir, 'ledger.jsonl')] }, cwd: '.', env, stopTimeoutMs: 5000 },
          { id: '0b7c9f7e-2a64-4d1a-8f0e-5f7d8c9b1a22', name: 'worker', execution: { mode: 'shell', shell: '/bin/sh', script: 'while true; do echo "\u001b[32mok\u001b[0m"; sleep 0.2; done' }, cwd: '.', env, stopTimeoutMs: 5000 },
        ],
      },
      { id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', name: 'blog', path: join(dir, 'missing'), commands: [] },
    ],
    settings: { editor: null },
  }
}

/** Interactive roles in the accessibility tree that have no accessible name. */
async function unnamedControls(scope: Locator): Promise<string[]> {
  const snapshot = await scope.ariaSnapshot()
  // Named controls are listed as `- button "Name"`; an empty tree would make the check vacuous.
  expect(snapshot).toMatch(/^\s*- button "/m)
  return snapshot
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^- (button|link|textbox|combobox|checkbox|radio|searchbox|spinbutton|slider|switch|tab|menuitem|option)\b(?! ")/.test(line))
}

interface Stop {
  readonly name: string
  readonly outline: string
  readonly shadow: string
  readonly visible: boolean
  readonly index: number
  readonly inDialog: boolean
}

/** The focused element: a description, its focus indicator, and its position in document order. */
const focused = (window: Page): Promise<Stop | null> =>
  window.evaluate(() => {
    const el = document.activeElement
    if (el === null || el === document.body) return null
    const style = getComputedStyle(el)
    const box = el.getBoundingClientRect()
    const all = [...document.querySelectorAll('*')]
    return {
      name: `${el.tagName.toLowerCase()}[${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}]`,
      outline: style.outlineStyle === 'none' ? 'none' : `${style.outlineStyle} ${style.outlineWidth}`,
      shadow: style.boxShadow,
      visible: box.width > 0 && box.height > 0,
      index: all.indexOf(el),
      inDialog: el.closest('dialog[open]') !== null,
    }
  })

/** Presses `key` (Tab or Shift+Tab) until focus comes back to the first stop; returns every stop once. */
async function tabCycle(window: Page, key = 'Tab', maxPresses = 120): Promise<Stop[]> {
  const stops: Stop[] = []
  for (let i = 0; i < maxPresses; i++) {
    await window.keyboard.press(key)
    const stop = await focused(window)
    if (stop === null) continue
    if (stops.length > 0 && stop.index === stops[0]?.index) return stops
    stops.push(stop)
  }
  throw new Error(`focus did not cycle within ${maxPresses} presses: ${stops.map((s) => s.name).join(', ')}`)
}

/** Every stop shows a focus indicator and is visible; the order follows the document. */
function expectGoodFocus(stops: readonly Stop[]): void {
  expect(stops.length).toBeGreaterThan(0)
  for (const stop of stops) {
    expect.soft(stop.visible, `${stop.name} is visible when focused`).toBe(true)
    expect.soft(stop.outline !== 'none' || stop.shadow !== 'none', `${stop.name} shows a focus indicator`).toBe(true)
  }
  // The cycle starts wherever focus was; rotate it to start at the first element in the document.
  const first = stops.reduce((min, s, i) => (s.index < (stops[min]?.index ?? Infinity) ? i : min), 0)
  const cycle = [...stops.slice(first), ...stops.slice(0, first)]
  const indexes = cycle.map((s) => s.index)
  expect(indexes, cycle.map((s) => s.name).join(' → ')).toEqual([...indexes].sort((a, b) => a - b))
}

async function audit(window: Page, what: string, dialog?: Locator): Promise<void> {
  // Let the focus indicator reflect keyboard use (`:focus-visible`).
  await window.keyboard.press('Shift')
  expect(await unnamedControls(dialog ?? window.locator('body')), `${what}: controls without a name`).toEqual([])
  const stops = await tabCycle(window)
  if (dialog !== undefined) expect(stops.every((s) => s.inDialog), `${what}: focus stays in the dialog`).toBe(true)
  expectGoodFocus(stops)
  // Shift+Tab visits the same stops in exactly the reverse order.
  const back = await tabCycle(window, 'Shift+Tab')
  const last = back.reduce((max, s, i) => (s.index > (back[max]?.index ?? -1) ? i : max), 0)
  const reversed = [...back.slice(last), ...back.slice(0, last)].map((s) => s.index)
  expect(reversed, `${what}: Shift+Tab order`).toEqual(stops.map((s) => s.index).sort((a, b) => b - a))
}

test('every view and dialog has named controls, document-order focus, and a visible focus indicator', async () => {
  test.setTimeout(120_000)
  const dir = mkdtempSync(join(tmpdir(), 'veydr-e2e-a11y-'))
  const tag = crypto.randomUUID()
  const config = seededConfig(dir, tag)
  // A damaged primary file shows the recovery notice (with Dismiss) as well.
  const seeded = seed({ 'config.json': '{', 'config.json.bak': JSON.stringify(config) })
  const veydr = await launchVeydr({ configHome: seeded.configHome })
  try {
    const { window } = veydr
    await expect(window.getByTestId('notice')).toHaveCount(1)
    for (const name of ['web', 'worker']) {
      await window.getByRole('button', { name: `Start ${name}`, exact: true }).click()
    }
    await expect(window.getByTestId('command-status')).toHaveText(['Running', 'Running'])
    await window.locator('.command-name', { hasText: 'worker' }).click()
    await expect(window.getByTestId('log-line').first()).toBeVisible()

    // A command line too long for its row scrolls, so it is a focus stop; it has a name.
    await expect(window.getByRole('group', { name: 'Command line of web', exact: true })).toBeVisible()
    await audit(window, 'Projects with output')

    await window.getByRole('button', { name: 'Edit web', exact: true }).click()
    const editor = window.getByTestId('command-editor')
    await audit(window, 'Command editor', editor)
    // With validation errors shown.
    await editor.getByLabel('Name', { exact: true }).fill('')
    await editor.getByLabel('Working directory (relative to the project folder)', { exact: true }).fill('../elsewhere')
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(editor.getByTestId('editor-error')).toBeVisible()
    await expect(editor.getByTestId('editor-error')).toHaveAttribute('role', 'alert')
    await audit(window, 'Command editor with errors', editor)
    await window.keyboard.press('Escape')

    await window.getByRole('button', { name: 'Remove worker', exact: true }).click()
    await audit(window, 'Command removal confirmation', window.getByTestId('confirm-dialog'))
    await window.keyboard.press('Escape')

    await window.getByRole('button', { name: 'Environment of web', exact: true }).click()
    // The table (with the secret's Reveal button) replaces "Reading the environment…" once it is read.
    await expect(window.getByTestId('environment-table')).toBeVisible()
    await audit(window, 'Environment', window.getByTestId('environment-dialog'))
    await window.keyboard.press('Escape')

    await window.getByRole('button', { name: 'Remove shop', exact: true }).click()
    await audit(window, 'Project removal confirmation', window.getByTestId('confirm-dialog'))
    await window.keyboard.press('Escape')

    await window.getByRole('button', { name: 'Keyboard shortcuts (?)' }).click()
    const help = window.getByTestId('shortcuts-dialog')
    await audit(window, 'Shortcut help', help)
    // The help lists every shortcut with its key.
    for (const shortcut of shortcuts) await expect(help.getByText(shortcut.description, { exact: true })).toBeVisible()
    await expect(help.locator('kbd')).toHaveText(shortcuts.map((s) => s.key))
    await window.keyboard.press('Escape')

    for (const view of ['Ports', 'Settings', 'About']) {
      await window.getByRole('button', { name: view, exact: true }).click()
      await expect(window.getByRole('heading', { level: 1, name: view })).toBeVisible()
      if (view === 'Ports') await expect(window.getByTestId('ports-refreshed')).toBeVisible()
      // The editor form replaces "Loading…" once the settings arrive; audit the loaded view.
      if (view === 'Settings') await expect(window.getByLabel('Editor executable', { exact: true })).toBeVisible()
      await audit(window, view)
    }

    await window.getByRole('button', { name: 'Projects', exact: true }).click()
    for (const name of ['web', 'worker']) await window.getByRole('button', { name: `Stop ${name}`, exact: true }).click()
    await expect(window.getByTestId('command-status')).toHaveText(['Exited', 'Exited'])
    expectNoOutboundConnections(await veydr.close())
  } finally {
    await veydr.app.close().catch(() => undefined)
    killTagged(tag)
    rmSync(veydr.workDir, { recursive: true, force: true })
    rmSync(seeded.root, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})
