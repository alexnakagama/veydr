import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../../src/shared/config'
import { fixture, killTagged, readLedger, TAG_VARIABLE, taggedProcesses, treeSize } from '../support/proc'
import { expect, expectNoOutboundConnections, launchVeydr, test } from './support/fixtures'
import { seed } from './support/seed'

// Task 4.10: lifecycle actions from the UI against real process trees.

const TREE_ID = '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01'
const MISSING_ID = '0b7c9f7e-2a64-4d1a-8f0e-5f7d8c9b1a22'

function seededConfig(projectPath: string, ledger: string, tag: string): Config {
  const env = [{ key: TAG_VARIABLE, value: tag, secret: false }]
  return {
    schemaVersion: 1,
    projects: [
      {
        id: '7a2e9b5d-4d2f-4f66-8b8c-1e7e2a3c0b12',
        name: 'fixtures',
        path: projectPath,
        commands: [
          {
            id: TREE_ID,
            name: 'tree',
            execution: { mode: 'direct', file: process.execPath, args: [fixture('tree'), '--ledger', ledger, '--depth', '2', '--fanout', '2'] },
            cwd: '.',
            env,
            stopTimeoutMs: 5000,
          },
          {
            id: MISSING_ID,
            name: 'missing',
            execution: { mode: 'direct', file: 'veydr-no-such-executable', args: [] },
            cwd: '.',
            env,
            stopTimeoutMs: 5000,
          },
        ],
      },
    ],
    settings: { editor: null },
  }
}

test('starts and stops a fixture tree from the UI, showing state, PID, uptime, and exit details', async () => {
  const tag = crypto.randomUUID()
  const projectDir = mkdtempSync(join(tmpdir(), 'veydr-e2e-project-'))
  const ledger = join(projectDir, 'ledger.jsonl')
  const seeded = seed({ 'config.json': JSON.stringify(seededConfig(projectDir, ledger, tag)) })

  const veydr = await launchVeydr({ configHome: seeded.configHome })
  try {
    const { window } = veydr
    const tree = window.locator(`[data-command-id="${TREE_ID}"]`)
    await expect(tree.getByTestId('command-status')).toHaveText('Idle')
    // Nothing runs before the user asks.
    expect(taggedProcesses(tag)).toEqual([])

    await tree.getByRole('button', { name: 'Start tree', exact: true }).click()
    await expect(tree.getByTestId('command-status')).toHaveText('Running')
    await expect.poll(() => readLedger(ledger).length).toBe(treeSize(2, 2))
    const root = readLedger(ledger).find((entry) => entry.role === 'root')
    await expect(tree.getByTestId('command-detail')).toHaveText(new RegExp(`^PID ${root?.pid} · up \\d+:\\d{2}$`))
    // Uptime advances while the command runs.
    await expect(tree.getByTestId('command-detail')).toHaveText(/up 0:0[1-9]$/, { timeout: 5_000 })
    expect(taggedProcesses(tag)).toHaveLength(7)
    await expect(tree.getByRole('button', { name: 'Start tree', exact: true })).toBeDisabled()

    await tree.getByRole('button', { name: 'Stop tree', exact: true }).click()
    await expect(tree.getByTestId('command-status')).toHaveText('Exited')
    await expect(tree.getByTestId('command-detail')).toHaveText('Terminated by SIGTERM')
    await expect(tree.getByTestId('command-survivors')).toHaveCount(0)
    expect(taggedProcesses(tag)).toEqual([])

    // A start failure is shown with its reason; no process is created.
    const missing = window.locator(`[data-command-id="${MISSING_ID}"]`)
    await missing.getByRole('button', { name: 'Start missing', exact: true }).click()
    await expect(missing.getByTestId('command-status')).toHaveText('Failed')
    await expect(missing.getByTestId('command-detail')).toHaveText('Executable not found: veydr-no-such-executable (searched PATH)')
    expect(taggedProcesses(tag)).toEqual([])

    // The states survive a reload (snapshot).
    await window.reload()
    await expect(tree.getByTestId('command-status')).toHaveText('Exited')
    await expect(missing.getByTestId('command-status')).toHaveText('Failed')

    expectNoOutboundConnections(await veydr.close())
  } finally {
    await veydr.app.close().catch(() => undefined)
    killTagged(tag)
    rmSync(veydr.workDir, { recursive: true, force: true })
    rmSync(seeded.root, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  }
})
