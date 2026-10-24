import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture, killTagged, readLedger, taggedProcesses, treeSize } from '../support/proc'
import { expect, expectNoOutboundConnections, launchVeydr, test, type VeydrApp } from './support/fixtures'
import { exited, recordedRuns, taggedConfig } from './support/runs'
import { seed } from './support/seed'

// Task 5.3: processes that outlive a crash of Veydr are shown on the next launch and terminated
// only after the user confirms; nothing is started on launch.

const TREE_ID = '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01'
const OTHER_ID = '0b7c9f7e-2a64-4d1a-8f0e-5f7d8c9b1a22'

test('[spec:process-supervision/survivors-after-crash] [spec:desktop-shell/startup-does-not-start-commands] after a crash, survivors are listed and terminated only on confirmation; nothing is started', async () => {
  const tag = crypto.randomUUID()
  const projectDir = mkdtempSync(join(tmpdir(), 'veydr-e2e-project-'))
  const ledger = join(projectDir, 'ledger.jsonl')
  const treeArgs = [fixture('tree'), '--ledger', ledger, '--depth', '2', '--fanout', '2', '--escape']
  const seeded = seed({
    'config.json': JSON.stringify(
      taggedConfig(projectDir, tag, [
        { id: TREE_ID, name: 'tree', execution: { mode: 'direct', file: process.execPath, args: treeArgs }, stopTimeoutMs: 5000 },
        { id: OTHER_ID, name: 'other', execution: { mode: 'direct', file: process.execPath, args: [fixture('tree'), '--ledger', ledger] }, stopTimeoutMs: 5000 },
      ]),
    ),
  })
  const apps: VeydrApp[] = []
  try {
    // First session: start the tree, wait until every process is recorded, then crash.
    const first = await launchVeydr({ configHome: seeded.configHome })
    apps.push(first)
    const tree = first.window.locator(`[data-command-id="${TREE_ID}"]`)
    await tree.getByRole('button', { name: 'Start tree', exact: true }).click()
    await expect(tree.getByTestId('command-status')).toHaveText('Running')
    await expect.poll(() => readLedger(ledger).length).toBe(treeSize(2, 2))
    await expect.poll(() => recordedRuns(seeded.configHome)?.[0]?.descendants.length, { timeout: 15_000 }).toBe(treeSize(2, 2) - 1)
    const survivors = taggedProcesses(tag).map((p) => p.pid)
    expect(survivors).toHaveLength(treeSize(2, 2))
    first.app.process().kill('SIGKILL')
    await exited(first.app)
    expect(taggedProcesses(tag).map((p) => p.pid)).toEqual(survivors)

    // Second session: the survivors are listed with name and command line; nothing was started.
    const second = await launchVeydr({ configHome: seeded.configHome })
    apps.push(second)
    const { window } = second
    const notice = window.locator('[data-testid="notice"][data-kind="crash-survivors"]')
    await expect(notice).toContainText(`${treeSize(2, 2)} processes started by Veydr in an earlier session are still running. Nothing was restarted.`)
    const listed = notice.getByTestId('notice-process')
    await expect(listed).toHaveCount(treeSize(2, 2))
    for (const pid of survivors) await expect(notice).toContainText(`PID ${pid}`)
    await expect(listed.first()).toContainText(fixture('tree'))
    await expect(window.locator(`[data-command-id="${TREE_ID}"]`).getByTestId('command-status')).toHaveText('Idle')
    await expect(window.locator(`[data-command-id="${OTHER_ID}"]`).getByTestId('command-status')).toHaveText('Idle')
    // Not one new process, and none of the survivors was signalled before the user decided.
    expect(taggedProcesses(tag).map((p) => p.pid)).toEqual(survivors)
    expect(readLedger(ledger)).toHaveLength(treeSize(2, 2))

    await notice.getByRole('button', { name: 'Terminate', exact: true }).click()
    await expect(notice).toHaveCount(0)
    await expect.poll(() => taggedProcesses(tag)).toEqual([])
    await expect.poll(() => recordedRuns(seeded.configHome)).toEqual([])
    // The resolved notice is not shown again after a reload.
    await window.reload()
    await expect(window.locator(`[data-command-id="${TREE_ID}"]`).getByTestId('command-status')).toHaveText('Idle')
    await expect(window.locator('[data-testid="notice"][data-kind="crash-survivors"]')).toHaveCount(0)

    expectNoOutboundConnections(await second.close())
  } finally {
    // First: a surviving process may hold descriptors of a killed app, which keeps it from closing.
    killTagged(tag)
    for (const veydr of apps) {
      await veydr.app.close().catch(() => undefined)
      rmSync(veydr.workDir, { recursive: true, force: true })
    }
    rmSync(seeded.root, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('survivors can be left running; they are then forgotten', async () => {
  const tag = crypto.randomUUID()
  const projectDir = mkdtempSync(join(tmpdir(), 'veydr-e2e-project-'))
  const ledger = join(projectDir, 'ledger.jsonl')
  const seeded = seed({
    'config.json': JSON.stringify(
      taggedConfig(projectDir, tag, [{ id: TREE_ID, name: 'tree', execution: { mode: 'direct', file: process.execPath, args: [fixture('tree'), '--ledger', ledger] }, stopTimeoutMs: 5000 }]),
    ),
  })
  const apps: VeydrApp[] = []
  try {
    const first = await launchVeydr({ configHome: seeded.configHome })
    apps.push(first)
    const tree = first.window.locator(`[data-command-id="${TREE_ID}"]`)
    await tree.getByRole('button', { name: 'Start tree', exact: true }).click()
    await expect(tree.getByTestId('command-status')).toHaveText('Running')
    await expect.poll(() => recordedRuns(seeded.configHome)?.length).toBe(1)
    first.app.process().kill('SIGKILL')
    await exited(first.app)

    const second = await launchVeydr({ configHome: seeded.configHome })
    apps.push(second)
    const notice = second.window.locator('[data-testid="notice"][data-kind="crash-survivors"]')
    await notice.getByRole('button', { name: 'Leave running', exact: true }).click()
    await expect(notice).toHaveCount(0)
    await expect.poll(() => recordedRuns(seeded.configHome)).toEqual([])
    expect(taggedProcesses(tag)).toHaveLength(1)
    expectNoOutboundConnections(await second.close())
    // Left running: Veydr did not stop it on quit either.
    expect(taggedProcesses(tag)).toHaveLength(1)
  } finally {
    // First: a surviving process may hold descriptors of a killed app, which keeps it from closing.
    killTagged(tag)
    for (const veydr of apps) {
      await veydr.app.close().catch(() => undefined)
      rmSync(veydr.workDir, { recursive: true, force: true })
    }
    rmSync(seeded.root, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  }
})
