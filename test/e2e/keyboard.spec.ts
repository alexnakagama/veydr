import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { fixture, killTagged, TAG_VARIABLE } from '../support/proc'
import { commandProcesses, expect, expectNoOutboundConnections, launchVeydr, test } from './support/fixtures'

// Task 6.8: everything reachable by keyboard alone, with shortcuts and confirmations.

const pickDirectoryPath = join(__dirname, 'support', 'pick-directory.cjs')

/** Presses Tab until the focused element's label (`aria-label`, its `<label>`, or its text) is `name`. */
async function tabTo(window: Page, name: string, maxPresses = 40): Promise<void> {
  for (let i = 0; i < maxPresses; i++) {
    await window.keyboard.press('Tab')
    const label = await window.evaluate(() => {
      const el = document.activeElement
      if (el === null) return ''
      const label = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.labels?.[0]?.textContent : null
      return (el.getAttribute('aria-label') ?? label ?? el.textContent ?? '').trim()
    })
    if (label === name) return
  }
  throw new Error(`"${name}" not reached with Tab`)
}

const focusedLabel = (window: Page): Promise<string> => window.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '')

test('a project and a command can be added, started, and stopped with the keyboard alone', async () => {
  const tag = crypto.randomUUID()
  const work = mkdtempSync(join(tmpdir(), 'veydr-e2e-keyboard-'))
  const shop = join(work, 'shop')
  mkdirSync(shop)
  const pickFile = join(work, 'pick.txt')
  writeFileSync(pickFile, shop)
  const veydr = await launchVeydr({ preloads: [pickDirectoryPath], env: { VEYDR_TEST_PICK_FILE: pickFile, [TAG_VARIABLE]: tag } })
  try {
    const { window } = veydr
    await expect(window.getByTestId('empty-projects')).toBeVisible()

    // Add project: the dialog opens with the name field focused; Enter confirms.
    await tabTo(window, 'Add project')
    await window.keyboard.press('Enter')
    const projectDialog = window.getByTestId('project-dialog')
    await expect(projectDialog.getByLabel('Project name', { exact: true })).toBeFocused()
    await window.keyboard.press('Enter')
    await expect(projectDialog).toHaveCount(0)
    await expect(window.getByTestId('project').getByRole('heading', { name: 'shop', exact: true })).toBeVisible()

    // Add command: name, executable, and its arguments, all typed.
    await tabTo(window, 'Add command to shop')
    await window.keyboard.press('Enter')
    const editor = window.getByTestId('command-editor')
    await expect(editor.getByLabel('Name', { exact: true })).toBeFocused()
    await window.keyboard.type('server')
    await tabTo(window, 'Executable')
    await window.keyboard.type(process.execPath)
    for (const [index, arg] of [fixture('inspect'), '--out', join(work, 'out.json'), '--stay'].entries()) {
      await tabTo(window, 'Add argument')
      await window.keyboard.press('Enter')
      await tabTo(window, `Argument ${index + 1}`)
      await window.keyboard.type(arg)
    }
    await window.keyboard.press('Enter')
    await expect(editor).toHaveCount(0)

    // Select the command by focusing its row, then start and stop it with shortcuts.
    const row = window.getByTestId('command')
    await tabTo(window, 'Start server')
    await expect(row).toHaveAttribute('aria-current', 'true')
    expect(await focusedLabel(window)).toBe('Start server')
    // A shortcut is ignored while the previous request of the command is still answered, as its buttons are.
    const stop = row.getByRole('button', { name: 'Stop server', exact: true })
    const start = row.getByRole('button', { name: 'Start server', exact: true })
    await window.keyboard.press('s')
    await expect(row.getByTestId('command-status')).toHaveText('Running')
    await expect(stop).toBeEnabled()
    expect(commandProcesses(veydr, tag)).toHaveLength(1)
    await window.keyboard.press('x')
    await expect(row.getByTestId('command-status')).toHaveText('Exited')
    await expect(start).toBeEnabled()
    expect(commandProcesses(veydr, tag)).toEqual([])
    await window.keyboard.press('s')
    await expect(row.getByTestId('command-status')).toHaveText('Running')
    await expect(stop).toBeEnabled()
    const before = await row.getByTestId('command-detail').textContent()
    await window.keyboard.press('r')
    // A new run (another PID) is running once the restart is done.
    await expect(row.getByTestId('command-detail')).toHaveText(/^PID \d+ · up/)
    await expect.poll(async () => ((await row.getByTestId('command-detail').textContent()) ?? '').split(' · ')[0]).not.toBe((before ?? '').split(' · ')[0])
    await expect(stop).toBeEnabled()
    await window.keyboard.press('x')
    await expect(row.getByTestId('command-status')).toHaveText('Exited')

    // Shortcut help, filter focus, project navigation.
    await window.keyboard.press('?')
    const help = window.getByTestId('shortcuts-dialog')
    await expect(help).toContainText('Start the selected command')
    await window.keyboard.press('Escape')
    await expect(help).toHaveCount(0)
    await window.keyboard.press('/')
    await expect(window.getByLabel('Filter projects', { exact: true })).toBeFocused()
    await window.keyboard.type('no such project')
    // Typing in the filter is text, not shortcuts.
    await expect(row).toHaveCount(0)
    await window.keyboard.press('Control+a')
    await window.keyboard.press('Backspace')
    await window.keyboard.press('Shift+Tab')
    await window.keyboard.press('j')
    await expect(window.getByTestId('project')).toBeFocused()

    // Removing is confirmed; Escape cancels, Cancel is focused first.
    await tabTo(window, 'Remove shop')
    await window.keyboard.press('Enter')
    const confirm = window.getByTestId('confirm-dialog')
    await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await window.keyboard.press('Escape')
    await expect(confirm).toHaveCount(0)
    await expect(window.getByTestId('project')).toHaveCount(1)

    expectNoOutboundConnections(await veydr.close())
  } finally {
    await veydr.app.close().catch(() => undefined)
    killTagged(tag)
    rmSync(veydr.workDir, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})
