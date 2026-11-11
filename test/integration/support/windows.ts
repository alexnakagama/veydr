import { execFileSync } from 'node:child_process'
import { sleep } from '../../support/proc'

// Windows test helpers shared by the Windows integration tests (windows-process-tree.test.ts,
// windows-commands.test.ts and windows-ports.test.ts). Every claim about which processes exist is
// read with Win32_Process, independently of the helper and of the code under test.


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

export interface ProcessConsole {
  readonly pid: number
  /** Whether this process has a console that can be attached to. */
  readonly attached: boolean
  /** Why attaching failed (a Win32 error code), when it did; 6 (ERROR_INVALID_HANDLE) for a process without a console. */
  readonly attachError: number | null
  /** The console's window handle (`GetConsoleWindow`), 0 for none. */
  readonly window: number
  /** Whether that window is visible. */
  readonly visible: boolean
}

/**
 * The console of each of `pids`, read as the W0 probes read it (`scripts/windows-probe/process-tree.ps1`,
 * `pt-console-window`): PowerShell frees its own console, attaches to the process's with
 * `AttachConsole`, and reads `GetConsoleWindow`. Unlike guessing the console host from its parent
 * process or a window class, this does not depend on how the runner hosts consoles.
 */
export function consolesOf(pids: readonly number[]): ProcessConsole[] {
  if (pids.length === 0) return []
  const list = pids.map((pid) => String(Math.trunc(pid))).join(',')
  const output = powershell(
    `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VeydrConsoles {
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  public static string Of(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return pid + " 0 " + Marshal.GetLastWin32Error() + " 0 0";
    try {
      IntPtr window = GetConsoleWindow();
      bool visible = window != IntPtr.Zero && IsWindowVisible(window);
      return pid + " 1 0 " + window.ToInt64() + " " + (visible ? "1" : "0");
    } finally {
      FreeConsole();
    }
  }
}
'@
# One line per process: pid, attached (1/0), the attach error, the window handle, visible (1/0).
@(${list}) | ForEach-Object { [VeydrConsoles]::Of([uint32]$_) }`,
  )
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [pid, attached, error, window, visible] = line.trim().split(' ').map(Number)
      if ([pid, attached, error, window, visible].some((n) => n === undefined || !Number.isFinite(n))) throw new Error(`unexpected console answer: ${line}`)
      return { pid: pid as number, attached: attached === 1, attachError: attached === 1 ? null : (error as number), window: window as number, visible: visible === 1 }
    })
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

/**
 * Creation times (decimal FILETIME) of the live processes among `pids`, read with GetProcessTimes
 * from PowerShell, independently of the helper. A PID that cannot be read is left out.
 */
export function creationTimes(pids: readonly number[]): Map<number, string> {
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

/**
 * Replaces the DACL of process `pid` with a protected one that grants access only to SYSTEM,
 * Administrators and the account running the tests, through SetSecurityInfo from PowerShell. Any
 * other account, such as a temporary standard user, then gets ERROR_ACCESS_DENIED from OpenProcess
 * for any right, PROCESS_QUERY_LIMITED_INFORMATION included: what a process it may not query looks
 * like. The runner's processes do not look so by default (the standard user can query them, as
 * add-windows-port-inspection's group 4 found on the windows-2025 image). Handles opened before
 * keep their access, so the test can still end the process.
 */
export function denyOtherAccounts(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`not a process ID: ${String(pid)}`)
  powershell(
    `Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class VeydrProcessDacl {
  const uint WRITE_DAC = 0x40000;
  const int SE_KERNEL_OBJECT = 6;
  const uint DACL_SECURITY_INFORMATION = 0x4, PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, IntPtr size);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
  [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(IntPtr handle, int type, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  public static void Restrict(uint pid, string sddl) {
    IntPtr descriptor;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out descriptor, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      bool present, defaulted;
      IntPtr dacl;
      if (!GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted) || !present) throw new Win32Exception(Marshal.GetLastWin32Error());
      IntPtr process = OpenProcess(WRITE_DAC, false, pid);
      if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        uint error = SetSecurityInfo(process, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
        if (error != 0) throw new Win32Exception((int)error);
      } finally { CloseHandle(process); }
    } finally { LocalFree(descriptor); }
  }
}
'@
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
[VeydrProcessDacl]::Restrict([uint32]${String(pid)}, "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;$me)")`,
  )
}
