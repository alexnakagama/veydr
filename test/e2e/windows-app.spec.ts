import { existsSync } from 'node:fs'
import { windowsHelperPath } from '../../src/main/platform'
import type { Config } from '../../src/shared/config'
import { TAG_VARIABLE } from '../support/proc'
import { killTagged, taggedProcesses } from '../support/processes'
import { appInfo, expect, expectNoOutboundConnections, launchVeydr, repoRoot, test } from './support/fixtures'
import { printExecution } from './support/logs'
import { seed } from './support/seed'
import { removeDir, tempDir } from './support/temp'

// The app started by the end-to-end tests on Windows (add-windows-environment-and-commands design
// D7): its application path is the repository root, where `out-helper/` is built, so it finds the
// helper, and a command started from the UI runs, shows its output, and stops.

test.skip(process.platform !== 'win32', '[windows-only: the process-tree helper]')

const COMMAND_ID = '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01'

test('[windows-only: the process-tree helper] the app finds the helper below its application path, and a command starts, logs and stops from the UI', async () => {
  const tag = crypto.randomUUID()
  const projectDir = tempDir('veydr-e2e-project-')
  const config: Config = {
    schemaVersion: 1,
    projects: [
      {
        id: '7a2e9b5d-4d2f-4f66-8b8c-1e7e2a3c0b12',
        name: 'shop',
        path: projectDir,
        commands: [
          {
            id: COMMAND_ID,
            name: 'hello',
            execution: printExecution([{ stream: 'out', text: 'hello from windows\n' }], { stay: true }),
            cwd: '.',
            env: [{ key: TAG_VARIABLE, value: tag, secret: false }],
            stopTimeoutMs: 5000,
          },
        ],
      },
    ],
    settings: { editor: null },
  }
  const seeded = seed({ 'config.json': JSON.stringify(config) })
  const veydr = await launchVeydr({ configHome: seeded.configHome })
  try {
    const { app, window } = veydr
    // The app's path is the repository root, so the helper it uses is the one the windows job built.
    const appPath = await app.evaluate(({ app: electronApp }) => electronApp.getAppPath())
    expect(appPath).toBe(repoRoot)
    expect(existsSync(windowsHelperPath(appPath))).toBe(true)
    expect(await appInfo(window)).toMatchObject({ platform: 'windows', platformSupported: true })

    // Starting a command needs the helper: a missing or stale one fails the start instead.
    const row = window.locator(`[data-command-id="${COMMAND_ID}"]`)
    await row.locator('.command-name').click()
    await row.getByRole('button', { name: 'Start hello', exact: true }).click()
    await expect(row.getByTestId('command-status')).toHaveText('Running')
    await expect(window.getByTestId('log-view').getByTestId('log-text').filter({ hasText: 'hello from windows' })).toHaveCount(1)
    expect(taggedProcesses(tag)).toHaveLength(1)

    await row.getByRole('button', { name: 'Stop hello', exact: true }).click()
    await expect(row.getByTestId('command-status')).toHaveText('Exited')
    // Veydr asks a command to stop with Ctrl+Break; Node has no handler for it by default, so the
    // console's default handling ends the process with STATUS_CONTROL_C_EXIT (0xC000013A).
    await expect(row.getByTestId('command-detail')).toHaveText('Exited with code 3221225786')
    await expect(row.getByTestId('command-survivors')).toHaveCount(0)
    expect(taggedProcesses(tag)).toEqual([])
    expectNoOutboundConnections(await veydr.close())
  } finally {
    await veydr.app.close().catch(() => undefined)
    killTagged(tag)
    removeDir(veydr.workDir)
    removeDir(seeded.root)
    removeDir(projectDir)
  }
})
