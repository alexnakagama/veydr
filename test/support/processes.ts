// Test-side view of real processes, on Linux and on Windows (add-windows-environment-and-commands
// design D7). It is deliberately independent of Veydr's own process code and bookkeeping (foundation
// design D14): cleanup is proven by enumerating the system's processes here, not by asking Veydr.
//
// A process is "tagged" when its environment carries `VEYDR_FIXTURE_TAG=<tag>`, which every process
// a scenario starts inherits. Linux reads `/proc`. Windows makes one `Get-CimInstance Win32_Process`
// call per query, and reads each candidate's environment block from its PEB, since Win32_Process
// does not expose it; a process is identified by its PID plus its creation time.
//
// Any failed or unparsable query throws: it never returns an empty list, which would make a "no
// process remains" assertion pass without having looked. This file holds the only platform dispatch
// of the test code (`selectProcessBackend`), which test-platform-policy.test.ts pins.
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Environment variable every fixture process inherits; its value identifies one test's processes. */
export const TAG_VARIABLE = 'VEYDR_FIXTURE_TAG'

/** A live process, identified by its PID and its start time (which together are never reused). */
export interface ProcessView {
  readonly pid: number
  readonly ppid: number
  /**
   * When the process started, in the system's own unit: clock ticks since boot on Linux
   * (`/proc/<pid>/stat` field 22), a FILETIME on Windows. Only compared with values from this file.
   */
  readonly starttime: string
}

/** What `/proc/<pid>/stat` shows of a process (proc(5)); for `[linux-only: /proc]` tests. */
export interface LinuxProcessView extends ProcessView {
  readonly pgid: number
  readonly sid: number
  readonly state: string
}

interface ProcessBackend {
  tagged(tag: string): ProcessView[]
  identities(pids: readonly number[]): Map<number, ProcessView>
  commandLines(pids: readonly number[]): Map<number, string>
  kill(pid: number): void
}

/** A tag is a UUID (`crypto.randomUUID()`); anything else is refused before it reaches a query. */
const TAG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function checkTag(tag: string): void {
  if (!TAG.test(tag)) throw new Error(`not a scenario tag (a lowercase UUID): ${JSON.stringify(tag)}`)
}

function checkPids(pids: readonly number[]): void {
  for (const pid of pids) if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`not a process ID: ${String(pid)}`)
}

// ---------------------------------------------------------------------------------------------
// Linux: /proc

/** Fields of `/proc/<pid>/stat` text after the command name, which may hold spaces and parentheses. */
export function parseProcStat(pid: number, text: string): LinuxProcessView {
  const close = text.lastIndexOf(')')
  const fields = close < 0 ? [] : text.slice(close + 2).trim().split(' ')
  const [state, ppid, pgid, sid] = [fields[0], Number(fields[1]), Number(fields[2]), Number(fields[3])]
  const starttime = fields[19]
  if (state === undefined || starttime === undefined || !/^\d+$/.test(starttime) || ![ppid, pgid, sid].every(Number.isSafeInteger)) {
    throw new Error(`unparsable /proc/${pid}/stat: ${JSON.stringify(text)}`)
  }
  return { pid, ppid, pgid, sid, state, starttime }
}

const isLinuxLive = (view: LinuxProcessView): boolean => view.state !== 'Z' && view.state !== 'X'

/**
 * `/proc/<pid>/stat` of a process that exists (zombies included), `null` for one that does not.
 * Only for `[linux-only: /proc]` tests: it throws where there is no `/proc`.
 */
export function linuxProcess(pid: number): LinuxProcessView | null {
  checkPids([pid])
  if (!existsSync('/proc/self/stat')) throw new Error('linuxProcess needs /proc, which this system does not have')
  let text: string
  try {
    text = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return null
    throw error
  }
  return parseProcStat(pid, text)
}

const portableView = ({ pid, ppid, starttime }: LinuxProcessView): ProcessView => ({ pid, ppid, starttime })

