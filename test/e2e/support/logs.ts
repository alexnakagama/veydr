import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { CommandConfig, Config } from '../../../src/shared/config'
import { killTagged, TAG_VARIABLE } from '../../support/proc'
import { expect, expectNoOutboundConnections, launchVeydr, type VeydrApp } from './fixtures'
import { seed, type Seeded } from './seed'

export const PROJECT_ID = '7a2e9b5d-4d2f-4f66-8b8c-1e7e2a3c0b12'

export type CommandSpec = Omit<CommandConfig, 'cwd' | 'stopTimeoutMs' | 'env'> & { readonly env?: CommandConfig['env'] }

export interface LogHarness {
  readonly veydr: VeydrApp
  readonly window: Page
  readonly work: string
  readonly seeded: Seeded
  readonly tag: string
  /** Selects the command (its output is shown) and starts it. */
  readonly start: (commandId: string, name: string) => Promise<void>
  /** The output view. */
  readonly view: Locator
  /** Rendered line texts, in order (only the rows currently rendered by the virtual list). */
  readonly renderedTexts: () => Promise<string[]>
  /**
   * Runs `action` and returns the plain text Veydr put on the clipboard for it, as seen by a
   * `copy` event listener in the window. The desktop clipboard itself is shared with the user's
   * session (a clipboard manager may replace its content at any time), so it is not read.
   */
  readonly copied: (action: () => Promise<void>) => Promise<string>
  /** Number of `copy` events in the window since the last navigation. */
  readonly copyEvents: () => Promise<number>
}

/** A shell-mode command run by `/bin/sh -c`. */
export const sh = (id: string, name: string, script: string, env: CommandConfig['env'] = []): CommandSpec => ({ id, name, execution: { mode: 'shell', shell: '/bin/sh', script }, env })

/** Launches Veydr with one project whose commands carry the scenario tag, runs `body`, and cleans up. */
export async function withLogs(commands: readonly CommandSpec[], body: (h: LogHarness) => Promise<void | 'closed'>, options: { configHome?: string } = {}): Promise<void> {
  const tag = crypto.randomUUID()
  const work = mkdtempSync(join(tmpdir(), 'veydr-e2e-logs-'))
  const config: Config = {
    schemaVersion: 1,
    projects: [
      {
        id: PROJECT_ID,
        name: 'logs',
        path: work,
        commands: commands.map((c) => ({ ...c, cwd: '.', stopTimeoutMs: 2000, env: [{ key: TAG_VARIABLE, value: tag, secret: false }, ...(c.env ?? [])] })),
      },
    ],
    settings: { editor: null },
  }
  const seeded = seed({ 'config.json': JSON.stringify(config) })
  const veydr = await launchVeydr({ configHome: options.configHome ?? seeded.configHome })
  const { window } = veydr
  const view = window.getByTestId('log-view')
  // Copying in the tests writes the desktop clipboard; the user's text is restored afterwards.
  const savedClipboard = await veydr.app.evaluate(({ clipboard }) => clipboard.readText())
  const hookCopies = (): Promise<void> =>
    window.evaluate(() => {
      const g = globalThis as unknown as { __copies?: string[] }
      if (g.__copies !== undefined) return
      const copies: string[] = []
      g.__copies = copies
      // Runs after Veydr's own handlers, which set the data and prevent the default action.
      globalThis.addEventListener('copy', (event) => copies.push(event.clipboardData?.getData('text/plain') ?? ''))
    })
  try {
    const outcome = await body({
      veydr,
      window,
      work,
      seeded,
      tag,
      view,
      async start(commandId, name) {
        const row = window.locator(`[data-command-id="${commandId}"]`)
        await row.locator('.command-name').click()
        await row.getByRole('button', { name: `Start ${name}`, exact: true }).click()
        await expect(row.getByTestId('command-status')).not.toHaveText('Idle')
      },
      renderedTexts: () => view.getByTestId('log-text').allTextContents(),
      async copied(action) {
        await hookCopies()
        const before = await window.evaluate(() => (globalThis as unknown as { __copies: string[] }).__copies.length)
        await action()
        await expect.poll(() => window.evaluate(() => (globalThis as unknown as { __copies: string[] }).__copies.length)).toBe(before + 1)
        return window.evaluate(() => (globalThis as unknown as { __copies: string[] }).__copies.at(-1) ?? '')
      },
      async copyEvents() {
        await hookCopies()
        return window.evaluate(() => (globalThis as unknown as { __copies: string[] }).__copies.length)
      },
    })
    if (outcome !== 'closed') {
      await veydr.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard)
      expectNoOutboundConnections(await veydr.close())
    }
  } finally {
    await veydr.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard).catch(() => undefined)
    await veydr.app.close().catch(() => undefined)
    killTagged(tag)
    rmSync(veydr.workDir, { recursive: true, force: true })
    rmSync(seeded.root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
}
