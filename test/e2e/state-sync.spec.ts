import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { Config } from '../../src/shared/config'
import { expect, expectNoOutboundConnections, launchVeydr, test, type VeydrApp } from './support/fixtures'

const SECRET = 'hunter2-e2e-secret-value'

function seededConfig(projectPath: string): Config {
  return {
    schemaVersion: 1,
    projects: [
      {
        id: '7a2e9b5d-4d2f-4f66-8b8c-1e7e2a3c0b12',
        name: 'shop',
        path: projectPath,
        commands: [
          {
            id: '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01',
            name: 'api',
            execution: { mode: 'direct', file: 'npm', args: ['run', 'api'] },
            cwd: '.',
            env: [{ key: 'API_TOKEN', value: SECRET, secret: true }],
            stopTimeoutMs: 5000,
          },
          {
            id: '0b7c9f7e-2a64-4d1a-8f0e-5f7d8c9b1a22',
            name: 'web',
            execution: { mode: 'shell', shell: '/bin/sh', script: 'npm run web' },
            cwd: '.',
            env: [],
            stopTimeoutMs: 5000,
          },
        ],
      },
    ],
    settings: { editor: null },
  }
}

interface Seeded {
  readonly root: string
  readonly configHome: string
  readonly configDir: string
}

/** A temporary config home whose Veydr directory holds the given files. */
function seed(files: Readonly<Record<string, string>>): Seeded {
  const root = mkdtempSync(join(tmpdir(), 'veydr-e2e-seed-'))
  const configHome = join(root, 'config')
  const configDir = join(configHome, 'Veydr')
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(configDir, name), content, { mode: 0o600 })
  return { root, configHome, configDir }
}

async function withApp(seeded: Seeded, run: (veydr: VeydrApp, stderr: () => string) => Promise<void>): Promise<void> {
  const veydr = await launchVeydr({ configHome: seeded.configHome })
  const chunks: string[] = []
  veydr.app.process().stderr?.on('data', (chunk: Buffer) => chunks.push(String(chunk)))
  try {
    await run(veydr, () => chunks.join(''))
    expectNoOutboundConnections(await veydr.close())
  } finally {
    await veydr.app.close().catch(() => undefined)
    rmSync(veydr.workDir, { recursive: true, force: true })
    rmSync(seeded.root, { recursive: true, force: true })
  }
}

async function expectProjectShown(window: Page): Promise<void> {
  const project = window.getByTestId('project')
  await expect(project).toHaveCount(1)
  await expect(project.getByRole('heading', { name: 'shop' })).toBeVisible()
  const commands = project.getByTestId('command')
  await expect(commands).toHaveCount(2)
  await expect(commands.nth(0)).toContainText('api')
  await expect(commands.nth(1)).toContainText('web')
  await expect(project.getByTestId('command-status')).toHaveText(['Idle', 'Idle'])
  await expect(window.getByTestId('sidebar-projects')).toHaveText('shop')
}

test('[spec:config-storage/corrupt-primary-file] the recovery notice is shown, the damaged file is kept, and state is restored after a reload', async () => {
  const seeded = seed({ 'config.json': '{"schemaVersion": 1, "projects": [', 'config.json.bak': JSON.stringify(seededConfig('/home/dev/shop')) })

  await withApp(seeded, async ({ window }, stderr) => {
    const notice = window.getByTestId('notice')
    await expect(notice).toHaveCount(1)
    await expect(notice).toHaveAttribute('data-kind', 'recovered-from-backup')
    await expect(notice).toHaveAttribute('role', 'status')
    await expect(notice).toContainText('Veydr loaded the backup instead')
    await expectProjectShown(window)

    const kept = readdirSync(seeded.configDir).filter((name) => name.startsWith('config.corrupt-'))
    expect(kept).toHaveLength(1)
    await expect(notice.getByRole('list', { name: 'Files' })).toContainText(join(seeded.configDir, kept[0] ?? ''))

    // Secret values never reach the renderer.
    expect(await window.content()).not.toContain(SECRET)
    expect(JSON.stringify(await window.evaluate(() => globalThis.window.veydr.projects.list()))).not.toContain(SECRET)

    // A reload starts a new document: main drops the old document's subscriptions, replays the
    // notices once, and the stores load the snapshot again.
    await window.reload()
    await expect(notice).toHaveCount(1)
    await expect(notice).toHaveAttribute('data-kind', 'recovered-from-backup')
    await expectProjectShown(window)
    await expect.poll(stderr).toContain('events.document-replaced')

    // Dismissing hides the notice in this document only; main keeps it for the session.
    await notice.getByRole('button', { name: 'Dismiss' }).click()
    await expect(notice).toHaveCount(0)
    await window.reload()
    await expect(notice).toHaveCount(1)
  })
})

test('[spec:config-storage/no-usable-configuration] an empty configuration is reported as an error and the damaged files are kept', async () => {
  const seeded = seed({ 'config.json': 'not json', 'config.json.bak': '{"schemaVersion": "x"}' })

  await withApp(seeded, async ({ window }) => {
    const notice = window.getByTestId('notice')
    await expect(notice).toHaveCount(1)
    await expect(notice).toHaveAttribute('data-kind', 'reset-to-empty')
    await expect(notice).toHaveAttribute('role', 'alert')
    await expect(notice).toContainText('Veydr started with an empty configuration')
    await expect(window.getByTestId('empty-projects')).toContainText('No projects yet')

    const kept = readdirSync(seeded.configDir).filter((name) => name.startsWith('config.corrupt-'))
    expect(kept.length).toBeGreaterThanOrEqual(1)
    for (const name of kept) await expect(notice).toContainText(name)
  })
})

test('process state is loaded from the snapshot and restored after a reload', async () => {
  const seeded = seed({ 'config.json': JSON.stringify(seededConfig('/home/dev/shop')) })

  await withApp(seeded, async ({ window }) => {
    await expectProjectShown(window)
    await expect(window.getByTestId('notice')).toHaveCount(0)

    const before = await window.evaluate(() => globalThis.window.veydr.processes.snapshot())
    expect(before).toMatchObject({ ok: true, value: { commands: [{ status: 'idle', seq: 0 }, { status: 'idle', seq: 0 }] } })

    await window.reload()
    await expectProjectShown(window)
    expect(await window.evaluate(() => globalThis.window.veydr.processes.snapshot())).toEqual(before)
    expect(existsSync(join(seeded.configDir, 'config.json'))).toBe(true)
  })
})

test('the first launch shows no notice and the empty state', async ({ window }) => {
  await expect(window.getByTestId('empty-projects')).toContainText('No projects yet')
  await expect(window.getByTestId('notice')).toHaveCount(0)
})