const linuxBackend: ProcessBackend = {
  tagged(tag) {
    const needle = `${TAG_VARIABLE}=${tag}`
    const found: ProcessView[] = []
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      let environ: string
      try {
        environ = readFileSync(`/proc/${name}/environ`, 'latin1')
      } catch {
        // Exited since the listing, or another user's process: not one of the scenario's.
        continue
      }
      if (!environ.split('\0').includes(needle)) continue
      const view = linuxProcess(Number(name))
      if (view !== null && isLinuxLive(view)) found.push(portableView(view))
    }
    return found
  },
  identities(pids) {
    const found = new Map<number, ProcessView>()
    for (const pid of pids) {
      const view = linuxProcess(pid)
      if (view !== null && isLinuxLive(view)) found.set(pid, portableView(view))
    }
    return found
  },
  commandLines(pids) {
    const found = new Map<number, string>()
    for (const pid of pids) {
      try {
        found.set(pid, readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trimEnd())
      } catch (error) {
        // Exited since it was listed (ESRCH while it is being torn down).
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ESRCH') throw error
      }
    }
    return found
  },
  kill(pid) {
    process.kill(pid, 'SIGKILL')
  },
}

// ---------------------------------------------------------------------------------------------
// Windows: one Get-CimInstance Win32_Process call per query, plus the PEB for environments

/**
 * Image names left out of `taggedProcesses` on Windows. Both carry a command's environment without
 * being part of what it started: the console host Windows creates for each console, which ends with
 * its console, and Veydr's helper (W1), whose own exit `windows-process-tree.test.ts` verifies.
 */
const WINDOWS_INFRASTRUCTURE: ReadonlySet<string> = new Set(['conhost.exe', 'veydr-helper.exe'])

/**
 * The C# side of the Windows queries. `Status` reads another process's environment block (PEB →
 * RTL_USER_PROCESS_PARAMETERS → Environment and EnvironmentSize, at their x64 offsets) and says
 * whether it has the entry: Tagged or Untagged, Gone for a process that has exited (Win32_Process
 * may still list one whose handle is held), or Unreadable for a live process whose environment could
 * not be read (another user's, protected, or 32-bit). `Exists` tells live processes from exited ones
 * for the queries by PID. `Matches` compares names regardless of case, as Windows does.
 */
