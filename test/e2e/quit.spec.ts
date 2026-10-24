import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture, killTagged, readLedger, taggedProcesses, treeSize } from '../support/proc'
import { expect, expectNoOutboundConnections, launchVeydr, test, type VeydrApp } from './support/fixtures'
import { exited, networkReportOf, recordedRuns, taggedConfig } from './support/runs'
import { seed } from './support/seed'

// Tasks 5.4 and 5.5: quitting stops every running command first (design D10), and so does a
// termination signal (design D9).

const TREE_ID = '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01'
const STUBBORN_ID = '0b7c9f7e-2a64-4d1a-8f0e-5f7d8c9b1a22'
const unkillablePath = join(__dirname, 'support/unkillable.cjs')
const quitDialogPath = join(__dirname, 'support/quit-dialog.cjs')

interface Fixture {
  readonly tag: string
  readonly projectDir: string
  readonly ledger: string
  readonly seeded: ReturnType<typeof seed>
  readonly apps: VeydrApp[]
}

async function withFixture(commands: (f: Pick<Fixture, 'ledger'>) => Parameters<typeof taggedConfig>[2], body: (f: Fixture) => Promise<void>): Promise<void> {
  const tag = crypto.randomUUID()
  const projectDir = mkdtempSync(join(tmpdir(), 'veydr-e2e-project-'))
  const ledger = join(projectDir, 'ledger.jsonl')
  const seeded = seed({ 'config.json': JSON.stringify(taggedConfig(projectDir, tag, commands({ ledger }))) })
  const f: Fixture = { tag, projectDir, ledger, seeded, apps: [] }
  try {
    await body(f)
  } finally {
    // First: a surviving process may hold descriptors of a killed app, which keeps it from closing.
    killTagged(tag)
    for (const veydr of f.apps) {
      await veydr.app.close().catch(() => undefined)
      rmSync(veydr.workDir, { recursive: true, force: true })
    }
    rmSync(seeded.root, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  }
}

const node = (args: readonly string[]) => ({ mode: 'direct' as const, file: process.execPath, args: [...args] })

async function start(veydr: VeydrApp, id: string, name: string): Promise<void> {
  const row = veydr.window.locator(`[data-command-id="${id}"]`)
  await row.getByRole('button', { name: `Start ${name}`, exact: true }).click()
  await expect(row.getByTestId('command-status')).toHaveText('Running')
}

const quit = (veydr: VeydrApp): Promise<void> => veydr.app.evaluate(({ app }) => app.quit())

test('[spec:process-supervision/quit-with-running-commands] quitting shows progress, stops every running command, and leaves an empty ledger', async () => {
  await withFixture(
    ({ ledger }) => [
      { id: TREE_ID, name: 'tree', execution: node([fixture('tree'), '--ledger', ledger, '--depth', '2', '--fanout', '2']), stopTimeoutMs: 5000 },
      { id: STUBBORN_ID, name: 'stubborn', execution: node([fixture('tree'), '--ledger', ledger, '--depth', '1', '--ignore-term']), stopTimeoutMs: 1500 },
    ],
    async (f) => {
      const veydr = await launchVeydr({ configHome: f.seeded.configHome })
      f.apps.push(veydr)
      await start(veydr, TREE_ID, 'tree')
      await start(veydr, STUBBORN_ID, 'stubborn')
      await expect.poll(() => readLedger(f.ledger).length).toBe(treeSize(2, 2) + 2)
      expect(taggedProcesses(f.tag)).toHaveLength(treeSize(2, 2) + 2)
      expect(recordedRuns(f.seeded.configHome)).toHaveLength(2)

      const exit = exited(veydr.app)
      await quit(veydr)
      // The stubborn command ignores SIGTERM, so stopping takes its 1.5 s stop timeout.
      const overlay = veydr.window.getByTestId('quit-overlay')
      await expect(overlay).toContainText('Stopping running commands before quitting…')
      await expect(overlay).toContainText('stubborn')
      expect(await exit).toBe(0)

      expect(taggedProcesses(f.tag)).toEqual([])
      expect(recordedRuns(f.seeded.configHome)).toEqual([])
      expectNoOutboundConnections(networkReportOf(veydr.workDir))
    },
  )
})

test('closing the window quits the same way', async () => {
  await withFixture(
    ({ ledger }) => [{ id: TREE_ID, name: 'tree', execution: node([fixture('tree'), '--ledger', ledger, '--depth', '1', '--fanout', '2']), stopTimeoutMs: 5000 }],
    async (f) => {
      const veydr = await launchVeydr({ configHome: f.seeded.configHome })
      f.apps.push(veydr)
      await start(veydr, TREE_ID, 'tree')
      await expect.poll(() => readLedger(f.ledger).length).toBe(treeSize(1, 2))
      const exit = exited(veydr.app)
      await veydr.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
      expect(await exit).toBe(0)
      expect(taggedProcesses(f.tag)).toEqual([])
      expect(recordedRuns(f.seeded.configHome)).toEqual([])
    },
  )
})

test('[spec:process-supervision/stop-failures-on-quit] processes that cannot be stopped are listed with Retry / Quit anyway; quitting anyway keeps them in the ledger for the next launch', async () => {
  await withFixture(
    ({ ledger }) => [{ id: TREE_ID, name: 'tree', execution: node([fixture('tree'), '--ledger', ledger, '--depth', '1', '--escape']), stopTimeoutMs: 300 }],
    async (f) => {
      const dialogLog = join(f.projectDir, 'dialogs.jsonl')
      const veydr = await launchVeydr({
        configHome: f.seeded.configHome,
        preloads: [unkillablePath, quitDialogPath],
        env: { VEYDR_TEST_DIALOG_ANSWERS: 'Retry,Quit anyway', VEYDR_TEST_DIALOG_LOG: dialogLog },
      })
      f.apps.push(veydr)
      await start(veydr, TREE_ID, 'tree')
      await expect.poll(() => readLedger(f.ledger).length).toBe(2)
      const escapee = readLedger(f.ledger).find((e) => e.role.includes(':setsid'))
      // The escapee is attributed (observed through its parent) before quitting.
      await expect.poll(() => recordedRuns(f.seeded.configHome)?.[0]?.descendants.map((d) => d.pid), { timeout: 15_000 }).toEqual([escapee?.pid])

      const exit = exited(veydr.app)
      await quit(veydr)
      expect(await exit).toBe(0)

      const dialogs = readFileSync(dialogLog, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as { message: string; detail: string; buttons: string[]; answer: string })
      expect(dialogs.map((d) => d.answer)).toEqual(['Retry', 'Quit anyway'])
      for (const d of dialogs) {
        expect(d.buttons).toEqual(['Retry', 'Quit anyway'])
        expect(d.message).toBe('Some processes could not be stopped.')
        expect(d.detail).toContain(`(PID ${escapee?.pid}): ${process.execPath} ${fixture('tree')}`)
      }
      // The leader was stopped; the unkillable escapee survives and stays recorded.
      expect(taggedProcesses(f.tag).map((p) => p.pid)).toEqual([escapee?.pid])
      expect(recordedRuns(f.seeded.configHome)).toHaveLength(1)
      expectNoOutboundConnections(networkReportOf(veydr.workDir))

      // The next launch reports it (and can terminate it, now that signals work again).
      const next = await launchVeydr({ configHome: f.seeded.configHome })
      f.apps.push(next)
      const notice = next.window.locator('[data-testid="notice"][data-kind="crash-survivors"]')
      await expect(notice).toContainText(`PID ${escapee?.pid}`)
      await notice.getByRole('button', { name: 'Terminate', exact: true }).click()
      // Resolved once the notice is gone (the run then leaves the ledger), not merely once the process is.
      await expect(notice).toHaveCount(0)
      expect(taggedProcesses(f.tag)).toEqual([])
      expectNoOutboundConnections(await next.close())
      expect(recordedRuns(f.seeded.configHome)).toEqual([])
    },
  )
})

for (const [signal, number] of [['SIGTERM', 15], ['SIGINT', 2], ['SIGHUP', 1]] as const) {
  test(`${signal} to Veydr stops every running command before it exits`, async () => {
    await withFixture(
      ({ ledger }) => [{ id: TREE_ID, name: 'tree', execution: node([fixture('tree'), '--ledger', ledger, '--depth', '2', '--fanout', '2']), stopTimeoutMs: 5000 }],
      async (f) => {
        const veydr = await launchVeydr({ configHome: f.seeded.configHome })
        f.apps.push(veydr)
        const stderr: string[] = []
        veydr.app.process().stderr?.on('data', (chunk: Buffer) => stderr.push(String(chunk)))
        await start(veydr, TREE_ID, 'tree')
        await expect.poll(() => readLedger(f.ledger).length).toBe(treeSize(2, 2))
        expect(taggedProcesses(f.tag)).toHaveLength(treeSize(2, 2))

        const exit = exited(veydr.app)
        const started = Date.now()
        veydr.app.process().kill(signal)
        expect(await exit).toBe(128 + number)
        expect(Date.now() - started).toBeLessThan(10_000 + 2_000)
        expect(stderr.join('')).toContain(`app.signal {"signal":"${signal}"}`)
        expect(taggedProcesses(f.tag)).toEqual([])
        expect(recordedRuns(f.seeded.configHome)).toEqual([])
        expect(existsSync(join(f.seeded.configDir, 'config.json'))).toBe(true)
      },
    )
  })
}

test('a second signal exits at once, keeping what is not verified as stopped in the ledger', async () => {
  await withFixture(
    ({ ledger }) => [{ id: STUBBORN_ID, name: 'stubborn', execution: node([fixture('tree'), '--ledger', ledger, '--ignore-term']), stopTimeoutMs: 8000 }],
    async (f) => {
      const veydr = await launchVeydr({ configHome: f.seeded.configHome })
      f.apps.push(veydr)
      await start(veydr, STUBBORN_ID, 'stubborn')
      await expect.poll(() => readLedger(f.ledger).length).toBe(1)
      await expect.poll(() => recordedRuns(f.seeded.configHome)?.length).toBe(1)

      const exit = exited(veydr.app)
      const started = Date.now()
      veydr.app.process().kill('SIGTERM')
      // The command ignores SIGTERM and has an 8 s stop timeout; the second signal does not wait for it.
      await veydr.window.getByTestId('quit-overlay').waitFor()
      veydr.app.process().kill('SIGTERM')
      expect(await exit).toBe(143)
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(taggedProcesses(f.tag)).toHaveLength(1)
      expect(recordedRuns(f.seeded.configHome)).toHaveLength(1)
    },
  )
})
