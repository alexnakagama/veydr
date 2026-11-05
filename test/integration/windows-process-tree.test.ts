import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { HELPER_PATH } from '../../scripts/build-windows-helper.mjs'
import type { ExitInfo, ManagedProcess, SpawnPlan } from '../../src/main/platform/types'
import { createWindowsProcessTree } from '../../src/main/platform/windows/process-tree'
import { REPETITIONS, sleep } from '../support/proc'

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
    alive: () => child.exitCode === null && child.signalCode === null,
    events: () => (existsSync(eventsFile) ? readFileSync(eventsFile, 'utf8').split('\n').filter((line) => line !== '') : []),
    stop() {
      child.kill()
      own.cleanup()
    },
  }
}

const exitOf = (run: ManagedProcess): Promise<ExitInfo> => new Promise((done) => run.onExit(done))

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

  // The scenarios below are implemented by the group that owns them (tasks.md); the tags keep
  // `npm run spec-coverage` at zero unmapped scenarios in the meantime.
  it.todo('[spec:process-supervision/cooperative-process-on-windows] stops a tree that exits on Ctrl+Break gracefully (group 4)')
  it.todo('[spec:process-supervision/batch-file-command-stopped-gracefully] stops a batch-file command without the Terminate batch job prompt (group 4)')
  it.todo('[spec:process-supervision/veydr-ends-abnormally-on-windows] leaves no tree process when Veydr is killed (group 5)')
  it.todo('[spec:process-supervision/helper-ends-abnormally-on-windows] ends the tree when the helper is killed (group 5)')
  it.todo('[spec:process-supervision/reused-pid-on-windows] neither reports nor ends a process with a reused PID (group 5)')
  // Their tests land in other files in group 6, which removes these two todos.
  it.todo('[spec:process-supervision/windows-limitations-documented] documents the Windows limitations (group 6)')
  it.todo('[spec:process-supervision/windows-process-trees-verified-natively] runs the Windows process-tree tests on a Windows runner (group 6)')
})