const ENVIRONMENT_READER = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class VeydrTestProcesses
{
    [StructLayout(LayoutKind.Sequential)]
    struct BasicInformation
    {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int infoClass, ref BasicInformation info, int length, out int returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsWow64Process(IntPtr process, out bool wow64);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    public const int Gone = 0, Untagged = 1, Tagged = 2, Unreadable = 3;
    const uint QueryInformation = 0x0400, QueryLimitedInformation = 0x1000, VmRead = 0x0010, StillActive = 259;
    const int InvalidParameter = 87;
    const int ProcessParameters = 0x20, Environment = 0x80, EnvironmentSize = 0x3F0;
    const long MaxEnvironment = 1 << 20;

    static bool Read(IntPtr process, IntPtr address, byte[] buffer)
    {
        IntPtr read;
        return ReadProcessMemory(process, address, buffer, (IntPtr)buffer.Length, out read) && read.ToInt64() == buffer.Length;
    }

    static IntPtr ReadPointer(IntPtr process, IntPtr address)
    {
        byte[] value = new byte[8];
        return Read(process, address, value) ? new IntPtr(BitConverter.ToInt64(value, 0)) : IntPtr.Zero;
    }

    static bool HasExited(IntPtr process)
    {
        uint code;
        return GetExitCodeProcess(process, out code) && code != StillActive;
    }

    static string ReadEnvironment(IntPtr process)
    {
        bool wow64;
        if (!IsWow64Process(process, out wow64) || wow64) return null;
        BasicInformation info = new BasicInformation();
        int returned;
        if (NtQueryInformationProcess(process, 0, ref info, Marshal.SizeOf(info), out returned) != 0) return null;
        IntPtr parameters = ReadPointer(process, IntPtr.Add(info.PebBaseAddress, ProcessParameters));
        if (parameters == IntPtr.Zero) return null;
        IntPtr environment = ReadPointer(process, IntPtr.Add(parameters, Environment));
        long size = ReadPointer(process, IntPtr.Add(parameters, EnvironmentSize)).ToInt64();
        if (environment == IntPtr.Zero || size <= 0 || size > MaxEnvironment || size % 2 != 0) return null;
        byte[] block = new byte[size];
        return Read(process, environment, block) ? Encoding.Unicode.GetString(block) : null;
    }

    /** Whether an environment block (NAME=value entries separated by NULs, ending in empty ones) has name=value. */
    public static bool Matches(string block, string name, string value)
    {
        foreach (string entry in block.Split('\0'))
        {
            // Empty entries end the block; "=C:=C:\..." entries name a drive, and start with "=".
            if (entry.Length < 2) continue;
            int separator = entry.IndexOf('=', 1);
            if (separator < 0) continue;
            if (string.Equals(entry.Substring(0, separator), name, StringComparison.OrdinalIgnoreCase) && entry.Substring(separator + 1) == value) return true;
        }
        return false;
    }

    public static int Status(uint pid, string name, string value)
    {
        if (IntPtr.Size != 8) throw new InvalidOperationException("a 64-bit PowerShell is required to read process environments");
        IntPtr process = OpenProcess(QueryInformation | VmRead, false, pid);
        if (process == IntPtr.Zero) return Marshal.GetLastWin32Error() == InvalidParameter ? Gone : Unreadable;
        try
        {
            if (HasExited(process)) return Gone;
            string block = ReadEnvironment(process);
            if (block == null) return HasExited(process) ? Gone : Unreadable;
            return Matches(block, name, value) ? Tagged : Untagged;
        }
        finally
        {
            CloseHandle(process);
        }
    }

    /** Whether pid is a live process; one that cannot be opened but is listed is taken as live. */
    public static bool Exists(uint pid)
    {
        IntPtr process = OpenProcess(QueryLimitedInformation, false, pid);
        if (process == IntPtr.Zero) return Marshal.GetLastWin32Error() != InvalidParameter;
        try
        {
            return !HasExited(process);
        }
        finally
        {
            CloseHandle(process);
        }
    }
}
`

/** One row of a Win32_Process query, as the scripts below print it. */
interface WindowsRow {
  readonly pid: number
  readonly ppid: number
  readonly name: string
  readonly starttime: string
  readonly commandLine: string | null
  /** For the tag query: whether the process has the tag, or is alive but could not be read. */
  readonly status: 'tagged' | 'unreadable' | null
}

/**
 * Parses what a query script printed: a JSON array of rows (`ConvertTo-Json -InputObject @(…)`
 * prints `[]` for none). Anything else throws, so a broken query is never read as "no processes".
 */
export function parseWindowsRows(output: string): WindowsRow[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output.trim())
  } catch {
    throw new Error(`unparsable process query output: ${JSON.stringify(output.slice(0, 500))}`)
  }
  if (!Array.isArray(parsed)) throw new Error(`process query output is not a list: ${JSON.stringify(output.slice(0, 500))}`)
  return parsed.map((row: unknown) => {
    const r = row as Partial<Record<keyof WindowsRow, unknown>> | null
    if (
      r === null ||
      typeof r !== 'object' ||
      !Number.isSafeInteger(r.pid) ||
      !Number.isSafeInteger(r.ppid) ||
      typeof r.name !== 'string' ||
      typeof r.starttime !== 'string' ||
      !/^\d+$/.test(r.starttime) ||
      (r.commandLine !== null && typeof r.commandLine !== 'string') ||
      (r.status !== undefined && r.status !== null && r.status !== 'tagged' && r.status !== 'unreadable')
    ) {
      throw new Error(`unexpected process query row: ${JSON.stringify(row)}`)
    }
    return { pid: r.pid as number, ppid: r.ppid as number, name: r.name, starttime: r.starttime, commandLine: r.commandLine, status: r.status ?? null }
  })
}

/**
 * The image name of the Electron the e2e suite runs (node_modules/electron), whose `--type=`
 * processes are Chromium's own. A constant, not read from the electron package, which throws where
 * Electron is not downloaded (the unit jobs).
 */
const ELECTRON_IMAGE = 'electron.exe'

/**
 * Whether a row is one of Chromium's own processes (renderer, GPU, utility, crash handler): Electron's
 * executable, started with a `--type=` switch. When a test starts Veydr itself with the tag, these
 * inherit it, and their sandbox may keep their environment from being read.
 */
const isChromiumHelper = (row: WindowsRow): boolean => row.name.toLowerCase() === ELECTRON_IMAGE && /(?:^|\s)--type=/.test(row.commandLine ?? '')

/**
 * The scenario's processes in the rows of a tag query. A live process that could not be read but
 * was started by a tagged one would be missed silently, so it fails the query instead: that is how
 * an elevated, protected, or 32-bit child of a scenario would show. Exempt are console hosts and
 * Chromium's own sandboxed processes, which never run a command. Unreadable processes started by
 * anything else are other users' or the system's, and cannot carry the tag.
 *
 * The check is one level deep: a child of an unreadable process, or an unreadable process whose
 * tagged parent has already exited, is not caught. No fixture starts such a process.
 */
export function taggedFromRows(rows: readonly WindowsRow[]): ProcessView[] {
  const tagged = rows.filter((row) => row.status === 'tagged')
  const taggedPids = new Set(tagged.map((row) => row.pid))
  const missed = rows.filter(
    (row) => row.status === 'unreadable' && taggedPids.has(row.ppid) && !WINDOWS_INFRASTRUCTURE.has(row.name.toLowerCase()) && !isChromiumHelper(row),
  )
  if (missed.length > 0) {
    throw new Error(`could not read the environment of processes started by tagged ones: ${missed.map((row) => `${row.name} (PID ${row.pid}, parent ${row.ppid})`).join(', ')}`)
  }
  return tagged.filter((row) => !WINDOWS_INFRASTRUCTURE.has(row.name.toLowerCase())).map(windowsView)
}

/**
 * Shared by every query: UTF-8 output (PowerShell would print the OEM code page), and the compiled
 * reader. The reader is compiled to a temporary name, copied, and only then given its final name,
 * so an interrupted compile never leaves a broken assembly where the next query would load it.
 */
const PRELUDE = `
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$assembly = $env:VEYDR_PROCESSES_ASSEMBLY
if (-not (Test-Path -LiteralPath $assembly)) {
  $partial = "$assembly.$PID.partial.dll"
  $copy = "$assembly.$PID.copy"
  try {
    Add-Type -TypeDefinition $env:VEYDR_PROCESSES_SOURCE -OutputAssembly $partial
    Copy-Item -LiteralPath $partial -Destination $copy
    Move-Item -LiteralPath $copy -Destination $assembly -Force
  } finally {
    Remove-Item -LiteralPath $partial, $copy -Force -ErrorAction SilentlyContinue
  }
}
if (-not ('VeydrTestProcesses' -as [type])) { Add-Type -LiteralPath $assembly }`

/** Prints the `$rows` a script selected, in the shape `parseWindowsRows` reads. */
const PRINT_ROWS = `
ConvertTo-Json -Compress -Depth 2 -InputObject @($rows | ForEach-Object {
  [pscustomobject]@{
    pid = [int]$_.Row.ProcessId
    ppid = [int]$_.Row.ParentProcessId
    name = [string]$_.Row.Name
    starttime = if ($null -eq $_.Row.CreationDate) { '0' } else { $_.Row.CreationDate.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) }
    commandLine = $_.Row.CommandLine
    status = $_.Status
  }
})`

/** The live processes among `VEYDR_PROCESSES_PIDS` (comma-separated, checked integers). */
const BY_PID = `${PRELUDE}
$filter = (($env:VEYDR_PROCESSES_PIDS -split ',') | ForEach-Object { 'ProcessId = ' + [int]$_ }) -join ' OR '
$rows = @(Get-CimInstance Win32_Process -Filter $filter | Where-Object { [VeydrTestProcesses]::Exists([uint32]$_.ProcessId) } | ForEach-Object { [pscustomobject]@{ Row = $_; Status = $null } })
${PRINT_ROWS}`

/**
 * The processes whose environment has `VEYDR_PROCESSES_NAME=VEYDR_PROCESSES_VALUE`, and the live
 * ones that could not be read. First the script checks the reader on its own environment, which
 * holds `VEYDR_PROCESSES_SELFCHECK`: it must find it under another letter case, and must not find
 * a different value. Otherwise reading or matching is broken, and "nothing tagged" would be a
 * failure taken for an answer.
 */
const TAGGED = `${PRELUDE}
$check = $env:VEYDR_PROCESSES_SELFCHECK
if ([VeydrTestProcesses]::Status([uint32]$PID, 'veydr_processes_selfcheck', $check) -ne [VeydrTestProcesses]::Tagged) { throw 'the environment reader did not find its own environment entry' }
if ([VeydrTestProcesses]::Status([uint32]$PID, 'VEYDR_PROCESSES_SELFCHECK', "$check-other") -ne [VeydrTestProcesses]::Untagged) { throw 'the environment reader matched a value it was not given' }
$name = $env:VEYDR_PROCESSES_NAME
$value = $env:VEYDR_PROCESSES_VALUE
$tagged = New-Object System.Collections.Generic.List[object]
$unreadable = New-Object System.Collections.Generic.List[object]
foreach ($process in Get-CimInstance Win32_Process) {
  if ($process.ProcessId -eq $PID -or $process.ProcessId -eq 0) { continue }
  $status = [VeydrTestProcesses]::Status([uint32]$process.ProcessId, $name, $value)
  if ($status -eq [VeydrTestProcesses]::Tagged) { $tagged.Add($process) }
  elseif ($status -eq [VeydrTestProcesses]::Unreadable) { $unreadable.Add($process) }
}
# Only unreadable processes started by a tagged one matter (taggedFromRows); the others are other
# users' and the system's, and are not printed.
$taggedPids = @($tagged | ForEach-Object { [int]$_.ProcessId })
$rows = @(
  @($tagged | ForEach-Object { [pscustomobject]@{ Row = $_; Status = 'tagged' } }) +
  @($unreadable | Where-Object { $taggedPids -contains [int]$_.ParentProcessId } | ForEach-Object { [pscustomobject]@{ Row = $_; Status = 'unreadable' } })
)
${PRINT_ROWS}`

const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows'
const POWERSHELL = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** A query slower than this is reported, so slow runners show up in the test output (it still runs). */
const SLOW_QUERY_MS = 5_000

let assemblyDir: string | undefined

/**
 * Where the compiled reader is kept for this test process: compiling it takes about a second, and a
 * query runs many times per test. The directory is a new one (`mkdtemp`) below the user's temporary
 * directory, whose permissions it inherits, and is removed when this process exits. The file name
 * carries a hash of the source, so a changed reader is compiled again.
 */
function assemblyPath(): string {
  if (assemblyDir === undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'veydr-processes-'))
    assemblyDir = dir
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }))
  }
  const hash = createHash('sha256').update(ENVIRONMENT_READER).digest('hex').slice(0, 16)
  return join(assemblyDir, `veydr-test-processes-${hash}.dll`)
}

/**
 * Runs `script` in Windows PowerShell and returns its rows. Every input reaches the script through
 * the environment, never through its text, and the script is passed encoded, so nothing is quoted.
 */
function runQuery(script: string, inputs: Readonly<Record<string, string>>): WindowsRow[] {
  const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'\n${script}`, 'utf16le').toString('base64')
  const started = Date.now()
  const run = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    env: {
      ...process.env,
      VEYDR_PROCESSES_ASSEMBLY: assemblyPath(),
      VEYDR_PROCESSES_SOURCE: ENVIRONMENT_READER,
      ...inputs,
    },
  })
  const elapsed = Date.now() - started
  if (elapsed > SLOW_QUERY_MS) process.stderr.write(`test/support/processes.ts: a process query took ${elapsed} ms\n`)
  if (run.error !== undefined) throw new Error(`the process query could not run: ${run.error.message}`)
  if (run.status !== 0) throw new Error(`the process query failed (exit ${String(run.status ?? run.signal)}): ${run.stderr.trim()}`)
  return parseWindowsRows(run.stdout)
}

