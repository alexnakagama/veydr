import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { build } from 'vite'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createLinuxSurvivors } from '../../src/main/platform/linux/survivors'
import { linuxIdentity } from '../../src/main/platform/linux/process-tree'
import type { LedgerEntry } from '../../src/main/platform/types'
import { createRunLedger, ledgerPath } from '../../src/main/supervisor/ledger'
import { command, project, quietLog } from '../unit/support/config'
import { fixture, REPETITIONS, scenario, startSentinel, TAG_VARIABLE, taggedProcesses, treeSize, type Scenario, type Sentinel } from '../support/proc'
import type { HostOptions } from './support/supervisor-host'

// Tasks 5.1 and 5.2: the runtime ledger written by a real supervisor process, and survivors found
// after that process is SIGKILLed. Cleanup is checked by tag enumeration (test/support/proc.ts),
// independently of Veydr's bookkeeping, and a sentinel started outside must stay untouched.

let bundleDir: string
let hostScript: string
let sentinel: Sentinel

beforeAll(async () => {
  // The host imports the TypeScript sources; bundle it into one CommonJS file Node can run.
  bundleDir = mkdtempSync(join(tmpdir(), 'veydr-host-'))
  await build({
    configFile: false,
    logLevel: 'silent',
    ssr: { noExternal: true },
    build: {
      ssr: join(__dirname, 'support/supervisor-host.ts'),
      outDir: bundleDir,
      emptyOutDir: true,
      minify: false,
      rolldownOptions: { output: { format: 'cjs', entryFileNames: 'host.cjs' } },
    },
  })
  hostScript = join(bundleDir, 'host.cjs')
  sentinel = await startSentinel()
}, 60_000)

afterAll(() => {
  sentinel.stop()
  rmSync(bundleDir, { recursive: true, force: true })
})

const scenarios: Scenario[] = []
const hosts: ChildProcess[] = []
afterEach(() => {
  for (const host of hosts.splice(0)) host.kill('SIGKILL')
  for (const s of scenarios.splice(0)) s.cleanup()
  expect(sentinel.alive(), 'sentinel alive').toBe(true)
  expect(sentinel.signals(), 'signals received by the sentinel').toEqual([])
})

interface Host {
  readonly child: ChildProcess
  readonly configDir: string
  /** Resolves with the next line the host prints. */
  next(): Promise<string>
}

/** Starts a host supervising a depth-2/fan-out-2 tree whose first child starts its own session. */
async function startHost(s: Scenario): Promise<Host> {
  const env = [{ key: TAG_VARIABLE, value: s.tag, secret: false }]
  const cmd = command({
    execution: { mode: 'direct', file: process.execPath, args: [fixture('tree'), '--ledger', s.ledger, '--depth', '2', '--fanout', '2', '--escape'] },
    env,
    stopTimeoutMs: 2_000,
  })
  const configDir = join(s.dir, 'config')
  const options: HostOptions = { configDir, target: { project: project({ path: s.dir, commands: [cmd] }), command: cmd }, descendants: treeSize(2, 2) - 1 }
  const child = spawn(process.execPath, [hostScript, JSON.stringify(options)], { stdio: ['pipe', 'pipe', 'inherit'] })
  hosts.push(child)
  const lines = createInterface({ input: child.stdout ?? process.stdin })[Symbol.asyncIterator]()
  const host: Host = {
    child,
    configDir,
    async next() {
      const { value, done } = await lines.next()
      if (done === true) throw new Error('host ended')
      return value
    },
  }
  expect(await host.next()).toBe('ready')
  return host
}

function track(): Scenario {
  const s = scenario()
  scenarios.push(s)
  return s
}

const onDisk = (configDir: string): { entries: LedgerEntry[] } => JSON.parse(readFileSync(ledgerPath(configDir), 'utf8')) as { entries: LedgerEntry[] }

describe('crash recovery on Linux', () => {
  it('records the run with its leader, session, and every descendant, and clears it on a clean shutdown', async () => {
    const s = track()
    const host = await startHost(s)
    const tagged = taggedProcesses(s.tag)
    expect(tagged).toHaveLength(treeSize(2, 2))
    const [entry] = onDisk(host.configDir).entries
    const leader = tagged.find((p) => p.pid === entry?.leader.pid)
    expect(leader, 'the recorded leader is a tagged process').toBeDefined()
    expect(entry?.sessionId).toBe(leader?.pid)
    expect(entry?.descendants.map((d) => d.pid).sort((a, b) => a - b)).toEqual(tagged.filter((p) => p !== leader).map((p) => p.pid))

    host.child.stdin?.write('quit\n')
    expect(await host.next()).toBe('stopped')
    await once(host.child, 'exit')
    expect(onDisk(host.configDir)).toEqual({ version: 1, entries: [] })
    expect(taggedProcesses(s.tag)).toEqual([])
  })

  it(`finds every surviving process after the supervisor host is SIGKILLed, and no unrelated or stale-PID process (${REPETITIONS} repetitions)`, async () => {
    for (let i = 0; i < REPETITIONS; i += 1) {
      const s = track()
      const host = await startHost(s)
      host.child.kill('SIGKILL')
      await once(host.child, 'exit')
      const alive = taggedProcesses(s.tag)
      expect(alive).toHaveLength(treeSize(2, 2))

      // What the next launch reads, plus a stale record whose PIDs now belong to unrelated
      // processes: the sentinel and this test runner (same PID, different start time).
      const { entries } = await createRunLedger({ dir: host.configDir, log: quietLog() }).load()
      expect(entries).toHaveLength(1)
      const stale: LedgerEntry = {
        commandId: 'stale',
        runId: 'stale-run',
        leader: { ...linuxIdentity(bootIdOf(entries), { pid: sentinel.pid, starttime: Number(sentinel.starttime) + 1 }) },
        sessionId: sentinel.pid,
        descendants: [linuxIdentity(bootIdOf(entries), { pid: process.pid, starttime: 1 })],
      }
      const survivors = createLinuxSurvivors({ log: quietLog() })
      const found = await survivors.findSurvivors([...entries, stale])
      expect(found.map((f) => f.identity.pid).sort((a, b) => a - b)).toEqual(alive.map((p) => p.pid))
      expect(found.every((f) => f.runId === entries[0]?.runId)).toBe(true)
      expect(found.every((f) => f.info.commandLine.includes(fixture('tree')))).toBe(true)

      const result = await survivors.terminateSurvivors(found)
      expect(result).toMatchObject({ survivors: [] })
      expect(taggedProcesses(s.tag)).toEqual([])
      s.cleanup()
      scenarios.splice(scenarios.indexOf(s), 1)
    }
  })
})

/** The boot ID recorded in the identities of `entries`. */
function bootIdOf(entries: readonly LedgerEntry[]): string {
  const token = entries[0]?.leader.token ?? ''
  return token.slice(0, token.lastIndexOf(':'))
}
