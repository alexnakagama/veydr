// Test-side view of real processes. Deliberately independent of Veydr's own /proc code and
// bookkeeping (design D14): cleanup is proven by enumerating /proc here, not by asking Veydr.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const fixturesDir = resolve(__dirname, '../fixtures/proc')
export const fixture = (name: 'tree' | 'escape' | 'flood' | 'listen' | 'sentinel'): string => join(fixturesDir, `${name}.mjs`)

/** Environment variable every fixture process inherits; its value identifies one test's processes. */
export const TAG_VARIABLE = 'VEYDR_FIXTURE_TAG'

/** Repetitions of each process-tree scenario: 50 with `VEYDR_STRESS=1`, 5 otherwise (design D14). */
export const REPETITIONS = process.env['VEYDR_STRESS'] === '1' ? 50 : 5

export interface LedgerEntry {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  readonly sid: number
  readonly starttime: string
  readonly role: string
  readonly port?: number | null
}

export interface ProcessView {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  readonly sid: number
  readonly state: string
  readonly starttime: string
}

export function readProcess(pid: number): ProcessView | null {
  let text: string
  try {
    text = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return null
  }
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(' ')
  return {
    pid,
    state: fields[0] ?? '?',
    ppid: Number(fields[1]),
    pgid: Number(fields[2]),
    sid: Number(fields[3]),
    starttime: fields[19] ?? '',
  }
}

/** True if the process `pid` started at `starttime` exists and is not a zombie. */
export function isAlive(pid: number, starttime: string): boolean {
  const view = readProcess(pid)
  return view !== null && view.starttime === starttime && view.state !== 'Z' && view.state !== 'X'
}

/** Every live (non-zombie) process whose environment carries `VEYDR_FIXTURE_TAG=<tag>`. */
export function taggedProcesses(tag: string): ProcessView[] {
  const needle = `${TAG_VARIABLE}=${tag}`
  const found: ProcessView[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    let environ: string
    try {
      environ = readFileSync(`/proc/${name}/environ`, 'latin1')
    } catch {
      continue
    }
    if (!environ.split('\0').includes(needle)) continue
    const view = readProcess(Number(name))
    if (view !== null && view.state !== 'Z' && view.state !== 'X') found.push(view)
  }
  return found.sort((a, b) => a.pid - b.pid)
}

/** SIGKILLs every tagged process (test cleanup; never used to prove anything). */
export function killTagged(tag: string): void {
  for (const view of taggedProcesses(tag)) {
    try {
      process.kill(view.pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
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
  if (entry === undefined) throw new Error('sentinel did not start')
  return {
    pid: entry.pid,
    starttime: entry.starttime,
    signals: () => (existsSync(signalsFile) ? readFileSync(signalsFile, 'utf8').split('\n').filter((s) => s !== '') : []),
    alive: () => isAlive(entry.pid, entry.starttime),
    stop() {
      child.kill('SIGKILL')
      own.cleanup()
    },
  }
}
