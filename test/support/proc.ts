// Process-test fixtures: the fixture scripts, their ledger, scenarios, and the sentinel (foundation
// design D14). Which processes exist is read by test/support/processes.ts, independently of Veydr's
// own process code and bookkeeping, on Linux and on Windows.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isAlive, killTagged, TAG_VARIABLE } from './processes'

export { TAG_VARIABLE } from './processes'

export const fixturesDir = resolve(__dirname, '../fixtures/proc')
export const fixture = (name: 'tree' | 'escape' | 'flood' | 'lines' | 'listen' | 'sentinel' | 'inspect' | 'print'): string => join(fixturesDir, `${name}.mjs`)

/** Repetitions of each process-tree scenario: 50 with `VEYDR_STRESS=1`, 5 otherwise (design D14). */
export const REPETITIONS = process.env['VEYDR_STRESS'] === '1' ? 50 : 5

/**
 * One line of a fixture ledger (`test/fixtures/proc/ledger.mjs`). `pid`, `ppid` and `role` are
 * recorded everywhere; the process group, session and start time come from `/proc/self/stat` and
 * are recorded only where it exists, so only `[linux-only: /proc]` tests may read them.
 */
export interface LedgerEntry {
  readonly pid: number
  readonly ppid: number
  readonly pgid?: number
  readonly sid?: number
  readonly starttime?: string
  readonly role: string
  readonly port?: number | null
  readonly ports?: readonly number[]
}

export function readLedger(path: string): LedgerEntry[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as LedgerEntry)
}

export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

export async function waitUntil(condition: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(20)
  }
}

export async function waitForLedger(path: string, count: number, timeoutMs = 15_000): Promise<LedgerEntry[]> {
  await waitUntil(() => readLedger(path).length >= count, `${count} ledger entries in ${path}`, timeoutMs)
  return readLedger(path)
}

/** Number of processes in a `tree.mjs` tree: 1 + fanout + fanout² + … + fanout^depth. */
export function treeSize(depth: number, fanout: number): number {
  let size = 0
  for (let level = 0, width = 1; level <= depth; level++, width *= fanout) size += width
  return size
}

/** A scratch directory and a unique tag for one scenario; `cleanup` kills leftovers and removes files. */
export interface Scenario {
  readonly dir: string
  readonly tag: string
  readonly ledger: string
  /** The test runner's environment plus the scenario's tag. */
  readonly env: Record<string, string>
  cleanup(): void
}

export function scenario(): Scenario {
  const dir = mkdtempSync(join(tmpdir(), 'veydr-proc-'))
  const tag = randomUUID()
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  env[TAG_VARIABLE] = tag
  return {
    dir,
    tag,
    ledger: join(dir, 'ledger.jsonl'),
    env,
    cleanup() {
      killTagged(tag)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * An unrelated process started outside the supervisor (design D14 sentinel). It must still be
 * alive, and must have received no signal, after every scenario.
 */
export interface Sentinel {
  readonly pid: number
  readonly starttime: string
  /** Catchable signals the sentinel received. */
  signals(): string[]
  alive(): boolean
  stop(): void
}

export async function startSentinel(): Promise<Sentinel> {
  const own = scenario()
  const signalsFile = join(own.dir, 'signals.txt')
  const child: ChildProcess = spawn(process.execPath, [fixture('sentinel'), '--ledger', own.ledger, '--signals', signalsFile], {
    env: own.env,
    stdio: 'ignore',
  })
  const [entry] = await waitForLedger(own.ledger, 1)
  if (entry?.starttime === undefined) throw new Error('sentinel did not start, or recorded no start time')
  const { pid, starttime } = entry
  return {
    pid,
    starttime,
    signals: () => (existsSync(signalsFile) ? readFileSync(signalsFile, 'utf8').split('\n').filter((s) => s !== '') : []),
    alive: () => isAlive(pid, starttime),
    stop() {
      child.kill('SIGKILL')
      own.cleanup()
    },
  }
}
