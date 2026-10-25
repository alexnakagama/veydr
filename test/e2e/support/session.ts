import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { fixture, readLedger, TAG_VARIABLE } from '../../support/proc'
import { expect } from './fixtures'

/** Test-only `-r` preload that answers the native folder picker (see `pick-directory.cjs`). */
export const pickDirectoryPath = join(__dirname, 'pick-directory.cjs')

export interface SessionOptions {
  /** The folder to register; the picker preload must return it (`VEYDR_TEST_PICK_FILE`). */
  readonly project: string
  /** Listener ledger; must lie outside `project`. */
  readonly ledger: string
  /** Value of `TAG_VARIABLE` given to both commands, so a test can find and kill them. */
  readonly tag: string
}

export interface SessionResult {
  /** The port the `web` command listened on. */
  readonly port: number
}

const command = (window: Page, name: string): Locator => window.getByTestId('command').filter({ has: window.getByText(name, { exact: true }) })

async function fillEnv(editor: Locator, tag: string): Promise<void> {
  await editor.getByRole('button', { name: 'Add variable', exact: true }).click()
  await editor.getByLabel('Variable 1 name', { exact: true }).fill(TAG_VARIABLE)
  await editor.getByLabel('Variable 1 value', { exact: true }).fill(tag)
}

/**
 * A full user session through the UI (spec desktop-shell "No outbound connections", config-storage
 * "Project directories untouched"): registers a project, renames it, adds a listening command and
 * a shell command that prints lines, edits the shell command, starts both, reads the output,
 * finds the listener's port in the Ports view, and stops both.
 */
export async function fullSession(window: Page, options: SessionOptions): Promise<SessionResult> {
  // Register and edit the project.
  await window.getByRole('button', { name: 'Add project', exact: true }).click()
  const dialog = window.getByTestId('project-dialog')
  await expect(dialog.getByTestId('project-dialog-path')).toHaveText(options.project)
  await dialog.getByLabel('Project name', { exact: true }).fill('session')
  await dialog.getByRole('button', { name: 'Add project', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await window.getByRole('button', { name: 'Rename session', exact: true }).click()
  await dialog.getByLabel('Project name', { exact: true }).fill('shop')
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click()
  await expect(window.getByTestId('project').getByRole('heading', { name: 'shop', exact: true })).toBeVisible()

  // A direct command that listens on a TCP port.
  await window.getByRole('button', { name: 'Add command to shop', exact: true }).click()
  const editor = window.getByTestId('command-editor')
  await editor.getByLabel('Name', { exact: true }).fill('web')
  await editor.getByLabel('Executable', { exact: true }).fill(process.execPath)
  const args = [fixture('listen'), '--ledger', options.ledger, '--role', 'web']
  for (const [index, value] of args.entries()) {
    await editor.getByRole('button', { name: 'Add argument', exact: true }).click()
    await editor.getByLabel(`Argument ${index + 1}`, { exact: true }).fill(value)
  }
  await fillEnv(editor, options.tag)
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toHaveCount(0)

  // A shell command that prints, then an edit of it.
  await window.getByRole('button', { name: 'Add command to shop', exact: true }).click()
  await editor.getByLabel('Name', { exact: true }).fill('worker')
  await editor.getByRole('radio', { name: 'Shell script', exact: true }).check()
  await editor.getByLabel('Script', { exact: true }).fill('echo first')
  await fillEnv(editor, options.tag)
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toHaveCount(0)
  await window.getByRole('button', { name: 'Edit worker', exact: true }).click()
  // A wrapping label's accessible name includes the textarea's current value ("Script echo first").
  await editor.getByRole('textbox', { name: /^Script/ }).fill('i=0; while true; do i=$((i+1)); echo "job $i done"; sleep 0.1; done')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toHaveCount(0)

  // Start both and read the output.
  for (const name of ['web', 'worker']) {
    const row = command(window, name)
    await row.getByRole('button', { name: `Start ${name}`, exact: true }).click()
    await expect(row.getByTestId('command-status')).toHaveText('Running')
  }
  await command(window, 'worker').locator('.command-name').click()
  const output = window.getByTestId('log-view')
  await expect(output.getByRole('heading', { name: 'Output — worker' })).toBeVisible()
  await expect(output.getByTestId('log-text').filter({ hasText: 'job 5 done' })).toHaveCount(1)

  // Find the listener's port.
  await expect.poll(() => readLedger(options.ledger).some((e) => e.role === 'web'), { message: 'web listening' }).toBe(true)
  const port = readLedger(options.ledger).find((e) => e.role === 'web')?.port
  if (port === undefined || port === null) throw new Error('web recorded no port')
  await window.getByRole('button', { name: 'Ports', exact: true }).click()
  const portRow = window.getByTestId('ports-managed-table').locator(`[data-testid="port-row"][data-port="${port}"]`)
  await expect(portRow.getByTestId('port-command')).toHaveText('shop › web')

  // Stop both.
  await window.getByRole('button', { name: 'Projects', exact: true }).click()
  for (const name of ['web', 'worker']) {
    const row = command(window, name)
    await row.getByRole('button', { name: `Stop ${name}`, exact: true }).click()
    await expect(row.getByTestId('command-status')).toHaveText('Exited')
  }
  return { port }
}
