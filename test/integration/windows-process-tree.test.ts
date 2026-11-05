import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { isMainThread } from 'node:worker_threads'
import { build } from 'vite'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { HELPER_PATH } from '../../scripts/build-windows-helper.mjs'
import type { ExitInfo, LedgerEntry, ManagedProcess, ProcessIdentity, SpawnPlan, StopResult, Survivor } from '../../src/main/platform/types'
import { windowsIdentity } from '../../src/main/platform/windows/identity'
import { createWindowsProcessTree } from '../../src/main/platform/windows/process-tree'
import { createRunLedger, ledgerPath } from '../../src/main/supervisor/ledger'
import { REPETITIONS, sleep } from '../support/proc'
import { quietLog } from '../unit/support/config'
import type { WindowsHostOptions } from './support/windows-tree-host'

// The Windows process tree against real Windows processes (add-windows-process-supervision design D7).
// It needs Job Objects and the helper built by `node scripts/build-windows-helper.mjs`, which the
// `windows` CI job runs first. A missing helper fails these tests; it never skips them.
//
// Every claim about which processes remain is checked independently of the helper, by enumerating
// Win32_Process for the scenario's marker, and a sentinel started outside Veydr must survive every
// scenario and receive no console event.

/** The control protocol version the helper must report (design D2). */
const PROTOCOL_VERSION = '1'

const TREE = resolve(__dirname, '../fixtures/windows/tree.mjs')
const OUTPUT = resolve(__dirname, '../fixtures/windows/output.mjs')
const FREE_CONSOLE = resolve(__dirname, '../fixtures/windows/free-console.ps1')
const POWERSHELL = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** A `graceMs` far longer than any graceful stop takes, and the bound such a stop must stay under. */
const LONG_GRACE_MS = 30_000
const WELL_BEFORE_GRACE_MS = 10_000

const runHelper = (...args: string[]) => spawnSync(HELPER_PATH, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 })

/** Runs a Windows PowerShell script, passed encoded so that no quoting reaches the command line. */
function powershell(script: string): string {
  const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; ${script}`, 'utf16le').toString('base64')
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  })
}

interface MarkedProcess {
  readonly pid: number
  readonly name: string
}

/**
 * Live processes whose command line carries `marker`, read with Win32_Process. The helper, whose
 * command line repeats the command's, is listed only with `helpers`.
 */
function marked(marker: string, { helpers = false } = {}): MarkedProcess[] {
  if (!/^[0-9a-f-]+$/.test(marker)) throw new Error(`not a marker: ${marker}`)
  const which = helpers ? `$_.Name -eq 'veydr-helper.exe'` : `$_.Name -ne 'veydr-helper.exe'`
  const output = powershell(
    `$found = @(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${marker}%'" | Where-Object { $_.ProcessId -ne $PID -and ${which} } | ForEach-Object {
       [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name }
     })
     ConvertTo-Json -Compress -Depth 3 -InputObject $found`,
  )
  return parseArray(output) as MarkedProcess[]
}

function parseArray(output: string): unknown[] {
  const parsed: unknown = JSON.parse(output.trim() === '' ? '[]' : output)
  return Array.isArray(parsed) ? parsed : [parsed]
}

/**
 * PIDs of visible top-level windows that belong to the processes marked with `marker` or to their
 * console hosts. A console window is drawn by conhost.exe, so the processes' own main-window handle
 * would be 0 even for a visible console; every visible window is enumerated instead. Where Windows
 * Terminal is the default terminal, a console window would belong to WindowsTerminal.exe and go
 * unseen here; the CI runner has no Windows Terminal, so conhost.exe draws every console.
 */
function visibleWindowOwners(marker: string): number[] {
  if (!/^[0-9a-f-]+$/.test(marker)) throw new Error(`not a marker: ${marker}`)
  const output = powershell(
    `Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class VeydrWindows {
  public delegate bool EnumProc(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  public static uint[] VisibleOwners() {
    List<uint> owners = new List<uint>();
    EnumWindows(delegate(IntPtr window, IntPtr data) {
      uint pid;
      if (IsWindowVisible(window)) { GetWindowThreadProcessId(window, out pid); owners.Add(pid); }
      return true;
    }, IntPtr.Zero);
    return owners.ToArray();
  }
}
'@
$tree = @(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${marker}%'" | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { [int]$_.ProcessId })
$hosts = @(Get-CimInstance Win32_Process -Filter "Name = 'conhost.exe'" | Where-Object { $tree -contains [int]$_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId })
$owners = @([VeydrWindows]::VisibleOwners() | ForEach-Object { [int]$_ } | Where-Object { ($tree + $hosts) -contains $_ })
ConvertTo-Json -Compress -InputObject $owners`,
  )
  return parseArray(output) as number[]
}

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

/**
 * Creation times (decimal FILETIME) of the live processes among `pids`, read with GetProcessTimes
 * from PowerShell, independently of the helper. A PID that cannot be read is left out.
 */
function creationTimes(pids: readonly number[]): Map<number, string> {
  const list = pids.map((pid) => String(Math.trunc(pid))).join(',')
  const output = powershell(
    `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VeydrTimes {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static string Created(uint pid) {
    IntPtr process = OpenProcess(0x1000, false, pid);
    if (process == IntPtr.Zero) return "";
    try {
      long creation, exit, kernel, user;
      return GetProcessTimes(process, out creation, out exit, out kernel, out user) ? creation.ToString(System.Globalization.CultureInfo.InvariantCulture) : "";
    } finally { CloseHandle(process); }
  }
}
'@
ConvertTo-Json -Compress -InputObject @(@(${list}) | ForEach-Object { [pscustomobject]@{ pid = [int]$_; created = [VeydrTimes]::Created([uint32]$_) } } | Where-Object { $_.created -ne '' })`,
  )
  return new Map((parseArray(output) as { pid: number; created: string }[]).map((p) => [p.pid, p.created]))
}

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

async function waitUntil(condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
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
      // Whatever a failed scenario left behind; a passing one leaves nothing.
      powershell(`Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${marker}%'" | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`)
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    },
  }
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
    for (const s of scenarios.splice(0)) s.cleanup()
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
      await waitUntil(() => marked(s.marker, { helpers: true }).length === 0, `the helper to exit (repetition ${i})`)
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
    for (const args of [[], ['frobnicate'], ['version', 'extra'], ['run', 'only-a-pipe']]) {
      const run = runHelper(...args)
      expect(run.status, args.join(' ')).toBe(2)
      expect(run.stdout, args.join(' ')).toBe('')
      expect(run.stderr, args.join(' ')).toContain('usage: veydr-helper')
    }
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
        const run = await tree.spawn({ ...plan, file: batch, args: plan.args.slice(1) })
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
          const helpers = marked(s.marker, { helpers: true })
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

  // Their tests land in other files in group 6, which removes these two todos.
  it.todo('[spec:process-supervision/windows-limitations-documented] documents the Windows limitations (group 6)')
  it.todo('[spec:process-supervision/windows-process-trees-verified-natively] runs the Windows process-tree tests on a Windows runner (group 6)')
})
