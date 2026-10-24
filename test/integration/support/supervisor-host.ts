// A minimal stand-in for the Veydr main process, bundled and run as its own process by
// test/integration/crash-recovery.test.ts so that the test can SIGKILL it (design D14). It uses
// the real supervisor, Linux process tree, and runtime ledger.
//
//   node host.cjs '<json HostOptions>'
//
// Prints `ready` once the run and all its expected descendants are recorded in the ledger on disk.
// On `quit` (a line on stdin) it stops everything like a clean quit, flushes the ledger, prints
// `stopped`, and exits.
import { createInterface } from 'node:readline'
import { createDiagnosticLog } from '../../../src/main/app/diagnostics'
import { createLinuxProcessTree } from '../../../src/main/platform/linux/process-tree'
import { createRunLedger } from '../../../src/main/supervisor/ledger'
import { createInterimPlanner } from '../../../src/main/supervisor/plan'
import { createProcessStateRegistry } from '../../../src/main/supervisor/state'
import { createSupervisor, type LaunchTarget } from '../../../src/main/supervisor/supervisor'

export interface HostOptions {
  readonly configDir: string
  readonly target: LaunchTarget
  /** Descendants (besides the leader) the ledger must hold before the host reports `ready`. */
  readonly descendants: number
}

const options = JSON.parse(process.argv[2] ?? '') as HostOptions
const log = createDiagnosticLog((line) => process.stderr.write(`${line}\n`))
const ledger = createRunLedger({ dir: options.configDir, log })
const supervisor = createSupervisor({
  // A short scan interval keeps the test fast; attribution works the same way.
  processTree: createLinuxProcessTree({ log, scanIntervalMs: 100 }),
  states: createProcessStateRegistry(() => undefined),
  lookup: (id) => (id === options.target.command.id ? options.target : null),
  plan: createInterimPlanner(process.env),
  ledger,
  log,
})

async function main(): Promise<void> {
  await ledger.load()
  const state = await supervisor.start(options.target.command.id)
  if (state.status !== 'running') throw new Error(`could not start: ${state.error ?? state.status}`)
  const deadline = Date.now() + 15_000
  for (;;) {
    await ledger.flush()
    const [entry] = ledger.sessionEntries()
    if (entry !== undefined && entry.descendants.length >= options.descendants) break
    if (Date.now() > deadline) throw new Error('descendants were not recorded in time')
    await new Promise((done) => setTimeout(done, 50))
  }
  process.stdout.write('ready\n')

  for await (const line of createInterface({ input: process.stdin })) {
    if (line !== 'quit') continue
    await supervisor.stopAll()
    await ledger.flush()
    process.stdout.write('stopped\n')
    process.exit(0)
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`host failed: ${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(1)
})
