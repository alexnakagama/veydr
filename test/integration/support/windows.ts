import { execFileSync } from 'node:child_process'
import { sleep } from '../../support/proc'

// Windows test helpers shared by the Windows integration tests (windows-process-tree.test.ts and
// windows-commands.test.ts). Every claim about which processes exist is read with Win32_Process,
// independently of the helper and of the code under test.


/** Runs a Windows PowerShell script, passed encoded so that no quoting reaches the command line. */
export function powershell(script: string): string {
  const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; ${script}`, 'utf16le').toString('base64')
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  })
}

export interface MarkedProcess {
  readonly pid: number
  readonly name: string
}

/**
 * Live processes whose command line carries `marker`, read with Win32_Process. The helper is never
 * among them: since protocol version 2 its command line holds only the pipe (W2 design D1).
 */
export function marked(marker: string): MarkedProcess[] {
  if (!/^[0-9a-f-]+$/.test(marker)) throw new Error(`not a marker: ${marker}`)
  const output = powershell(
    `$found = @(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${marker}%'" | Where-Object { $_.ProcessId -ne $PID -and $_.Name -ne 'veydr-helper.exe' } | ForEach-Object {
       [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name }
     })
     ConvertTo-Json -Compress -Depth 3 -InputObject $found`,
  )
  return parseArray(output) as MarkedProcess[]
}

/**
 * Live helpers started by one of `parents` (this test process, or a host it started), read with
 * Win32_Process. The helper's command line no longer carries the command's marker, so its parent
 * names it; each test file runs in a process of its own (the `forks` pool), so no other file's
 * helpers are counted.
 */
export function helpersOf(parents: readonly number[]): MarkedProcess[] {
  const filter = parents.map((pid) => `ParentProcessId = ${String(Math.trunc(pid))}`).join(' OR ')
  const output = powershell(
    `ConvertTo-Json -Compress -Depth 3 -InputObject @(Get-CimInstance Win32_Process -Filter "Name = 'veydr-helper.exe' AND (${filter})" | ForEach-Object {
       [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name }
     })`,
  )
  return parseArray(output) as MarkedProcess[]
}

export function parseArray(output: string): unknown[] {
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
export function visibleWindowOwners(marker: string): number[] {
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


export async function waitUntil(condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}


/** Everything `stream` delivers until it ends. */
export function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => done(Buffer.concat(chunks)))
    stream.on('close', () => done(Buffer.concat(chunks)))
    stream.on('error', fail)
  })
}

/** The window classes of a console: conhost.exe's, a pseudo-console's, and Windows Terminal's. */
const CONSOLE_WINDOW_CLASSES = ['ConsoleWindowClass', 'PseudoConsoleWindow', 'CASCADIA_HOSTING_WINDOW_CLASS']

export interface ConsoleView {
  /** Console hosts (conhost.exe) started for one of the processes. */
  readonly hosts: readonly number[]
  /** Owners of console windows, visible or not, among the processes and their console hosts. */
  readonly windowOwners: readonly number[]
}

/**
 * The consoles of `pids`, read with Win32_Process and EnumWindows: a process that gets a new
 * console has a conhost.exe started for it, which draws its ConsoleWindowClass window (or hands it
 * to Windows Terminal, whose window belongs to WindowsTerminal.exe and is not seen here).
 */
export function consolesOf(pids: readonly number[]): ConsoleView {
  if (pids.length === 0) return { hosts: [], windowOwners: [] }
  const list = pids.map((pid) => String(Math.trunc(pid))).join(',')
  const classes = CONSOLE_WINDOW_CLASSES.map((name) => `"${name}"`).join(', ')
  const output = powershell(
    `Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class VeydrConsoles {
  public delegate bool EnumProc(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int size);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  public static uint[] Owners(string[] classes) {
    List<uint> owners = new List<uint>();
    EnumWindows(delegate(IntPtr window, IntPtr data) {
      StringBuilder name = new StringBuilder(256);
      GetClassName(window, name, name.Capacity);
      if (Array.IndexOf(classes, name.ToString()) >= 0) { uint pid; GetWindowThreadProcessId(window, out pid); owners.Add(pid); }
      return true;
    }, IntPtr.Zero);
    return owners.ToArray();
  }
}
'@
$tree = @(${list})
$hosts = @(Get-CimInstance Win32_Process -Filter "Name = 'conhost.exe'" | Where-Object { $tree -contains [int]$_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId })
$owners = @([VeydrConsoles]::Owners(@(${classes})) | ForEach-Object { [int]$_ } | Where-Object { ($tree + $hosts) -contains $_ })
# One array per line: Windows PowerShell serializes an array inside an object with its Count.
ConvertTo-Json -Compress -InputObject $hosts
ConvertTo-Json -Compress -InputObject $owners`,
  )
  const [hosts = '', owners = ''] = output.trim().split(/\r?\n/)
  return { hosts: parseArray(hosts) as number[], windowOwners: parseArray(owners) as number[] }
}

/** Whether process `pid` is in any Job Object (`IsProcessInJob`); `null` if it cannot be opened. */
export function isInJob(pid: number): boolean | null {
  const output = powershell(
    `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VeydrJobs {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static string InJob(uint pid) {
    IntPtr process = OpenProcess(0x1000, false, pid);
    if (process == IntPtr.Zero) return "null";
    try { bool result; return IsProcessInJob(process, IntPtr.Zero, out result) ? (result ? "true" : "false") : "null"; }
    finally { CloseHandle(process); }
  }
}
'@
[VeydrJobs]::InJob(${String(Math.trunc(pid))})`,
  )
  return JSON.parse(output.trim()) as boolean | null
}
