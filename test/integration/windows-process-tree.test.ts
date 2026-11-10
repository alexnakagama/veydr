import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { isMainThread } from 'node:worker_threads'
import { build } from 'vite'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { HELPER_PATH } from '../../scripts/build-windows-helper.mjs'
import { CORPUS, sentinelFor } from '../../scripts/windows-probe/cmd-corpus.mjs'
import type { ExitInfo, LedgerEntry, ManagedProcess, ProcessIdentity, SpawnPlan, StopResult, Survivor } from '../../src/main/platform/types'
import { batchCommandLine, CommandLineError, helperLaunch, MAX_COMMAND_LINE, shellCommandLine } from '../../src/main/platform/windows/command-line'
import { randomPipePath } from '../../src/main/platform/windows/helper-client'
import { encodeRunRequest } from '../../src/main/platform/windows/protocol'
import { windowsIdentity } from '../../src/main/platform/windows/identity'
import { createWindowsProcessTree } from '../../src/main/platform/windows/process-tree'
import { createRunLedger, ledgerPath } from '../../src/main/supervisor/ledger'
import { REPETITIONS, sleep } from '../support/proc'
import { quietLog } from '../unit/support/config'
import { collect, creationTimes, helpersOf, marked, parseArray, powershell, visibleWindowOwners, waitUntil, type MarkedProcess } from './support/windows'
import type { WindowsHostOptions } from './support/windows-tree-host'

// The Windows process tree against real Windows processes (add-windows-process-supervision design D7).
// It needs Job Objects and the helper built by `node scripts/build-windows-helper.mjs`, which the
// `windows` CI job runs first. A missing helper fails these tests; it never skips them.
//
// Every claim about which processes remain is checked independently of the helper, by enumerating
// Win32_Process for the scenario's marker, and a sentinel started outside Veydr must survive every
// scenario and receive no console event.

/** The protocol version the helper must report (design D2; W2 design D1; W3 design D2). */
const PROTOCOL_VERSION = '3'

const TREE = resolve(__dirname, '../fixtures/windows/tree.mjs')
const OUTPUT = resolve(__dirname, '../fixtures/windows/output.mjs')
const FREE_CONSOLE = resolve(__dirname, '../fixtures/windows/free-console.ps1')
const RECORD_ARGS = resolve(__dirname, '../fixtures/windows/record-args.mjs')
const CMD_EXE = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe')
const POWERSHELL = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** A `graceMs` far longer than any graceful stop takes, and the bound such a stop must stay under. */
const LONG_GRACE_MS = 30_000
const WELL_BEFORE_GRACE_MS = 10_000

const runHelper = (...args: string[]) => spawnSync(HELPER_PATH, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 })

/** Image names of the live processes among `pids`; a PID that has exited is left out. */
function liveNames(pids: readonly number[]): Map<number, string> {
  if (pids.length === 0) return new Map()
  const filter = pids.map((pid) => `ProcessId = ${String(Math.trunc(pid))}`).join(' OR ')
  const output = powershell(
    `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name } })`,
  )
  return new Map((parseArray(output) as MarkedProcess[]).map((p) => [p.pid, p.name]))
}

/**
 * Checks that the run's job, as `attributed()` and `remaining()` each report it, is exactly
 * `expected` plus any console hosts (conhost.exe), which may join the job. Each answer is judged on
 * its own, so a console host that comes or goes between the two requests cannot make it flaky.
 */
async function expectMembers(run: ManagedProcess, expected: readonly number[]): Promise<void> {
  const answers: [string, number[]][] = [
    ['attributed', (await run.attributed()).map((identity) => identity.pid)],
    ['remaining', (await run.remaining()).map((info) => info.pid)],
  ]
  for (const [what, pids] of answers) {
    expect(sorted(pids.filter((pid) => expected.includes(pid))), what).toEqual(sorted(expected))
    const names = liveNames(pids.filter((pid) => !expected.includes(pid)))
    expect([...names.values()].filter((name) => name.toLowerCase() !== 'conhost.exe'), `${what}: other members`).toEqual([])
  }
}

/**
 * PIDs of the processes on the console of a PowerShell started like the sentinel (inheriting the
 * runner's console). If the runner had no console, that PowerShell would get one of its own.
 */
function runnerConsoleProcesses(): number[] {
  const encoded = Buffer.from(
    `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class VeydrConsole {
  [DllImport("kernel32.dll")] static extern uint GetConsoleProcessList(uint[] list, uint count);
  public static uint[] Processes() {
    uint[] list = new uint[1024];
    uint count = GetConsoleProcessList(list, (uint)list.Length);
    uint[] result = new uint[count > list.Length ? 0 : count];
    System.Array.Copy(list, result, result.Length);
    return result;
  }
}
'@
ConvertTo-Json -Compress -InputObject @([VeydrConsole]::Processes() | ForEach-Object { [int]$_ })`,
    'utf16le',
  ).toString('base64')
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (run.status !== 0) throw new Error(`could not list the runner's console: ${run.stderr}`)
  return parseArray(run.stdout) as number[]
}

const sorted = (pids: readonly number[]): number[] => [...pids].sort((a, b) => a - b)

/** The identities of the live processes `pids`, in order, read in one go independently of the helper. */
function identitiesOf(pids: readonly number[]): ProcessIdentity[] {
  const times = creationTimes(pids)
  return pids.map((pid) => {
    const created = times.get(pid)
    if (created === undefined) throw new Error(`process ${pid} is not running`)
    return windowsIdentity(pid, created)
  })
}

/** A ledger entry for `leader` and `descendants`, as the supervisor records one. */
const ledgerEntry = (leader: ProcessIdentity, descendants: readonly ProcessIdentity[] = []): LedgerEntry => ({
  commandId: 'recorded-command',
  runId: `recorded-run-${randomUUID()}`,
  leader,
  sessionId: null,
  descendants,
})

/** PIDs of the leaders and descendants in the runtime ledger on disk under `configDir`; none while it is unwritten. */
function recordedPids(configDir: string): number[] {
  let ledger: { entries?: LedgerEntry[] }
  try {
    ledger = JSON.parse(readFileSync(ledgerPath(configDir), 'utf8')) as { entries?: LedgerEntry[] }
  } catch {
    return []
  }
  return (ledger.entries ?? []).flatMap((entry) => [entry.leader.pid, ...entry.descendants.map((d) => d.pid)])
}

/** Ends `pid` as `taskkill /F` does (TerminateProcess), with no chance to clean up. */
function forceKill(pid: number): void {
  execFileSync('taskkill.exe', ['/F', '/PID', String(Math.trunc(pid))], { windowsHide: true, stdio: 'ignore', timeout: 30_000 })
}

interface Scenario {
  readonly dir: string
  readonly marker: string
  /** PIDs of the fixture processes that reported themselves ready, by role. */
  ready(): Record<string, number>
  plan(script: string, args: readonly string[]): SpawnPlan
  cleanup(): void
}