const windowsView = ({ pid, ppid, starttime }: WindowsRow): ProcessView => ({ pid, ppid, starttime })

const windowsBackend: ProcessBackend = {
  tagged(tag) {
    return taggedFromRows(
      runQuery(TAGGED, {
        VEYDR_PROCESSES_NAME: TAG_VARIABLE,
        VEYDR_PROCESSES_VALUE: tag,
        VEYDR_PROCESSES_SELFCHECK: randomUUID(),
      }),
    )
  },
  identities(pids) {
    if (pids.length === 0) return new Map()
    return new Map(runQuery(BY_PID, { VEYDR_PROCESSES_PIDS: pids.join(',') }).map((row) => [row.pid, windowsView(row)]))
  },
  commandLines(pids) {
    if (pids.length === 0) return new Map()
    return new Map(runQuery(BY_PID, { VEYDR_PROCESSES_PIDS: pids.join(',') }).flatMap((row) => (row.commandLine === null ? [] : [[row.pid, row.commandLine] as const])))
  },
  kill(pid) {
    // TerminateProcess; the signal name is not used on Windows.
    process.kill(pid, 'SIGKILL')
  },
}

// ---------------------------------------------------------------------------------------------
// The dispatch and the portable functions

/**
 * The process backend of the system the tests run on. The only platform dispatch in the test code
 * (test-platform-policy.test.ts): any other system throws, so nothing here passes by not looking.
 */
