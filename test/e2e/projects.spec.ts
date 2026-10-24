import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { VeydrApi } from '../../src/shared/api'
import type { Config } from '../../src/shared/config'
import { fixture, killTagged, TAG_VARIABLE, taggedProcesses } from '../support/proc'
import { expect, expectNoOutboundConnections, launchVeydr, test, type VeydrApp } from './support/fixtures'
import { seed } from './support/seed'

// Task 6.1/6.2: registering, renaming, removing, and relocating projects from the UI.

const pickDirectoryPath = join(__dirname, 'support', 'pick-directory.cjs')

interface Harness {
  readonly veydr: VeydrApp
  readonly window: Page
  readonly work: string
  /** Sets what the native folder picker returns next (`''`: cancelled). */
  readonly pick: (path: string) => void
  readonly config: () => Config
}

async function withVeydr(run: (h: Harness) => Promise<void>, options: { config?: (work: string) => Config; tag?: string } = {}): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'veydr-e2e-projects-'))
  const pickFile = join(work, 'pick.txt')
  writeFileSync(pickFile, '')
  const seeded = seed(options.config === undefined ? {} : { 'config.json': JSON.stringify(options.config(work)) })
  const veydr = await launchVeydr({ configHome: seeded.configHome, preloads: [pickDirectoryPath], env: { VEYDR_TEST_PICK_FILE: pickFile } })
  try {
    await run({
      veydr,
      window: veydr.window,
      work,
      pick: (path) => writeFileSync(pickFile, path),
      config: () => JSON.parse(readFileSync(join(seeded.configDir, 'config.json'), 'utf8')) as Config,
    })
    expectNoOutboundConnections(await veydr.close())
  } finally {
    await veydr.app.close().catch(() => undefined)
    if (options.tag !== undefined) killTagged(options.tag)
    rmSync(veydr.workDir, { recursive: true, force: true })
    rmSync(seeded.root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
}

async function addProject(window: Page, name?: string): Promise<void> {
  await window.getByRole('button', { name: 'Add project', exact: true }).click()
  const dialog = window.getByTestId('project-dialog')
  await expect(dialog).toBeVisible()
  if (name !== undefined) await dialog.getByLabel('Project name', { exact: true }).fill(name)
  await dialog.getByRole('button', { name: 'Add project', exact: true }).click()
}

test('[spec:project-registry/register-valid-folder] registers a picked folder under its folder name, shows it, and persists it', async () => {
  await withVeydr(async ({ window, work, pick, config }) => {
    const shop = join(work, 'shop')
    mkdirSync(shop)
    // A cancelled picker changes nothing.
    await window.getByRole('button', { name: 'Add project', exact: true }).click()
    await expect(window.getByTestId('project-dialog')).toHaveCount(0)

    pick(shop)
    await window.getByRole('button', { name: 'Add project', exact: true }).click()
    const dialog = window.getByTestId('project-dialog')
    await expect(dialog.getByTestId('project-dialog-path')).toHaveText(shop)
    await expect(dialog.getByLabel('Project name', { exact: true })).toHaveValue('shop')
    await dialog.getByRole('button', { name: 'Add project', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    const project = window.getByTestId('project')
    await expect(project.getByRole('heading', { name: 'shop', exact: true })).toBeVisible()
    await expect(project.getByText(shop, { exact: true })).toBeVisible()
    await expect(window.getByTestId('sidebar-projects')).toHaveText('shop')
    expect(config().projects).toMatchObject([{ name: 'shop', path: shop, commands: [] }])

    // Still there after a reload (it comes from the stored configuration).
    await window.reload()
    await expect(window.getByTestId('project').getByRole('heading', { name: 'shop', exact: true })).toBeVisible()
  })
})

test('[spec:project-registry/reject-non-directory] [spec:project-registry/reject-duplicate] explains why a file, a missing path, or an already registered folder is rejected', async () => {
  await withVeydr(async ({ window, work, pick, config }) => {
    const shop = join(work, 'shop')
    mkdirSync(shop)
    symlinkSync(shop, join(work, 'shop-link'))
    writeFileSync(join(work, 'notes.txt'), 'x')
    pick(shop)
    await addProject(window, 'shop')
    await expect(window.getByTestId('project')).toHaveCount(1)

    const cases: [string, string][] = [
      [join(work, 'notes.txt'), `${join(work, 'notes.txt')} is not a folder.`],
      [join(work, 'gone'), `${join(work, 'gone')} does not exist.`],
      [join(work, 'shop-link'), `This folder is already registered as project "shop" (${shop}).`],
      [`${shop}/`, `This folder is already registered as project "shop" (${shop}).`],
    ]
    for (const [path, message] of cases) {
      pick(path)
      await addProject(window, 'again')
      const dialog = window.getByTestId('project-dialog')
      await expect(dialog.getByTestId('project-dialog-error')).toHaveText(message)
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(dialog).toHaveCount(0)
    }
    await expect(window.getByTestId('project')).toHaveCount(1)
    expect(config().projects).toHaveLength(1)
  })
})

test('[spec:project-registry/remove-idle-project] renames a project, then removes it after confirmation without touching its files', async () => {
  await withVeydr(async ({ window, work, pick, config }) => {
    const shop = join(work, 'shop')
    mkdirSync(join(shop, 'src'), { recursive: true })
    writeFileSync(join(shop, 'package.json'), '{"name":"shop"}')
    const before = readdirSync(shop, { recursive: true }).sort()
    pick(shop)
    await addProject(window)

    await window.getByRole('button', { name: 'Rename shop', exact: true }).click()
    const rename = window.getByTestId('project-dialog')
    await rename.getByLabel('Project name', { exact: true }).fill('storefront')
    await rename.getByRole('button', { name: 'Rename', exact: true }).click()
    await expect(window.getByTestId('project').getByRole('heading', { name: 'storefront', exact: true })).toBeVisible()

    // Cancel keeps it.
    await window.getByRole('button', { name: 'Remove storefront', exact: true }).click()
    const confirm = window.getByTestId('confirm-dialog')
    await expect(confirm).toContainText(`Nothing in ${shop} is changed or deleted.`)
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(window.getByTestId('project')).toHaveCount(1)

    await window.getByRole('button', { name: 'Remove storefront', exact: true }).click()
    await window.getByTestId('confirm-dialog').getByRole('button', { name: 'Remove project', exact: true }).click()
    await expect(window.getByTestId('empty-projects')).toBeVisible()
    expect(config().projects).toEqual([])
    expect(readdirSync(shop, { recursive: true }).sort()).toEqual(before)
    expect(readFileSync(join(shop, 'package.json'), 'utf8')).toBe('{"name":"shop"}')
  })
})

const PROJECT_ID = '7a2e9b5d-4d2f-4f66-8b8c-1e7e2a3c0b12'
const COMMAND_IDS = ['6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01', '0b7c9f7e-2a64-4d1a-8f0e-5f7d8c9b1a22', '3d0f4c2a-8e1b-4b6a-9c3d-2f1e0a9b8c77']

function threeCommands(tag: string) {
  return (work: string): Config => {
    const shop = join(work, 'shop')
    mkdirSync(shop)
    return {
      schemaVersion: 1,
      projects: [
        {
          id: PROJECT_ID,
          name: 'shop',
          path: shop,
          commands: ['api', 'web', 'worker'].map((name, i) => ({
            id: COMMAND_IDS[i] ?? '',
            name,
            execution: { mode: 'direct' as const, file: process.execPath, args: [fixture('inspect'), '--out', join(work, `${name}.json`), '--stay'] },
            cwd: '.',
            env: [{ key: TAG_VARIABLE, value: tag, secret: false }],
            stopTimeoutMs: 5000,
          })),
        },
      ],
      settings: { editor: null },
    }
  }
}

test('[spec:project-registry/multiple-commands] [spec:project-registry/remove-project-with-running-commands] starts and stops three commands independently; a project with running commands cannot be removed', async () => {
  const tag = crypto.randomUUID()
  await withVeydr(
    async ({ window, config }) => {
      const row = (name: string) => window.getByTestId('command').filter({ has: window.getByText(name, { exact: true }) })
      await expect(window.getByTestId('command')).toHaveCount(3)
      await row('api').getByRole('button', { name: 'Start api', exact: true }).click()
      await row('worker').getByRole('button', { name: 'Start worker', exact: true }).click()
      await expect(row('api').getByTestId('command-status')).toHaveText('Running')
      await expect(row('worker').getByTestId('command-status')).toHaveText('Running')
      await expect(row('web').getByTestId('command-status')).toHaveText('Idle')
      expect(taggedProcesses(tag)).toHaveLength(2)

      await window.getByRole('button', { name: 'Remove shop', exact: true }).click()
      const confirm = window.getByTestId('confirm-dialog')
      await confirm.getByRole('button', { name: 'Remove project', exact: true }).click()
      await expect(confirm.getByTestId('confirm-error')).toHaveText('Stop the running commands of "shop" first (api, worker), then remove the project.')
      await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(config().projects).toHaveLength(1)

      await row('api').getByRole('button', { name: 'Stop api', exact: true }).click()
      await expect(row('api').getByTestId('command-status')).toHaveText('Exited')
      await expect(row('worker').getByTestId('command-status')).toHaveText('Running')
      await row('worker').getByRole('button', { name: 'Stop worker', exact: true }).click()
      await expect(row('worker').getByTestId('command-status')).toHaveText('Exited')
      expect(taggedProcesses(tag)).toEqual([])

      await window.getByRole('button', { name: 'Remove shop', exact: true }).click()
      await window.getByTestId('confirm-dialog').getByRole('button', { name: 'Remove project', exact: true }).click()
      await expect(window.getByTestId('empty-projects')).toBeVisible()
    },
    { config: threeCommands(tag), tag },
  )
})

test('[spec:project-registry/directory-missing] [spec:project-registry/relocate-project] a deleted project folder shows as missing, its commands cannot start, and relocating makes them startable', async () => {
  const tag = crypto.randomUUID()
  const config = threeCommands(tag)
  await withVeydr(
    async ({ window, work, pick, config: stored }) => {
      const project = window.getByTestId('project')
      await expect(project.getByTestId('project-missing-badge')).toHaveText('Folder missing')
      await expect(project.getByTestId('project-missing')).toBeVisible()
      for (const name of ['api', 'web', 'worker']) await expect(project.getByRole('button', { name: `Start ${name}`, exact: true })).toBeDisabled()

      // Main refuses as well, whatever the UI shows.
      const result = await window.evaluate((commandId) => (globalThis as unknown as { veydr: VeydrApi }).veydr.processes.start({ commandId }), COMMAND_IDS[0] ?? '')
      expect(result).toMatchObject({ ok: true, value: { status: 'failed', error: `The project folder is missing: ${join(work, 'shop')}` } })
      expect(taggedProcesses(tag)).toEqual([])

      // Opening the folder is refused with a reason.
      await project.getByRole('button', { name: 'Open folder of shop', exact: true }).click()
      await expect(project.getByTestId('project-problem')).toHaveText(`Nothing was opened: the folder of "shop" is missing or not a folder (${join(work, 'shop')}).`)

      const moved = join(work, 'moved')
      mkdirSync(moved)
      pick(moved)
      await project.getByRole('button', { name: 'Relocate shop', exact: true }).click()
      await expect(project.getByTestId('project-missing-badge')).toHaveCount(0)
      await expect(project.getByText(moved, { exact: true })).toBeVisible()
      expect(stored().projects[0]?.path).toBe(moved)

      await project.getByRole('button', { name: 'Start web', exact: true }).click()
      await expect(project.getByTestId('command').nth(1).getByTestId('command-status')).toHaveText('Running')
      await project.getByRole('button', { name: 'Stop web', exact: true }).click()
      await expect(project.getByTestId('command').nth(1).getByTestId('command-status')).toHaveText('Exited')
    },
    {
      tag,
      config: (work) => {
        const seeded = config(work)
        rmSync(join(work, 'shop'), { recursive: true })
        return seeded
      },
    },
  )
})