function scenario(): Scenario {
  const dir = mkdtempSync(join(tmpdir(), 'veydr-win-'))
  const marker = randomUUID()
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  return {
    dir,
    marker,
    ready() {
      const pids: Record<string, number> = {}
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue
        pids[name.slice(0, -'.json'.length)] = (JSON.parse(readFileSync(join(dir, name), 'utf8')) as { pid: number }).pid
      }
      return pids
    },
    plan: (script, args) => ({ file: process.execPath, args: [script, '--marker', marker, '--dir', dir, ...args], cwd: dir, env }),
    cleanup() {
      cleanupScenarios([this])
    },
  }
}

/**
 * Ends whatever the scenarios left behind (a passing one leaves nothing) and removes their
 * directories, with one PowerShell query for all of them: a test may use dozens of scenarios, and
 * one PowerShell start each would outlast the afterEach hook's time limit.
 */
function cleanupScenarios(list: readonly Pick<Scenario, 'dir' | 'marker'>[]): void {
  if (list.length === 0) return
  const markers = list.map((s) => {
    if (!/^[0-9a-f-]+$/.test(s.marker)) throw new Error(`not a marker: ${s.marker}`)
    return `'${s.marker}'`
  })
  powershell(
    `$markers = @(${markers.join(',')})
     Get-CimInstance Win32_Process | Where-Object {
       $line = $_.CommandLine
       $_.ProcessId -ne $PID -and $null -ne $line -and @($markers | Where-Object { $line.Contains($_) }).Count -gt 0
     } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  )
  for (const s of list) rmSync(s.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

interface Sentinel {
  readonly pid: number
  alive(): boolean
  /** Console events the sentinel received. */
  events(): string[]
  stop(): void
}

/**
 * An unrelated Node process on the test runner's own console, started outside Veydr (design D7):
 * without `windowsHide`, which would give it a console of its own that no event for the runner's
 * console could reach. That it shares the runner's console is checked, since it guards against
 * console events that reach beyond a command (group 4) only then.
 */
async function startSentinel(): Promise<Sentinel> {
  const own = scenario()
  const eventsFile = join(own.dir, 'events.txt')
  const child: ChildProcess = spawn(process.execPath, [TREE, '--marker', own.marker, '--dir', own.dir, '--role', 'sentinel', '--sentinel', eventsFile], {
    stdio: 'ignore',
  })
  await waitUntil(() => own.ready()['sentinel'] !== undefined, 'the sentinel')
  const consoleProcesses = runnerConsoleProcesses()
  expect(consoleProcesses, 'the test runner has a console, shared with the sentinel').toEqual(
    expect.arrayContaining([process.pid, own.ready()['sentinel'] as number]),
  )
  return {
    pid: own.ready()['sentinel'] as number,
    alive: () => child.exitCode === null && child.signalCode === null,
    events: () => eventsIn(eventsFile),
    stop() {
      child.kill()
      own.cleanup()
    },
  }
}

const exitOf = (run: ManagedProcess): Promise<ExitInfo> => new Promise((done) => run.onExit(done))

/** Stops `run` and measures how long the stop took. */
async function timedStop(run: ManagedProcess, graceMs: number): Promise<{ result: StopResult; elapsedMs: number }> {
  const started = performance.now()
  const result = await run.stop({ graceMs })
  return { result, elapsedMs: performance.now() - started }
}

/** The console events a fixture started with `--sentinel <file>` has received. */
const eventsIn = (file: string): string[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line !== '') : [])

const timeout = (perRepetitionMs: number): number => 30_000 + REPETITIONS * perRepetitionMs

/** What a hand-driven `veydr-helper run` reported (`rawRun`): the pipe's lines after `ready`. */
interface RawRun {
  readonly lines: Record<string, unknown>[]
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
}

describe.skipIf(process.platform !== 'win32')('[windows-only: Job Objects]', () => {
  const tree = createWindowsProcessTree({ helperPath: HELPER_PATH })
  const scenarios: Scenario[] = []
  let sentinel: Sentinel | undefined

  beforeAll(async () => {
    sentinel = await startSentinel()
  }, 60_000)
  afterAll(() => {
    sentinel?.stop()
  })
  afterEach(() => {
    cleanupScenarios(scenarios.splice(0))
    expect(sentinel?.alive(), 'sentinel alive').toBe(true)
    expect(sentinel?.events(), 'console events received by the sentinel').toEqual([])
  })

  /**
   * Repeats a scenario `REPETITIONS` times (50 under VEYDR_STRESS=1), each with fresh processes, and
   * checks after each that nothing of it is left: no fixture process, and no helper.
   */
  async function repeat(run: (s: Scenario) => Promise<void>): Promise<void> {
    for (let i = 0; i < REPETITIONS; i++) {
      const s = scenario()
      scenarios.push(s)
      await run(s)
      expect(marked(s.marker), `leaked processes (repetition ${i})`).toEqual([])
      // The helper exits once its job is empty (design D1).
      await waitUntil(() => helpersOf([process.pid]).length === 0, `the helper to exit (repetition ${i})`)
    }
  }

  /** Starts `plan`, and waits until the fixture processes named in `roles` are running. */
  async function startTree(s: Scenario, args: readonly string[], roles: readonly string[]): Promise<{ run: ManagedProcess; pids: number[] }> {
    const run = await tree.spawn(s.plan(TREE, args))
    await waitUntil(() => roles.every((role) => s.ready()[role] !== undefined), `processes ${roles.join(', ')}`)
    const ready = s.ready()
    return { run, pids: roles.map((role) => ready[role] as number) }
  }

  it('has the built helper', () => {
    expect(existsSync(HELPER_PATH), `${HELPER_PATH} is missing: run node scripts/build-windows-helper.mjs`).toBe(true)
  })

  it('prints the protocol version', () => {
    const run = runHelper('version')
    expect(run.error).toBeUndefined()
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toBe(PROTOCOL_VERSION)
    expect(run.stderr).toBe('')
  })

  it('refuses an unknown subcommand with a usage line and exit code 2', () => {
    // Version 2: `run` takes the pipe and nothing else (W2 design D1).
    for (const args of [[], ['frobnicate'], ['version', 'extra'], ['run'], ['run', '\\\\.\\pipe\\x', 'C:\\Windows\\System32\\cmd.exe']]) {
      const run = runHelper(...args)
      expect(run.status, args.join(' ')).toBe(2)
      expect(run.stdout, args.join(' ')).toBe('')
      expect(run.stderr, args.join(' ')).toContain('usage: veydr-helper')
    }
  })

  it("the console host refuses a console it shares, and leaves that console's code page alone", () => {
    // Without windowsHide the host inherits the runner's console, which the runner shares.
    const codePage = (): string => execFileSync('cmd.exe', ['/d', '/c', 'chcp'], { encoding: 'utf8', timeout: 30_000 }).trim()
    const before = codePage()
    const run = spawnSync(HELPER_PATH, ['console'], { encoding: 'utf8', input: '', timeout: 30_000 })
    expect(run.status).toBe(1)
    expect(run.stdout).toMatch(/^its console is shared with \d+ other processes\r?\n$/)
    expect(codePage()).toBe(before)
  })

  it(
    '[spec:process-supervision/children-and-grandchildren-stopped-on-windows] ends every process of the tree',
    async () => {
      await repeat(async (s) => {
        const roles = ['root', 'root.0', 'root.1', 'root.0.0', 'root.0.1', 'root.1.0', 'root.1.1']
        const { run, pids } = await startTree(s, ['--depth', '2', '--fanout', '2'], roles)
        expect(run.pid).toBe(pids[0])
        const exit = exitOf(run)
        // The job holds the whole tree, as Win32_Process sees it.
        expect(sorted(marked(s.marker).map((p) => p.pid))).toEqual(sorted(pids))
        await expectMembers(run, pids)

        const result = await run.stop({ graceMs: 5_000 })
        expect(result.survivors).toEqual([])
        expect(await exit).toMatchObject({ signal: null })
        expect(await run.remaining()).toEqual([])
      })
    },
    timeout(15_000),
  )

  it(
    '[spec:process-supervision/orphaned-descendant-stopped-on-windows] ends a grandchild whose parent has exited',
    async () => {
      await repeat(async (s) => {
        const { run, pids } = await startTree(s, ['--orphan'], ['root', 'root.0', 'root.0.0'])
        const [root, child, grandchild] = pids as [number, number, number]
        await waitUntil(() => !marked(s.marker).some((p) => p.pid === child), 'the child to exit')
        expect(sorted(marked(s.marker).map((p) => p.pid))).toEqual(sorted([root, grandchild]))
        await expectMembers(run, [root, grandchild])

        const result = await run.stop({ graceMs: 5_000 })
        expect(result.survivors).toEqual([])
      })
    },
    timeout(15_000),
  )

  it(
    '[spec:process-supervision/descendant-started-immediately] keeps a child started as the very first action in the job',
    async () => {
      await repeat(async (s) => {
        const run = await tree.spawn(s.plan(TREE, ['--first']))
        // The leader started a detached child and exited at once; the child is still in the job.
        const exit = await exitOf(run)
        expect(exit).toMatchObject({ code: 0, forced: false })
        await waitUntil(() => s.ready()['root.0'] !== undefined, 'the child')
        const child = s.ready()['root.0'] as number
        expect(marked(s.marker).map((p) => p.pid)).toEqual([child])
        await expectMembers(run, [child])

        const result = await run.stop({ graceMs: 5_000 })
        expect(result).toMatchObject({ forced: true, survivors: [] })
      })
    },
    timeout(15_000),
  )

  it(
    '[spec:process-supervision/uncooperative-process-on-windows] forcibly ends a tree that ignores Ctrl+Break',
    async () => {
      await repeat(async (s) => {
        const { run } = await startTree(s, ['--depth', '1', '--fanout', '2', '--ignore-break'], ['root', 'root.0', 'root.1'])
        const exit = exitOf(run)
        const result = await run.stop({ graceMs: 1_000 })
        expect(result).toEqual({ graceful: 'no', forced: true, survivors: [] })
        expect(await exit).toMatchObject({ forced: true, signal: null })
      })
    },
    timeout(15_000),
  )

  it(
    'passes the command its output streams unchanged',
    async () => {
      await repeat(async (s) => {
        // Every byte value, CRLF and a lone LF, and invalid UTF-8: nothing may be translated.
        const stdoutBytes = Buffer.alloc(1024 * 1024, Buffer.from(Array.from({ length: 256 }, (_, i) => i)))
        const stderrBytes = Buffer.concat([Buffer.from('error ✓\r\nline\n', 'utf8'), Buffer.from([0xff, 0xfe, 0x00, 0xc3]), Buffer.alloc(64 * 1024, 0xa5)])
        writeFileSync(join(s.dir, 'stdout.bin'), stdoutBytes)
        writeFileSync(join(s.dir, 'stderr.bin'), stderrBytes)
        const run = await tree.spawn(
          s.plan(OUTPUT, ['--stdout', join(s.dir, 'stdout.bin'), '--stderr', join(s.dir, 'stderr.bin'), '--exit-code', '3']),
        )
        const collect = (stream: NodeJS.ReadableStream): Promise<Buffer> =>
          new Promise((done, fail) => {
            const chunks: Buffer[] = []
            stream.on('data', (chunk: Buffer) => chunks.push(chunk))
            stream.on('end', () => done(Buffer.concat(chunks)))
            stream.on('error', fail)
          })
        const [stdout, stderr, exit] = await Promise.all([collect(run.stdout), collect(run.stderr), exitOf(run)])
        expect(exit).toEqual({ code: 3, signal: null, forced: false })
        expect(stdout.equals(stdoutBytes), 'stdout unchanged').toBe(true)
        expect(stderr.equals(stderrBytes), 'stderr unchanged').toBe(true)
      })
    },
    timeout(15_000),
  )

  it(
    'shows no console window for the command and its children',
    async () => {
      await repeat(async (s) => {
        const { run, pids } = await startTree(s, ['--depth', '1', '--fanout', '1'], ['root', 'root.0'])
        expect(sorted(marked(s.marker).map((p) => p.pid))).toEqual(sorted(pids))
        expect(visibleWindowOwners(s.marker), 'processes showing a window').toEqual([])
        expect((await run.stop({ graceMs: 5_000 })).survivors).toEqual([])
      })
    },
    timeout(15_000),
  )

  it(
    '[spec:process-supervision/cooperative-process-on-windows] stops a tree that exits on Ctrl+Break gracefully, showing no window',
    async () => {
      await repeat(async (s) => {
        // Node's default for Ctrl+Break (SIGBREAK) is to exit.
        const { run } = await startTree(s, ['--depth', '1', '--fanout', '2'], ['root', 'root.0', 'root.1'])
        const exit = exitOf(run)
        expect(visibleWindowOwners(s.marker), 'processes showing a window before the stop').toEqual([])

        // While the helper attaches to the command's hidden console, nothing may become visible.
        // Sampled until the stop settles, at least twice: the event loop runs between samples, so
        // the `stop` line has reached the helper by the second one.
        // `stopping` is handled from the start, so a failed stop is reported by the `await` below
        // rather than as an unhandled rejection while the samples are taken.
        let settled = false
        const stopping = timedStop(run, LONG_GRACE_MS)
        const markSettled = (): void => {
          settled = true
        }
        stopping.then(markSettled, markSettled)
        const samples: number[][] = []
        while (!settled || samples.length < 2) {
          samples.push(visibleWindowOwners(s.marker))
          await sleep(50)
        }
        expect(samples.flat(), 'processes showing a window during the stop').toEqual([])
        const { result, elapsedMs } = await stopping
        expect(result).toEqual({ graceful: 'yes', forced: false, survivors: [] })
        expect(elapsedMs).toBeLessThan(WELL_BEFORE_GRACE_MS)
        expect(await exit).toMatchObject({ forced: false, signal: null })
      })
    },
    timeout(20_000),
  )

  it(
    '[spec:process-supervision/batch-file-command-stopped-gracefully] stops a batch-file command without the Terminate batch job prompt',
    async () => {
      await repeat(async (s) => {
        // The marker in the batch file's name puts cmd.exe among the processes checked for leaks.
        const batch = join(s.dir, `run-${s.marker}.cmd`)
        writeFileSync(batch, `@"${process.execPath}" "${TREE}" %*\r\n`)
        const plan = s.plan(TREE, ['--depth', '1', '--fanout', '1'])
        // A batch file runs only through cmd.exe, with its command line built by Veydr (W2 design D1).
        const run = await tree.spawn({ ...plan, file: CMD_EXE, args: [], commandLine: batchCommandLine(CMD_EXE, batch, plan.args.slice(1)) })
        await waitUntil(() => ['root', 'root.0'].every((role) => s.ready()[role] !== undefined), 'processes root, root.0')
        const node = basename(process.execPath).toLowerCase()
        expect(marked(s.marker).map((p) => p.name.toLowerCase()).sort()).toEqual(['cmd.exe', node, node].sort())

        // A batch prompt left waiting would hold the job until graceMs, and the stop would be forced.
        // cmd.exe handles Ctrl+Break like Ctrl+C: it ends the batch file once node exits, and the
        // "Terminate batch job (Y/N)?" prompt reads end-of-file from the NUL stdin (W0
        // pt-ctrl-break-attach-npm). Should this fail on CI, check that prompt first.
        const { result, elapsedMs } = await timedStop(run, LONG_GRACE_MS)
        expect(result).toEqual({ graceful: 'yes', forced: false, survivors: [] })
        expect(elapsedMs).toBeLessThan(WELL_BEFORE_GRACE_MS)
      })
    },
    timeout(20_000),
  )

  it(
    'sends Ctrl+Break to neither the test process nor a second running command',
    async () => {
      // Signals reach `process.on` only on a process's main thread; vitest's default `forks` pool runs
      // this file there. Under a worker-threads pool the listener below would see nothing, so that
      // is refused rather than passed vacuously. (The sentinel covers other processes on the
      // runner's console either way; this test adds the test process and a second command.)
      expect(isMainThread, 'the test runs on a main thread, where SIGBREAK is delivered').toBe(true)
      const received: string[] = []
      const onBreak = (): void => {
        received.push('SIGBREAK')
      }
      // A Ctrl+Break would otherwise end the test process, which shares the runner's console.
      process.on('SIGBREAK', onBreak)
      try {
        await repeat(async (s) => {
          const other = scenario()
          scenarios.push(other)
          const otherEvents = join(other.dir, 'events.txt')
          const second = await tree.spawn(other.plan(TREE, ['--sentinel', otherEvents]))
          await waitUntil(() => other.ready()['root'] !== undefined, 'the second command')
          const secondPid = other.ready()['root'] as number

          const { run } = await startTree(s, ['--depth', '1', '--fanout', '1'], ['root', 'root.0'])
          expect((await run.stop({ graceMs: LONG_GRACE_MS })).graceful).toBe('yes')
          // Time for a stray event to arrive and be recorded.
          await sleep(500)
          expect(received, 'console events received by the test process').toEqual([])
          expect(eventsIn(otherEvents), 'console events received by the second command').toEqual([])
          expect(marked(other.marker).map((p) => p.pid)).toEqual([secondPid])

          // The second command records Ctrl+Break and ignores it: its own stop reaches it, which
          // shows the check above could have seen an event, and is then forced.
          expect(await second.stop({ graceMs: 1_000 })).toEqual({ graceful: 'no', forced: true, survivors: [] })
          expect(eventsIn(otherEvents)).toContain('SIGBREAK')
          expect(marked(other.marker)).toEqual([])
        })
      } finally {
        process.off('SIGBREAK', onBreak)
      }
    },
    timeout(20_000),
  )

  it(
    'stops a tree that has left its console at once, forced, without waiting graceMs',
    async () => {
      await repeat(async (s) => {
        const plan = s.plan(TREE, [])
        const run = await tree.spawn({
          ...plan,
          file: POWERSHELL,
          args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', FREE_CONSOLE, '-Marker', s.marker, '-Dir', s.dir, '-Children', '1'],
        })
        const exit = exitOf(run)
        await waitUntil(() => ['root', 'root.0'].every((role) => s.ready()[role] !== undefined), 'processes root, root.0 to leave their console', 60_000)
        const pids = [s.ready()['root'] as number, s.ready()['root.0'] as number]
        expect(sorted(marked(s.marker).map((p) => p.pid))).toEqual(sorted(pids))

        const { result, elapsedMs } = await timedStop(run, LONG_GRACE_MS)
        expect(result).toEqual({ graceful: 'no', forced: true, survivors: [] })
        expect(elapsedMs).toBeLessThan(WELL_BEFORE_GRACE_MS)
        expect(await exit).toMatchObject({ forced: true })
      })
    },
    timeout(30_000),
  )

  describe('abnormal exit and survivors', () => {
    let bundleDir: string
    let hostScript: string
    const hosts: ChildProcess[] = []
    const direct: ChildProcess[] = []

    beforeAll(async () => {
      // The host imports the TypeScript sources; bundle it into one CommonJS file Node can run.
      bundleDir = mkdtempSync(join(tmpdir(), 'veydr-win-host-'))
      await build({
        configFile: false,
        logLevel: 'silent',
        ssr: { noExternal: true },
        build: {
          ssr: join(__dirname, 'support/windows-tree-host.ts'),
          outDir: bundleDir,
          emptyOutDir: true,
          minify: false,
          rolldownOptions: { output: { format: 'cjs', entryFileNames: 'host.cjs' } },
        },
      })
      hostScript = join(bundleDir, 'host.cjs')
    }, 60_000)
    afterAll(() => {
      rmSync(bundleDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    })
    afterEach(() => {
      for (const child of [...hosts.splice(0), ...direct.splice(0)]) child.kill()
    })

    /**
     * Starts a fixture tree directly from the test, outside any job of Veydr, as processes that
     * outlived Veydr would be. `windowsHide` gives it a console of its own, without a window,
     * which its children share; the test runner's console is not involved.
     */
    async function startDirect(s: Scenario, args: readonly string[], roles: readonly string[]): Promise<number[]> {
      const child = spawn(process.execPath, [TREE, '--marker', s.marker, '--dir', s.dir, ...args], { stdio: 'ignore', windowsHide: true })
      direct.push(child)
      await waitUntil(() => roles.every((role) => s.ready()[role] !== undefined), `processes ${roles.join(', ')}`)
      const ready = s.ready()
      return roles.map((role) => ready[role] as number)
    }

    it(
      '[spec:process-supervision/veydr-ends-abnormally-on-windows] leaves no tree process when the process owning the run is killed',
      async () => {
        await repeat(async (s) => {
          const configDir = join(s.dir, 'config')
          const options: WindowsHostOptions = { configDir, helperPath: HELPER_PATH, plan: s.plan(TREE, ['--depth', '1', '--fanout', '2']), descendants: 2 }
          const host = spawn(process.execPath, [hostScript, JSON.stringify(options)], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
          hosts.push(host)
          if (host.stdout === null) throw new Error('the host was started without stdout')
          const output = createInterface({ input: host.stdout })
          try {
            expect((await output[Symbol.asyncIterator]().next()).value).toBe('ready')
          } finally {
            output.close()
          }
          // The host reports `ready` once its job has members, which may be before the fixtures have
          // written their ready files, or before both children are in the ledger on disk.
          const roles = ['root', 'root.0', 'root.1']
          await waitUntil(() => roles.every((role) => s.ready()[role] !== undefined), `processes ${roles.join(', ')}`)
          const pids = roles.map((role) => s.ready()[role] as number)
          await waitUntil(() => {
            const recorded = recordedPids(configDir)
            return pids.every((pid) => recorded.includes(pid))
          }, 'the whole tree to be in the ledger on disk')
          // The host's own command line carries the marker in its options; it is not part of the tree.
          expect(sorted(marked(s.marker).filter((p) => p.pid !== host.pid).map((p) => p.pid))).toEqual(sorted(pids))

          const exited = once(host, 'exit')
          forceKill(host.pid as number)
          await exited
          // The helper sees its control channel close (or ends with the host), and the job ends the tree.
          await waitUntil(() => marked(s.marker).length === 0, 'the tree to end', 10_000)
          await waitUntil(() => helpersOf([host.pid as number]).length === 0, "the host's helper to exit", 10_000)

          // What the next launch reads: the run is still recorded, and nothing of it survives.
          const { entries } = await createRunLedger({ dir: configDir, log: quietLog(), directorySync: false }).load()
          expect(entries).toHaveLength(1)
          expect(entries[0]?.leader.pid).toBe(pids[0])
          expect(entries[0]?.descendants.map((d) => d.pid)).toEqual(expect.arrayContaining(pids.slice(1)))
          expect(await tree.findSurvivors(entries)).toEqual([])
        })
      },
      timeout(20_000),
    )

    it(
      '[spec:process-supervision/helper-ends-abnormally-on-windows] ends the tree and reports the stop as unverified when the helper is killed',
      async () => {
        await repeat(async (s) => {
          const { run } = await startTree(s, ['--depth', '1', '--fanout', '2'], ['root', 'root.0', 'root.1'])
          const exit = exitOf(run)
          const helpers = helpersOf([process.pid])
          expect(helpers, 'the run has one helper').toHaveLength(1)

          forceKill(helpers[0]?.pid as number)
          // KILL_ON_JOB_CLOSE: the helper held the only handle to the job.
          expect(await exit).toEqual({ code: null, signal: null, forced: true })
          await waitUntil(() => marked(s.marker).length === 0, 'the tree to end', 10_000)
          await expect(run.stop({ graceMs: 1_000 })).rejects.toThrow(/Windows helper/)
          await expect(run.remaining()).rejects.toThrow(/Windows helper/)
        })
      },
      timeout(15_000),
    )

    it('[spec:process-supervision/reused-pid-on-windows] neither reports nor ends a live process whose creation time differs', async () => {
      const [real] = identitiesOf([sentinel?.pid as number]) as [ProcessIdentity]
      // The check can see the sentinel under its real identity, so its absence below is meaningful.
      expect((await tree.findSurvivors([ledgerEntry(real)])).map((found) => found.identity)).toEqual([real])

      const created = BigInt(real.token)
      const reused = [windowsIdentity(real.pid, String(created + 1n)), windowsIdentity(real.pid, String(created - 1n))]
      expect(await tree.findSurvivors([ledgerEntry(reused[0] as ProcessIdentity, reused.slice(1))])).toEqual([])
      const asSurvivors: Survivor[] = reused.map((identity) => ({ commandId: 'c', runId: 'r', identity, info: { pid: identity.pid, name: 'node.exe', commandLine: '' } }))
      expect(await createWindowsProcessTree({ helperPath: HELPER_PATH, survivorGraceMs: 1_000 }).terminateSurvivors(asSurvivors)).toEqual({
        graceful: 'yes',
        forced: false,
        survivors: [],
      })
      await sleep(500)
      // afterEach also checks that the sentinel received no console event.
      expect(sentinel?.alive(), 'the sentinel is alive').toBe(true)
    }, 60_000)

    it(
      'terminateSurvivors ends survivors outside any job of Veydr after verifying them, gracefully when they cooperate',
      async () => {
        const survivorsTree = createWindowsProcessTree({ helperPath: HELPER_PATH, survivorGraceMs: LONG_GRACE_MS })
        await repeat(async (s) => {
          const [root, child] = (await startDirect(s, ['--depth', '1', '--fanout', '1'], ['root', 'root.0'])) as [number, number]
          const [rootIdentity, childIdentity] = identitiesOf([root, child]) as [ProcessIdentity, ProcessIdentity]
          const found = await survivorsTree.findSurvivors([ledgerEntry(rootIdentity, [childIdentity])])
          expect(sorted(found.map((f) => f.identity.pid))).toEqual(sorted([root, child]))
          const node = basename(process.execPath).toLowerCase()
          expect(found.map((f) => f.info.name.toLowerCase())).toEqual([node, node])

          const started = performance.now()
          expect(await survivorsTree.terminateSurvivors(found)).toEqual({ graceful: 'yes', forced: false, survivors: [] })
          expect(performance.now() - started).toBeLessThan(WELL_BEFORE_GRACE_MS)
          expect(marked(s.marker)).toEqual([])
        })
      },
      timeout(20_000),
    )

    it(
      'terminateSurvivors forcibly ends survivors that ignore Ctrl+Break after the grace period',
      async () => {
        const survivorsTree = createWindowsProcessTree({ helperPath: HELPER_PATH, survivorGraceMs: 1_000 })
        await repeat(async (s) => {
          const pids = await startDirect(s, ['--depth', '1', '--fanout', '1', '--ignore-break'], ['root', 'root.0'])
          const [rootIdentity, ...childIdentities] = identitiesOf(pids) as [ProcessIdentity, ...ProcessIdentity[]]
          const found = await survivorsTree.findSurvivors([ledgerEntry(rootIdentity, childIdentities)])
          expect(found).toHaveLength(2)
          expect(await survivorsTree.terminateSurvivors(found)).toEqual({ graceful: 'no', forced: true, survivors: [] })
          expect(marked(s.marker)).toEqual([])
        })
      },
      timeout(20_000),
    )

    it(
      'terminateSurvivors sends no Ctrl+Break to a console it shares with a process that is not a survivor',
      async () => {
        const survivorsTree = createWindowsProcessTree({ helperPath: HELPER_PATH, survivorGraceMs: LONG_GRACE_MS })
        await repeat(async (s) => {
          // The root records every console event and keeps running; its child shares its console
          // and would exit on Ctrl+Break. Only the child is a survivor.
          const eventsFile = join(s.dir, 'events.txt')
          const [root, child] = (await startDirect(s, ['--sentinel', eventsFile, '--depth', '1', '--fanout', '1'], ['root', 'root.0'])) as [number, number]
          const found = await survivorsTree.findSurvivors([ledgerEntry(...(identitiesOf([child]) as [ProcessIdentity]))])
          expect(found.map((f) => f.identity.pid)).toEqual([child])

          const started = performance.now()
          // No event could be sent, so the survivor is ended at once by TerminateProcess.
          expect(await survivorsTree.terminateSurvivors(found)).toEqual({ graceful: 'no', forced: true, survivors: [] })
          expect(performance.now() - started).toBeLessThan(WELL_BEFORE_GRACE_MS)
          // Time for a stray event to arrive and be recorded.
          await sleep(500)
          expect(eventsIn(eventsFile), 'console events received by the process sharing the console').toEqual([])
          expect(marked(s.marker).map((p) => p.pid)).toEqual([root])

          for (const leftover of direct.splice(0)) leftover.kill()
          await waitUntil(() => marked(s.marker).length === 0, 'the root to end')
        })
      },
      timeout(20_000),
    )

    it('refuses malformed input to inspect and terminate, and a bad grace period', () => {
      const cases: [string[], string, number][] = [
        [['inspect'], 'not a list\n', 1],
        [['inspect'], '[{"pid":4,"created":"1"},]\n', 1],
        [['inspect'], '[{"created":"1","pid":4}]\n', 1],
        [['inspect'], '[{"pid":4294967296,"created":"1"}]\n', 1],
        [['terminate', '1000'], '[{"pid":4,"created":"01"}]\n', 1],
      ]
      for (const [args, input, status] of cases) {
        const run = spawnSync(HELPER_PATH, args, { input, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
        expect(run.status, `${args.join(' ')} ${input}`).toBe(status)
        expect(run.stdout, input).toBe('')
        expect(run.stderr, input).toMatch(/^veydr-helper: /)
      }
      for (const args of [['inspect', 'extra'], ['terminate'], ['terminate', '-1'], ['terminate', '01'], ['terminate', '2147483648']]) {
        const run = spawnSync(HELPER_PATH, args, { input: '[]\n', encoding: 'utf8', windowsHide: true, timeout: 30_000 })
        expect(run.status, args.join(' ')).toBe(2)
        expect(run.stderr, args.join(' ')).toContain('usage: veydr-helper')
      }
      const empty = spawnSync(HELPER_PATH, ['inspect'], { input: '[]\n', encoding: 'utf8', windowsHide: true, timeout: 30_000 })
      expect(empty.status).toBe(0)
      expect(JSON.parse(empty.stdout)).toEqual({ type: 'inspected', processes: [] })
    })
  })

  /**
   * Runs the real helper's `run` by hand, as the client does, with `request` (the bytes after the
   * token line) on its stdin, and collects what it reports on the pipe, stdout and stderr. The test
   * process serves the pipe and starts the helper, so the helper accepts the pipe as its parent's.
   */
  async function rawRun(request: string | Buffer, cwd: string, env: Readonly<Record<string, string>>): Promise<RawRun> {
    const pipe = randomPipePath()
    const token = randomBytes(32).toString('hex')
    const server = createServer()
    await new Promise<void>((done, fail) => {
      server.once('error', fail)
      server.listen(pipe, () => done())
    })
    try {
      const connection = new Promise<Socket>((done) => server.once('connection', done))
      const child = spawn(HELPER_PATH, ['run', pipe], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      const exited = once(child, 'exit') as Promise<[number | null]>
      const [stdout, stderr] = [collect(child.stdout), collect(child.stderr)]
      // The helper may stop reading a request it refuses before all of it is written.
      child.stdin.on('error', () => undefined)
      child.stdin.end(Buffer.concat([Buffer.from(`${token}\n`), typeof request === 'string' ? Buffer.from(request, 'utf8') : request]))
      const socket = await Promise.race([connection, exited.then(() => null)])
      const received = socket === null ? Promise.resolve(Buffer.alloc(0)) : collect(socket)
      const [[code], out, err, channel] = await Promise.all([exited, stdout, stderr, received])
      const lines = channel.toString('utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(lines[0], 'the first line is the handshake').toEqual({ type: 'ready', version: Number(PROTOCOL_VERSION), token, pid: child.pid })
      return { lines: lines.slice(1), stdout: out.toString('utf8'), stderr: err.toString('utf8'), code }
    } finally {
      server.close()
    }
  }

  describe('protocol version 2: the run request (W2 design D1)', () => {
    /** A scenario directory and an environment whose record-args.mjs writes to `record`. */
    function recording(): { s: Scenario; record: string; env: Record<string, string> } {
      const s = scenario()
      scenarios.push(s)
      const record = join(s.dir, 'recorded.json')
      return { s, record, env: { ...s.plan('', []).env, VEYDR_RECORD_FILE: record } }
    }

    const recorded = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8')) as unknown

    /** Every UTF-16 unit of `text` as a `\uXXXX` escape. */
    const escapeAll = (text: string, upper: boolean): string =>
      Array.from({ length: text.length }, (_, i) => {
        const hex = text.charCodeAt(i).toString(16).padStart(4, '0')
        return `\\u${upper ? hex.toUpperCase() : hex}`
      }).join('')

    it('runs the command line it is given, read through every JSON string escape', async () => {
      const args = ['a "b" c\\', 'trail\\', 'x\\"y', '\b\f\n\r\t', 'grüße 日本語 😀', '%PATH%', 'a&b|c', '']
      const launch = helperLaunch({ file: process.execPath, args: [RECORD_ARGS, ...args] })
      const standard = encodeRunRequest(launch)
      const requests: [string, string][] = [
        ['JSON.stringify, non-ASCII as UTF-8', standard],
        // `/` written as `\/`: JSON.stringify never puts `/` inside an escape.
        ['solidus escapes', standard.replaceAll('/', '\\/')],
        [
          'every character as \\uXXXX, surrogate pairs included',
          `{"application":"${escapeAll(launch.application, true)}","commandLine":"${escapeAll(launch.commandLine, false)}"}\n`,
        ],
      ]
      for (const [what, request] of requests) {
        const { s, record, env } = recording()
        const result = await rawRun(request, s.dir, env)
        expect(result.code, `${what}: ${JSON.stringify(result.lines)}`).toBe(0)
        // A console that is not UTF-8 fails here too, loudly, not only in the echo test (reviewer2).
        expect(result.lines[0], what).toMatchObject({ type: 'started', utf8Console: true })
        expect(result.lines.find((line) => line['type'] === 'exited'), what).toEqual({ type: 'exited', code: 0, forced: false })
        expect(result.stderr, what).toBe('')
        expect(recorded(record), what).toEqual(args)
      }
    })

    it('refuses a malformed or unsafe request on the pipe, never on stderr, and starts nothing', async () => {
      const A = JSON.stringify(process.execPath)
      const C = JSON.stringify(helperLaunch({ file: process.execPath, args: [RECORD_ARGS] }).commandLine)
      const body = (commandLine: string): string => `{"application":${A},"commandLine":${commandLine}}\n`
      const tooLong = `"${process.execPath}" "${RECORD_ARGS}" ${'x'.repeat(MAX_COMMAND_LINE)}`.slice(0, MAX_COMMAND_LINE + 1)
      const cases: [string, string | Buffer, RegExp][] = [
        ['trailing text', `{"application":${A},"commandLine":${C}} \n`, /text after its end/],
        ['a second object', `{"application":${A},"commandLine":${C}}{}\n`, /text after its end/],
        ['a duplicate key', `{"application":${A},"application":${A},"commandLine":${C}}\n`, /repeats the key "application"/],
        ['a duplicate commandLine', `{"application":${A},"commandLine":${C},"commandLine":${C}}\n`, /repeats the key "commandLine"/],
        ['an unknown key', `{"application":${A},"commandLine":${C},"cwd":"C:\\\\"}\n`, /unknown key at offset/],
        ['an escaped unknown key', `{"\\u0061pp":${A},"commandLine":${C}}\n`, /unknown key at offset 1/],
        ['the keys reversed', `{"commandLine":${C},"application":${A}}\n`, /"commandLine" before "application"/],
        ['a missing key', `{"application":${A}}\n`, /needs both/],
        ['a number value', `{"application":${A},"commandLine":1}\n`, /value at offset \d+ is not a string/],
        ['whitespace', `{ "application":${A},"commandLine":${C}}\n`, /malformed at offset 1/],
        ['an array', `[${A},${C}]\n`, /malformed at offset 0/],
        ['an unknown escape', body('"\\x41"'), /unknown escape at offset/],
        ['a short \\u escape', body('"\\u12"'), /malformed \\u escape/],
        ['a non-hex \\u escape', body('"\\u12g4"'), /malformed \\u escape/],
        ['a lone high surrogate', body('"a\\ud800b"'), /unpaired surrogate/],
        ['a lone low surrogate', body('"\\udc00"'), /unpaired surrogate/],
        ['reversed surrogates', body('"\\ude00\\ud83d"'), /unpaired surrogate/],
        ['an unescaped control character', body('"a\tb"'), /unescaped control character/],
        ['an unterminated string', `{"application":${A},"commandLine":"abc\n`, /unterminated string|complete run request|more than one line/],
        ['invalid UTF-8', Buffer.concat([Buffer.from(`{"application":${A},"commandLine":"`), Buffer.from([0xc3, 0x28]), Buffer.from('"}\n')]), /not valid UTF-8/],
        ['an encoded surrogate', Buffer.concat([Buffer.from(`{"application":${A},"commandLine":"`), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from('"}\n')]), /not valid UTF-8/],
        ['a byte order mark', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body(C))]), /malformed at offset 0/],
        ['no line end', body(C).slice(0, -1), /complete run request line/],
        // encodeRunRequest ends the line with \n alone.
        ['a CRLF line end', `${body(C).slice(0, -1)}\r\n`, /text after its end/],
        ['nothing', '', /complete run request line/],
        ['two lines', `${body(C)}${body(C)}`, /more than one line/],
        ['NUL in the command line', body(JSON.stringify(`"${process.execPath}" \0`)), /command line contains a NUL/],
        ['NUL in the program', `{"application":${JSON.stringify(`${process.execPath}\0`)},"commandLine":${C}}\n`, /program path contains a NUL/],
        ['a relative program', `{"application":"node.exe","commandLine":${C}}\n`, /full path/],
        ['a drive-relative program', `{"application":"C:node.exe","commandLine":${C}}\n`, /full path/],
        ['a root-relative program', `{"application":"\\\\node.exe","commandLine":${C}}\n`, /full path/],
        ['a device path', `{"application":${JSON.stringify(`\\\\?\\${process.execPath}`)},"commandLine":${C}}\n`, /ordinary drive or UNC path/],
        ['a data stream', `{"application":${JSON.stringify(`${process.execPath}::$DATA`)},"commandLine":${C}}\n`, /':' after the drive/],
        ['an empty command line', body('""'), /command line is empty/],
        ['another program as argv[0]', body(JSON.stringify(`"${CMD_EXE}" /c whoami`)), /does not start with the quoted program/],
        ['an unquoted argv[0]', body(JSON.stringify(`${process.execPath} x`)), /does not start with the quoted program/],
        ['argv[0] run into the next argument', body(JSON.stringify(`"${process.execPath}"x`)), /does not start with the quoted program/],
        ['a quote in the program', `{"application":${JSON.stringify(`${process.execPath}"`)},"commandLine":${C}}\n`, /double quote or a line break/],
        ['a line break in the program', `{"application":${JSON.stringify(`${process.execPath}\n`)},"commandLine":${C}}\n`, /double quote or a line break/],
        ['a "." segment after a batch file', `{"application":${JSON.stringify(`${process.execPath}.cmd\\.`)},"commandLine":${C}}\n`, /'\.' or '\.\.' segment/],
        ['a ".." segment', `{"application":${JSON.stringify(`${process.execPath}\\..\\x.bat`)},"commandLine":${C}}\n`, /'\.' or '\.\.' segment/],
        ['a trailing separator', `{"application":${JSON.stringify(`${process.execPath}.bat\\`)},"commandLine":${C}}\n`, /'\.' or '\.\.' segment/],
        ['a command line one character too long', body(JSON.stringify(tooLong)), /has 32767 characters, more than the 32766/],
        ['a request beyond 1 MiB', body(JSON.stringify(`"${process.execPath}" ${'\u0001'.repeat(200_000)}`)), /exceeds 1048576 bytes/],
      ]
      for (const [what, request, message] of cases) {
        const { s, record, env } = recording()
        const result = await rawRun(request, s.dir, env)
        expect(result.code, what).toBe(1)
        expect(result.lines, what).toEqual([{ type: 'error', message: expect.stringMatching(message) as unknown }])
        // stderr and stdout belong to the command, which never started.
        expect(result.stderr, what).toBe('')
        expect(result.stdout, what).toBe('')
        expect(existsSync(record), `${what}: nothing ran`).toBe(false)
      }
    })

    it('never shows the text of a refused request', async () => {
      const { s, env } = recording()
      const secret = 'hunter2-SECRET-token'
      const result = await rawRun(`{"application":${JSON.stringify(process.execPath)},"commandLine":"${secret} \\q"}\n`, s.dir, env)
      expect(result.lines).toEqual([{ type: 'error', message: expect.stringMatching(/unknown escape at offset \d+/) as unknown }])
      expect(JSON.stringify(result.lines)).not.toContain('SECRET')
    })

    it('refuses a batch file given as the program, whatever its case or trailing dots and spaces', async () => {
      for (const name of ['run.cmd', 'BUILD.BAT', 'npm.Cmd. .', 'x.bat.']) {
        const { s, record, env } = recording()
        const batch = join(s.dir, name.replace(/[. ]+$/, ''))
        // It would record its arguments, had it run.
        writeFileSync(batch, `@"${process.execPath}" "${RECORD_ARGS}" %*\r\n`)
        const result = await rawRun(`${JSON.stringify({ application: join(s.dir, name), commandLine: `"${join(s.dir, name)}" x` })}\n`, s.dir, env)
        expect(result.code, name).toBe(1)
        expect(result.lines, name).toEqual([{ type: 'error', message: expect.stringContaining('the program is a batch file') as unknown }])
        expect(result.stderr, name).toBe('')
        expect(existsSync(record), `${name}: nothing ran`).toBe(false)
        expect(marked(s.marker), name).toEqual([])
      }
      // The process tree refuses it before the helper is involved.
      const { s, env } = recording()
      const batch = join(s.dir, 'run.cmd')
      writeFileSync(batch, '@echo off\r\n')
      await expect(tree.spawn({ file: batch, args: [], cwd: s.dir, env })).rejects.toBeInstanceOf(CommandLineError)
    })

    it('starts a direct-mode command line of 32,000 characters', async () => {
      const { s, record, env } = recording()
      const base = helperLaunch({ file: process.execPath, args: [RECORD_ARGS, ''] }).commandLine.length
      const long = 'L'.repeat(32_000 - base)
      const plan: SpawnPlan = { file: process.execPath, args: [RECORD_ARGS, long], cwd: s.dir, env }
      expect(helperLaunch(plan).commandLine).toHaveLength(32_000)
      const exit = await exitOf(await tree.spawn(plan))
      expect(exit).toEqual({ code: 0, signal: null, forced: false })
      expect(recorded(record)).toEqual([long])
    })

    it(
      '[spec:project-registry/shim-arguments-arrive-unchanged] passes every W0 shim-corpus case through an npm.cmd-style shim unchanged, with no sentinel created',
      async () => {
        const refused: string[] = []
        for (const c of CORPUS) {
          const { s, record, env } = recording()
          // An npm.cmd-style forwarder, as W0's fwd.cmd.
          const shim = join(s.dir, 'fwd.cmd')
          writeFileSync(shim, `@"${process.execPath}" "${RECORD_ARGS}" %*\r\n`)
          let commandLine: string
          try {
            commandLine = batchCommandLine(CMD_EXE, shim, c.args)
          } catch (error) {
            // A case cmd.exe cannot carry passes by being refused before anything starts.
            expect(error, c.id).toBeInstanceOf(CommandLineError)
            refused.push(c.id)
            continue
          }
          const exit = await exitOf(await tree.spawn({ file: CMD_EXE, args: [], commandLine, cwd: s.dir, env }))
          expect(exit, c.id).toEqual({ code: 0, signal: null, forced: false })
          expect(recorded(record), c.id).toEqual(c.args)
          expect(existsSync(join(s.dir, sentinelFor(c.id))), `${c.id}: an injected command created the sentinel`).toBe(false)
        }
        expect(refused.sort()).toEqual(['carriage-return', 'long', 'newline'])
        await waitUntil(() => helpersOf([process.pid]).length === 0, 'the helpers to exit')
      },
      120_000,
    )

    it(
      '[spec:project-registry/simple-batch-arguments-reach-the-batch-file-as-written] build.bat release C:\\out\\ sees %1 == release and %~2 == C:\\out\\',
      async () => {
        const { s, env } = recording()
        const build = join(s.dir, 'build.bat')
        writeFileSync(build, '@echo off\r\nif "%1"=="release" (echo first=release) else (echo first=other: %1)\r\necho second=%~2\r\n')
        const commandLine = batchCommandLine(CMD_EXE, build, ['release', 'C:\\out\\'])
        // Simple arguments pass bare (W2 design D1).
        expect(commandLine).toBe(`"${CMD_EXE}" /d /v:off /s /c ""${build}" release C:\\out\\"`)
        const run = await tree.spawn({ file: CMD_EXE, args: [], commandLine, cwd: s.dir, env })
        const [stdout, exit] = await Promise.all([collect(run.stdout), exitOf(run)])
        expect(exit).toEqual({ code: 0, signal: null, forced: false })
        expect(stdout.toString('utf8')).toBe('first=release\r\nsecond=C:\\out\\\r\n')
      },
    )

    it("sets the command's console to UTF-8 before it runs, so cmd /c echo writes non-ASCII text as UTF-8 (W2 design D5)", async () => {
      const events: { level: string; event: string; detail?: Record<string, unknown> }[] = []
      const logged = createWindowsProcessTree({
        helperPath: HELPER_PATH,
        log: { record: (level, event, detail) => events.push({ level, event, ...(detail === undefined ? {} : { detail }) }) },
      })
      const { s, env } = recording()
      const text = 'grüße 日本語 ✓'
      const run = await logged.spawn({ file: CMD_EXE, args: [], commandLine: shellCommandLine(CMD_EXE, `echo ${text}`), cwd: s.dir, env })
      const [stdout, exit] = await Promise.all([collect(run.stdout), exitOf(run)])
      expect(exit).toEqual({ code: 0, signal: null, forced: false })
      // The console host (design D5, fallback b) sets the console before the command starts; the
      // logged reason says which step failed if it did not.
      expect(run.console.utf8, `utf8Console is false: ${JSON.stringify(events)}`).toBe(true)
      expect(events.filter((e) => e.event === 'process.windows-console-not-utf8')).toEqual([])
      expect(run.console.ansiCodePage).toBeGreaterThan(0)
      expect(stdout.toString('hex'), stdout.toString('latin1')).toBe(Buffer.from(`${text}\r\n`, 'utf8').toString('hex'))
    })
  })
})