export function selectProcessBackend(): ProcessBackend {
  switch (process.platform) {
    case 'linux':
      return linuxBackend
    case 'win32':
      return windowsBackend
    default:
      throw new Error(`test/support/processes.ts cannot inspect processes on ${process.platform}; it supports Linux and Windows`)
  }
}

let selected: ProcessBackend | undefined
const backend = (): ProcessBackend => (selected ??= selectProcessBackend())

/** Every live (non-zombie) process whose environment carries `VEYDR_FIXTURE_TAG=<tag>`, by PID. */
export function taggedProcesses(tag: string): ProcessView[] {
  checkTag(tag)
  return backend()
    .tagged(tag)
    .sort((a, b) => a.pid - b.pid)
}

/** The identity of process `pid` if it is alive, otherwise `null`. */
export function processIdentity(pid: number): ProcessView | null {
  checkPids([pid])
  return backend().identities([pid]).get(pid) ?? null
}

/** True if the process `pid` started at `starttime` is alive (on Linux: exists and is not a zombie). */
export function isAlive(pid: number, starttime: string | undefined): boolean {
  if (starttime === undefined || starttime === '') throw new Error(`no start time to identify process ${pid} by`)
  return processIdentity(pid)?.starttime === starttime
}

/** The command lines of the live processes among `pids` (arguments joined by spaces), by PID. */
export function commandLines(pids: readonly number[]): Map<number, string> {
  checkPids(pids)
  return backend().commandLines(pids)
}

/** Kills every tagged process (test cleanup; never used to prove anything). */
export function killTagged(tag: string): void {
  const current = backend()
  for (const view of taggedProcesses(tag)) {
    try {
      current.kill(view.pid)
    } catch (error) {
      // Gone since the query.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
}
