import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { Config } from '../../src/shared/config'
import { fixture, isAlive, killTagged, readProcess, TAG_VARIABLE, waitUntil } from '../support/proc'
import { commandProcesses, expect, expectNoOutboundConnections, launchVeydr, test, type VeydrApp } from './support/fixtures'
import { seed } from './support/seed'

// Tasks 6.4–6.6: the command editor, secrets, the effective environment, and the editor launch.

const PROJECT_ID = '7a2e9b5d-4d2f-4f66-8b8c-1e7e2a3c0b12'

interface Harness {
  readonly veydr: VeydrApp
  readonly window: Page
  readonly work: string
  readonly shop: string
  readonly tag: string
  readonly config: () => Config
}

/**
 * Launches Veydr with one empty project, a temporary HOME whose bash login profile adds to PATH
 * and sets a variable (the login environment), and `SHELL=/bin/bash`. Electron runs with an
 * extra `ELECTRON_*` variable that must never reach a command.
 */
async function withVeydr(run: (h: Harness) => Promise<void | 'closed'>, settings: Config['settings'] = { editor: null }): Promise<void> {
  const tag = crypto.randomUUID()
  const work = mkdtempSync(join(tmpdir(), 'veydr-e2e-commands-'))
  const home = join(work, 'home')
  mkdirSync(join(home, 'bin'), { recursive: true })
  writeFileSync(join(home, '.bash_profile'), 'echo "login banner"\nexport PATH="$HOME/bin:$PATH"\nexport VEYDR_FROM_LOGIN=yes\n')
  const shop = join(work, 'shop')
  mkdirSync(shop)
  const config: Config = { schemaVersion: 1, projects: [{ id: PROJECT_ID, name: 'shop', path: shop, commands: [] }], settings }
  const seeded = seed({ 'config.json': JSON.stringify(config) })
  const veydr = await launchVeydr({
    configHome: seeded.configHome,
    env: { HOME: home, SHELL: '/bin/bash', [TAG_VARIABLE]: tag, ELECTRON_VEYDR_TEST_LEAK: '1' },
  })
  try {
    const outcome = await run({ veydr, window: veydr.window, work, shop, tag, config: () => JSON.parse(readFileSync(join(seeded.configDir, 'config.json'), 'utf8')) as Config })
    if (outcome !== 'closed') expectNoOutboundConnections(await veydr.close())
  } finally {
    await veydr.app.close().catch(() => undefined)
    killTagged(tag)
    rmSync(veydr.workDir, { recursive: true, force: true })
    rmSync(seeded.root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
}

test('[spec:project-registry/secret-masked-by-default] a secret is masked in the editor and the environment until revealed, with the plaintext-storage disclosure shown', async () => {
  await withVeydr(async ({ window, config }) => {
    await window.getByRole('button', { name: 'Add command to shop', exact: true }).click()
    const editor = window.getByTestId('command-editor')
    await expect(editor.getByTestId('secret-disclosure')).toContainText('stores them unencrypted in its configuration file')
    await editor.getByLabel('Name', { exact: true }).fill('api')
    await editor.getByLabel('Executable', { exact: true }).fill('node')
    await editor.getByRole('button', { name: 'Add variable', exact: true }).click()
    await editor.getByLabel('Variable 1 name', { exact: true }).fill('API_TOKEN')
    await editor.getByRole('checkbox', { name: 'Secret', exact: true }).check()
    await expect(editor.getByLabel('Variable 1 value', { exact: true })).toHaveAttribute('type', 'password')
    await editor.getByLabel('Variable 1 value', { exact: true }).fill('hunter2-secret')
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(editor).toHaveCount(0)
    expect(config().projects[0]?.commands[0]?.env).toEqual([{ key: 'API_TOKEN', value: 'hunter2-secret', secret: true }])

    // The secret never reached the page: not in the DOM, not in the project list.
    expect(await window.content()).not.toContain('hunter2-secret')

    await window.getByRole('button', { name: 'Edit api', exact: true }).click()
    const reopened = window.getByTestId('command-editor')
    const value = reopened.getByLabel('Variable 1 value', { exact: true })
    await expect(value).toHaveAttribute('type', 'password')
    await expect(value).toHaveValue('')
    await expect(value).toHaveAttribute('placeholder', 'unchanged (hidden)')
    await expect(reopened.getByTestId('secret-disclosure')).toBeVisible()
    await reopened.getByRole('button', { name: 'Reveal variable 1', exact: true }).click()
    await expect(value).toHaveAttribute('type', 'text')
    await expect(value).toHaveValue('hunter2-secret')
    await reopened.getByRole('button', { name: 'Cancel', exact: true }).click()

    await window.getByRole('button', { name: 'Environment of api', exact: true }).click()
    const environment = window.getByTestId('environment-dialog')
    const entry = environment.locator('[data-testid="environment-entry"][data-key="API_TOKEN"]')
    await expect(entry.getByTestId('environment-value')).toHaveText('••••••••')
    await entry.getByRole('button', { name: 'Reveal API_TOKEN', exact: true }).click()
    await expect(entry.getByTestId('environment-value')).toHaveText('hunter2-secret')
    await environment.getByRole('button', { name: 'Close', exact: true }).click()
  })
})

test('[spec:config-storage/limitation-disclosed] marking a variable secret shows that it is stored unencrypted and that masking and redaction are best effort', async () => {
  await withVeydr(async ({ window }) => {
    await window.getByRole('button', { name: 'Add command to shop', exact: true }).click()
    const editor = window.getByTestId('command-editor')
    await editor.getByRole('button', { name: 'Add variable', exact: true }).click()
    await editor.getByLabel('Variable 1 name', { exact: true }).fill('API_TOKEN')
    await editor.getByRole('checkbox', { name: 'Secret', exact: true }).check()
    const storage = editor.getByTestId('secret-disclosure')
    const redaction = editor.getByTestId('secret-redaction-note')
    await expect(storage).toBeVisible()
    await expect(storage).toHaveAttribute('role', 'note')
    await expect(storage).toContainText('masked here (best effort) and only shown when you reveal them')
    await expect(storage).toContainText('Veydr stores them unencrypted in its configuration file')
    await expect(redaction).toBeVisible()
    await expect(redaction).toContainText('its output shows [redacted] instead. This is best effort')
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  })
})

test('[spec:project-registry/shell-mode-labelled] [spec:project-registry/working-directory-outside-project-rejected] labels shell commands with their shell and rejects a working directory outside the project', async () => {
  await withVeydr(async ({ window, config }) => {
    await window.getByRole('button', { name: 'Add command to shop', exact: true }).click()
    const editor = window.getByTestId('command-editor')
    await editor.getByLabel('Name', { exact: true }).fill('dev')
    await editor.getByRole('radio', { name: 'Shell script', exact: true }).check()
    await expect(editor.getByTestId('editor-shell-label')).toHaveText('Shell command — runs through /bin/sh')
    await editor.getByLabel('Shell', { exact: true }).fill('/bin/bash')
    await expect(editor.getByTestId('editor-shell-label')).toHaveText('Shell command — runs through /bin/bash')
    await editor.getByLabel('Script', { exact: true }).fill('echo "$HOME" | cat')
    await editor.getByLabel('Working directory (relative to the project folder)', { exact: true }).fill('../elsewhere')
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(editor.getByTestId('editor-error')).toContainText('The working directory "../elsewhere" is outside the project folder')
    await editor.getByLabel('Working directory (relative to the project folder)', { exact: true }).fill('.')
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(editor).toHaveCount(0)

    const row = window.getByTestId('command')
    await expect(row.getByTestId('command-shell-label')).toHaveText('Shell: /bin/bash')
    await expect(row.getByTestId('command-line')).toHaveText('echo "$HOME" | cat')
    expect(config().projects[0]?.commands[0]?.execution).toEqual({ mode: 'shell', shell: '/bin/bash', script: 'echo "$HOME" | cat' })
  })
})

test('[spec:project-registry/desktop-launch-resolves-login-path] [spec:project-registry/runtime-variables-not-leaked] [spec:project-registry/override-applied] a started command gets the login environment with overrides, no runtime variables, and only descriptors 0–2', async () => {
  await withVeydr(async ({ veydr, window, work, tag }) => {
    const out = join(work, 'env.json')
    await window.getByRole('button', { name: 'Add command to shop', exact: true }).click()
    let editor = window.getByTestId('command-editor')
    await editor.getByLabel('Name', { exact: true }).fill('inspect')
    await editor.getByLabel('Executable', { exact: true }).fill(process.execPath)
    for (const [index, arg] of [fixture('inspect'), '--out', out].entries()) {
      await editor.getByRole('button', { name: 'Add argument', exact: true }).click()
      await editor.getByLabel(`Argument ${index + 1}`, { exact: true }).fill(arg)
    }
    await editor.getByRole('button', { name: 'Add variable', exact: true }).click()
    await editor.getByLabel('Variable 1 name', { exact: true }).fill('VEYDR_FROM_LOGIN')
    await editor.getByLabel('Variable 1 value', { exact: true }).fill('overridden')
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(editor).toHaveCount(0)

    await window.getByRole('button', { name: 'Add command to shop', exact: true }).click()
    editor = window.getByTestId('command-editor')
    await editor.getByLabel('Name', { exact: true }).fill('fds')
    await editor.getByLabel('Executable', { exact: true }).fill('sleep')
    await editor.getByRole('button', { name: 'Add argument', exact: true }).click()
    await editor.getByLabel('Argument 1', { exact: true }).fill('60')
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(editor).toHaveCount(0)

    await window.getByRole('button', { name: 'Start inspect', exact: true }).click()
    await window.getByRole('button', { name: 'Start fds', exact: true }).click()
    const sleeper = window.getByTestId('command').filter({ has: window.getByText('fds', { exact: true }) })
    await expect(sleeper.getByTestId('command-status')).toHaveText('Running')
    const pid = Number(/^PID (\d+)/.exec((await sleeper.getByTestId('command-detail').textContent()) ?? '')?.[1])
    const report = (): { env: Record<string, string> } | null => {
      try {
        return JSON.parse(readFileSync(out, 'utf8')) as { env: Record<string, string> }
      } catch {
        return null
      }
    }
    await expect.poll(report).not.toBeNull()
    const seen = report() ?? { env: {} }
    const home = join(work, 'home')
    expect(seen.env['PATH']).toMatch(new RegExp(`^${home}/bin:`))
    expect(seen.env['VEYDR_FROM_LOGIN']).toBe('overridden')
    expect(seen.env['HOME']).toBe(home)
    expect(seen.env[TAG_VARIABLE]).toBe(tag)
    expect(Object.keys(seen.env).filter((key) => key.startsWith('ELECTRON_') || ['CHROME_DESKTOP', 'NO_AT_BRIDGE', 'APPDIR', 'APPIMAGE', 'ARGV0', 'OWD'].includes(key))).toEqual([])
    // Veydr itself does have the variable, so its absence is the filter at work.
    expect(await veydr.app.evaluate(() => process.env['ELECTRON_VEYDR_TEST_LEAK'])).toBe('1')
    // Read from /proc by the test, not reported by the command (L4 review, L4-02).
    expect(readdirSync(`/proc/${pid}/fd`).sort()).toEqual(['0', '1', '2'])
    await sleeper.getByRole('button', { name: 'Stop fds', exact: true }).click()
    await expect(sleeper.getByTestId('command-status')).toHaveText('Exited')

    // The preview shows the same environment, with the override marked.
    await window.getByRole('button', { name: 'Environment of inspect', exact: true }).click()
    const environment = window.getByTestId('environment-dialog')
    const entry = environment.locator('[data-testid="environment-entry"][data-key="VEYDR_FROM_LOGIN"]')
    await expect(entry).toContainText('overridden')
    await expect(entry).toContainText('Override')
    await expect(environment.locator('[data-testid="environment-entry"][data-key="ELECTRON_VEYDR_TEST_LEAK"]')).toHaveCount(0)
    await expect(environment.getByTestId('environment-warning')).toHaveCount(0)
    await environment.getByRole('button', { name: 'Refresh environment', exact: true }).click()
    await expect(entry).toContainText('overridden')
    await environment.getByRole('button', { name: 'Close', exact: true }).click()
    expect(commandProcesses(veydr, tag)).toEqual([])
  })
})

test('[spec:project-registry/launch-editor] [spec:project-registry/editor-survives-veydr-quit] opens a project in the configured editor, which keeps running after Veydr quits', async () => {
  const work = mkdtempSync(join(tmpdir(), 'veydr-e2e-editor-'))
  const editorPath = join(work, 'fake-editor')
  const argsOut = join(work, 'editor-args.txt')
  writeFileSync(editorPath, `#!/bin/sh\nprintf '%s\\0' "$@" > '${argsOut}.tmp' && mv '${argsOut}.tmp' '${argsOut}'\nexec sleep 120\n`)
  chmodSync(editorPath, 0o755)
  try {
    await withVeydr(async ({ veydr, window, shop, tag }) => {
      await window.getByRole('button', { name: 'Settings', exact: true }).click()
      await window.getByLabel('Editor executable', { exact: true }).fill(editorPath)
      await window.getByLabel('Editor argument 1', { exact: true }).fill('--goto={path}')
      await window.getByRole('button', { name: 'Add argument', exact: true }).click()
      await window.getByLabel('Editor argument 2', { exact: true }).fill('{path}')
      await window.getByRole('button', { name: 'Save editor', exact: true }).click()
      await expect(window.getByRole('status')).toHaveText('Saved.')

      await window.getByRole('button', { name: 'Projects', exact: true }).click()
      await window.getByRole('button', { name: 'Open shop in editor', exact: true }).click()
      await waitUntil(() => existsSync(argsOut), 'editor started')
      expect(readFileSync(argsOut, 'utf8').split('\0').slice(0, -1)).toEqual([`--goto=${shop}`, shop])
      await waitUntil(() => commandProcesses(veydr, tag).length === 1, 'editor process found')
      const [editor] = commandProcesses(veydr, tag)

      expectNoOutboundConnections(await veydr.close())
      // Veydr has quit; the editor is untouched.
      expect(editor !== undefined && isAlive(editor.pid, editor.starttime)).toBe(true)
      expect(readProcess(editor?.pid ?? 0)?.sid).toBe(editor?.pid)
      return 'closed'
    })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
