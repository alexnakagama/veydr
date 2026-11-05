// A minimal stand-in for the Veydr main process on Windows, bundled and run as its own process by
// test/integration/windows-process-tree.test.ts so that the test can end it with `taskkill /F`
// (add-windows-process-supervision design D7, task 5.2). It owns one run through the real Windows
// process tree and records it in the real runtime ledger, as the supervisor does.
//
//   node host.cjs '<json WindowsHostOptions>'
//
// Prints `ready` once the run and at least `descendants` descendants are recorded on disk, then
// keeps running until it is ended.
import { createDiagnosticLog } from '../../../src/main/app/diagnostics'
import type { SpawnPlan } from '../../../src/main/platform/types'
import { createWindowsProcessTree } from '../../../src/main/platform/windows/process-tree'
import { createRunLedger } from '../../../src/main/supervisor/ledger'

export interface WindowsHostOptions {
  readonly configDir: string
  readonly helperPath: string
  readonly plan: SpawnPlan
  /** Descendants (besides the leader) the ledger must hold before the host reports `ready`. */
  readonly descendants: number
}

const RUN_ID = 'windows-host-run'
const options = JSON.parse(process.argv[2] ?? '') as WindowsHostOptions
const log = createDiagnosticLog((line) => process.stderr.write(`${line}\n`))
const ledger = createRunLedger({ dir: options.configDir, log, directorySync: false })

async function main(): Promise<void> {
  await ledger.load()
  const run = await createWindowsProcessTree({ helperPath: options.helperPath, log }).spawn(options.plan)
  await ledger.add({ commandId: 'windows-host-command', runId: RUN_ID, leader: run.identity, sessionId: run.sessionId, descendants: [] })
  run.onDescendantsChange((descendants) => ledger.updateDescendants(RUN_ID, descendants))
  const deadline = Date.now() + 15_000
  for (;;) {
    await ledger.flush()
    const [entry] = ledger.sessionEntries()
    if (entry !== undefined && entry.descendants.length >= options.descendants) break
    if (Date.now() > deadline) throw new Error('descendants were not recorded in time')
    await new Promise((done) => setTimeout(done, 50))
  }
  process.stdout.write('ready\n')
  // Alive until the test ends it.
  setInterval(() => undefined, 1 << 30)
}

main().catch((error: unknown) => {
  process.stderr.write(`host failed: ${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(1)
})
