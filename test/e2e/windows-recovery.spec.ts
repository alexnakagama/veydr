import { join } from 'node:path'
import { fixture, readLedger, treeSize } from '../support/proc'
import { killTagged, taggedProcesses } from '../support/processes'
import { expect, expectNoOutboundConnections, launchVeydr, test, type VeydrApp } from './support/fixtures'
import { exited, recordedRuns, taggedConfig } from './support/runs'
import { seed } from './support/seed'
import { removeDir, tempDir } from './support/temp'

// Crash recovery on Windows (add-windows-environment-and-commands design D7), the counterpart of the
// Linux-only recovery.spec.ts: a command's processes are in a Job Object that ends with Veydr's
// helper, so when Veydr is killed its trees end with it, and the next launch has no survivors to show.

test.skip(process.platform !== 'win32', '[windows-only: Job Objects]')

const TREE_ID = '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01'

test('[windows-only: Job Objects] [spec:process-supervision/veydr-ends-abnormally-on-windows] [spec:desktop-shell/startup-does-not-start-commands] after a crash the trees have ended; the next launch shows no survivors and starts nothing', async () => {
  const tag = crypto.randomUUID()
  const projectDir = tempDir('veydr-e2e-project-')
  const ledger = join(projectDir, 'ledger.jsonl')
  const treeArgs = [fixture('tree'), '--ledger', ledger, '--depth', '2', '--fanout', '2']
  const seeded = seed({
    'config.json': JSON.stringify(taggedConfig(projectDir, tag, [{ id: TREE_ID, name: 'tree', execution: { mode: 'direct', file: process.execPath, args: treeArgs }, stopTimeoutMs: 5000 }])),
  })
  const apps: VeydrApp[] = []
  try {
    // First session: start the tree, wait until every process runs and the run is recorded, then crash.
    const first = await launchVeydr({ configHome: seeded.configHome })
    apps.push(first)
    const tree = first.window.locator(`[data-command-id="${TREE_ID}"]`)
    await tree.getByRole('button', { name: 'Start tree', exact: true }).click()
    await expect(tree.getByTestId('command-status')).toHaveText('Running')
    await expect.poll(() => readLedger(ledger).length).toBe(treeSize(2, 2))
    await expect.poll(() => recordedRuns(seeded.configHome)?.length, { timeout: 15_000 }).toBe(1)
    expect(taggedProcesses(tag)).toHaveLength(treeSize(2, 2))
    // TerminateProcess: Veydr gets no chance to stop anything itself.
    first.kill()
    await exited(first.app)
    // The helper sees Veydr's end and closes the job, which ends every process in it.
    await expect.poll(() => taggedProcesses(tag), { timeout: 20_000 }).toEqual([])

    // Second session: the recorded run has nothing alive, so it is dropped without a notice.
    const second = await launchVeydr({ configHome: seeded.configHome })
    apps.push(second)
    const { window } = second
    await expect.poll(() => recordedRuns(seeded.configHome), { timeout: 15_000 }).toEqual([])
    await expect(window.locator(`[data-command-id="${TREE_ID}"]`).getByTestId('command-status')).toHaveText('Idle')
    await expect(window.getByTestId('notice')).toHaveCount(0)
    // Nothing was started: no tagged process, and no new fixture process recorded itself.
    expect(taggedProcesses(tag)).toEqual([])
    expect(readLedger(ledger)).toHaveLength(treeSize(2, 2))

    expectNoOutboundConnections(await second.close())
  } finally {
    killTagged(tag)
    for (const veydr of apps) {
      await veydr.app.close().catch(() => undefined)
      removeDir(veydr.workDir)
    }
    removeDir(seeded.root)
    removeDir(projectDir)
  }
})
