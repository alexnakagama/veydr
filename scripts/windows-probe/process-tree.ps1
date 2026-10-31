# The Win32 side of the process-tree probes (design D2), for process-tree.mjs, which Node cannot do
# itself: Job Objects, IsProcessInJob, GetProcessTimes, console control events. Runs under Windows
# PowerShell 5.1:
#
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File process-tree.ps1
#
# It stays running and answers requests, because a job lives in this process's handles and compiling
# the C# takes seconds. Each line on stdin is { "id": n, "op": "...", ... }; each line on stdout is
# { "id": n, "ok": true, "result": ... } or { "id": n, "ok": false, "error": "...", "code": <Win32 error or null> }.
# The first line printed is { "ready": true } or { "ready": false, "error": "..." }.
#
# It is started attached, since Windows PowerShell 5.1 started detached does not run a script at all
# (see context.ps1), so it is in libuv's job with a hidden console of its own. It frees that console
# at once: like the driver it then has none, and `send-ctrl` can attach to a child's.
#
# Only a process that handles console events itself may attach: `ignore-console-events` makes it safe.
# SetConsoleCtrlHandler(NULL, TRUE) (design D3) covers only Ctrl+C, and PowerShell's own handler would
# act on Ctrl+Break, so a handler of ours that swallows every event runs first. The NULL setting is
# inherited by child processes, so a process that sends events must not be the one that starts them.
#
# Exit codes: 0 stdin closed, 1 failure. C# 5: Add-Type in Windows PowerShell 5.1 compiles with the
# .NET Framework compiler.
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$utf8 = New-Object System.Text.UTF8Encoding $false
$writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$writer.AutoFlush = $true

function Get-InnerException([System.Management.Automation.ErrorRecord] $Record) {
  $exception = $Record.Exception
  while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
  return $exception
}

function Write-Reply($Reply) {
  $writer.WriteLine((ConvertTo-Json -InputObject $Reply -Compress -Depth 6))
}

try {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class VeydrProbeTree
{
    const uint PROCESS_TERMINATE = 0x0001, PROCESS_SET_QUOTA = 0x0100, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint CREATE_SUSPENDED = 0x4, CREATE_NEW_PROCESS_GROUP = 0x200, CREATE_BREAKAWAY_FROM_JOB = 0x01000000, CREATE_NO_WINDOW = 0x08000000;
    const uint STILL_ACTIVE = 259, TH32CS_SNAPPROCESS = 0x2, CTRL_BREAK_EVENT = 1;
    const int JobObjectBasicProcessIdList = 3, JobObjectExtendedLimitInformation = 9;
    const int UOI_FLAGS = 1, UOI_NAME = 2, WSF_VISIBLE = 1;
    const int ERROR_NO_MORE_FILES = 18;
    /** Room for this many PIDs in a JOBOBJECT_BASIC_PROCESS_ID_LIST; a probe's job holds far fewer. */
    const int MaxJobPids = 4096;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32W
    {
        public uint dwSize, cntUsage, th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct USEROBJECTFLAGS
    {
        public int fInherit, fReserved, dwFlags;
    }

    delegate bool ConsoleHandler(uint ctrlType);

    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint processId);
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleCtrlHandler(ConsoleHandler handler, bool add);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetUserObjectInformation(IntPtr handle, int index, IntPtr info, int length, out int needed);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles,
        uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", SetLastError = true)] static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll", EntryPoint = "Process32NextW", SetLastError = true)] static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length, IntPtr returnLength);

    static readonly Dictionary<int, IntPtr> Jobs = new Dictionary<int, IntPtr>();
    static readonly Dictionary<int, IntPtr> SuspendedThreads = new Dictionary<int, IntPtr>();
    static int nextJob = 1;
    /** Held here so the garbage collector leaves it alone while Windows can still call it. */
    static ConsoleHandler swallow;
    static int eventsSwallowed;

    public sealed class ProcessState
    {
        public int Pid { get; set; }
        public bool Running { get; set; }
        /** FILETIME as a string: it does not fit a JSON number exactly. */
        public string Created { get; set; }
        public string Error { get; set; }
    }

    public sealed class ProcessStates { public ProcessState[] Processes { get; set; } }

    public sealed class ProcessEntry
    {
        public int Pid { get; set; }
        public int Parent { get; set; }
        public string Name { get; set; }
    }

    public sealed class ProcessList { public ProcessEntry[] Processes { get; set; } }

    public sealed class OwnJobInfo
    {
        public bool InJob { get; set; }
        public long? LimitFlags { get; set; }
        public string LimitsError { get; set; }
        public int[] Pids { get; set; }
        public string PidsError { get; set; }
    }

    public sealed class CtrlResult
    {
        public bool Attached { get; set; }
        public int AttachError { get; set; }
        public bool Sent { get; set; }
        public int SendError { get; set; }
    }

    public sealed class ConsoleWindowResult
    {
        public bool Attached { get; set; }
        public int AttachError { get; set; }
        public long Window { get; set; }
        public bool Visible { get; set; }
    }

    public sealed class WindowStation
    {
        public string Name { get; set; }
        public bool Visible { get; set; }
    }

    public sealed class PidReuse
    {
        public int Spawned { get; set; }
        public long ElapsedMs { get; set; }
        public int? ReusedPid { get; set; }
        public string FirstCreated { get; set; }
        public string SecondCreated { get; set; }
    }

    static Win32Exception LastError()
    {
        return new Win32Exception(Marshal.GetLastWin32Error());
    }

    static IntPtr Open(int processId, uint access)
    {
        IntPtr process = OpenProcess(access, false, processId);
        if (process == IntPtr.Zero) throw LastError();
        return process;
    }

    static IntPtr JobHandle(int job)
    {
        return Jobs[job];
    }

    /** Leaves this process's console, so it has none, like the driver. */
    public static void Detach()
    {
        FreeConsole();
    }

    public static void IgnoreConsoleEvents()
    {
        if (!SetConsoleCtrlHandler(null, true)) throw LastError();
        swallow = delegate(uint ctrlType)
        {
            Interlocked.Increment(ref eventsSwallowed);
            return true;
        };
        if (!SetConsoleCtrlHandler(swallow, true)) throw LastError();
    }

    /** How many console events reached this process's own handler. */
    public static int EventsSwallowed()
    {
        return Thread.VolatileRead(ref eventsSwallowed);
    }

    /** Whether each process runs, and when it was created; a process that ended is not found. */
    public static ProcessStates Inspect(int[] processIds)
    {
        var states = new List<ProcessState>();
        foreach (int processId in processIds)
        {
            var state = new ProcessState();
            state.Pid = processId;
            IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
            if (process == IntPtr.Zero)
            {
                int error = Marshal.GetLastWin32Error();
                // ERROR_INVALID_PARAMETER: no such process. Anything else says nothing about whether it runs.
                if (error != 87) state.Error = new Win32Exception(error).Message;
            }
            else
            {
                try
                {
                    uint code;
                    long creation, exit, kernel, user;
                    if (!GetExitCodeProcess(process, out code) || !GetProcessTimes(process, out creation, out exit, out kernel, out user)) throw LastError();
                    state.Running = code == STILL_ACTIVE;
                    state.Created = creation.ToString();
                }
                finally
                {
                    CloseHandle(process);
                }
            }
            states.Add(state);
        }
        var result = new ProcessStates();
        result.Processes = states.ToArray();
        return result;
    }

    public static ProcessList Snapshot()
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == new IntPtr(-1)) throw LastError();
        try
        {
            var entries = new List<ProcessEntry>();
            var entry = new PROCESSENTRY32W();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
            bool more = Process32First(snapshot, ref entry);
            while (more)
            {
                var listed = new ProcessEntry();
                listed.Pid = (int)entry.th32ProcessID;
                listed.Parent = (int)entry.th32ParentProcessID;
                listed.Name = entry.szExeFile;
                entries.Add(listed);
                more = Process32Next(snapshot, ref entry);
            }
            int error = Marshal.GetLastWin32Error();
            if (error != ERROR_NO_MORE_FILES) throw new Win32Exception(error);
            var result = new ProcessList();
            result.Processes = entries.ToArray();
            return result;
        }
        finally
        {
            CloseHandle(snapshot);
        }
    }

    public static int CreateJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw LastError();
        int id = nextJob++;
        Jobs[id] = job;
        return id;
    }

    public static void Assign(int job, int processId)
    {
        IntPtr process = Open(processId, PROCESS_SET_QUOTA | PROCESS_TERMINATE);
        try
        {
            if (!AssignProcessToJobObject(JobHandle(job), process)) throw LastError();
        }
        finally
        {
            CloseHandle(process);
        }
    }

    /** Whether a process is in `job`, or with job 0 in any job. */
    public static bool InJob(int processId, int job)
    {
        IntPtr process = Open(processId, PROCESS_QUERY_LIMITED_INFORMATION);
        try
        {
            bool inJob;
            if (!IsProcessInJob(process, job == 0 ? IntPtr.Zero : JobHandle(job), out inJob)) throw LastError();
            return inJob;
        }
        finally
        {
            CloseHandle(process);
        }
    }

    public static void TerminateJob(int job)
    {
        if (!TerminateJobObject(JobHandle(job), 1)) throw LastError();
    }

    /**
     * The job this process is directly in, which for a process started attached by the driver is
     * libuv's: a null handle means the caller's immediate job. Each part fails on its own.
     */
    public static OwnJobInfo OwnJob()
    {
        var result = new OwnJobInfo();
        bool inJob;
        if (!IsProcessInJob(new IntPtr(-1), IntPtr.Zero, out inJob)) throw LastError();
        result.InJob = inJob;
        if (!inJob) return result;

        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (QueryInformationJobObject(IntPtr.Zero, JobObjectExtendedLimitInformation, buffer, size, IntPtr.Zero))
            {
                var info = (JOBOBJECT_EXTENDED_LIMIT_INFORMATION)Marshal.PtrToStructure(buffer, typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                result.LimitFlags = info.BasicLimitInformation.LimitFlags;
            }
            else
            {
                result.LimitsError = LastError().Message;
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }

        // JOBOBJECT_BASIC_PROCESS_ID_LIST: two DWORD counts, then ULONG_PTR process IDs.
        const int header = 8;
        size = header + MaxJobPids * IntPtr.Size;
        buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (QueryInformationJobObject(IntPtr.Zero, JobObjectBasicProcessIdList, buffer, size, IntPtr.Zero))
            {
                int count = Marshal.ReadInt32(buffer, 4);
                var pids = new int[count];
                for (int i = 0; i < count; i++) pids[i] = Marshal.ReadIntPtr(buffer, header + i * IntPtr.Size).ToInt32();
                result.Pids = pids;
            }
            else
            {
                result.PidsError = LastError().Message;
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return result;
    }

    /** Starts a program with a hidden console of its own, which is what Node's windowsHide gives a child. */
    public static int Start(string application, string commandLine, bool suspended, bool newGroup, bool breakaway)
    {
        uint flags = CREATE_NO_WINDOW;
        if (suspended) flags |= CREATE_SUSPENDED;
        if (newGroup) flags |= CREATE_NEW_PROCESS_GROUP;
        if (breakaway) flags |= CREATE_BREAKAWAY_FROM_JOB;
        var startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION process;
        if (!CreateProcess(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, null, ref startup, out process))
            throw LastError();
        CloseHandle(process.hProcess);
        if (suspended) SuspendedThreads[process.dwProcessId] = process.hThread;
        else CloseHandle(process.hThread);
        return process.dwProcessId;
    }

    public static void Resume(int processId)
    {
        IntPtr thread = SuspendedThreads[processId];
        SuspendedThreads.Remove(processId);
        try
        {
            if (ResumeThread(thread) == 0xFFFFFFFF) throw LastError();
        }
        finally
        {
            CloseHandle(thread);
        }
    }

    public static void Terminate(int processId)
    {
        IntPtr process = Open(processId, PROCESS_TERMINATE);
        try
        {
            if (!TerminateProcess(process, 1)) throw LastError();
        }
        finally
        {
            CloseHandle(process);
        }
    }

    /** Attaches to the console of `processId`, sends the event to every process on it, and leaves. */
    public static CtrlResult SendCtrl(int processId, uint ctrlEvent)
    {
        var result = new CtrlResult();
        FreeConsole();
        result.Attached = AttachConsole((uint)processId);
        if (!result.Attached)
        {
            result.AttachError = Marshal.GetLastWin32Error();
            return result;
        }
        try
        {
            result.Sent = GenerateConsoleCtrlEvent(ctrlEvent, 0);
            if (!result.Sent) result.SendError = Marshal.GetLastWin32Error();
            // The event is delivered asynchronously, also to this process.
            Thread.Sleep(250);
        }
        finally
        {
            FreeConsole();
        }
        return result;
    }

    /** CTRL_BREAK_EVENT to a process group, from this process, which has no console (pt-ctrl-break-direct). */
    public static CtrlResult SendCtrlDirect(int processId)
    {
        var result = new CtrlResult();
        result.Sent = GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, (uint)processId);
        if (!result.Sent) result.SendError = Marshal.GetLastWin32Error();
        return result;
    }

    public static ConsoleWindowResult ConsoleWindow(int processId)
    {
        var result = new ConsoleWindowResult();
        FreeConsole();
        result.Attached = AttachConsole((uint)processId);
        if (!result.Attached)
        {
            result.AttachError = Marshal.GetLastWin32Error();
            return result;
        }
        try
        {
            IntPtr window = GetConsoleWindow();
            result.Window = window.ToInt64();
            result.Visible = window != IntPtr.Zero && IsWindowVisible(window);
        }
        finally
        {
            FreeConsole();
        }
        return result;
    }

    public static WindowStation CurrentWindowStation()
    {
        IntPtr station = GetProcessWindowStation();
        if (station == IntPtr.Zero) throw LastError();
        var result = new WindowStation();
        int needed;
        int size = Marshal.SizeOf(typeof(USEROBJECTFLAGS));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (!GetUserObjectInformation(station, UOI_FLAGS, buffer, size, out needed)) throw LastError();
            var flags = (USEROBJECTFLAGS)Marshal.PtrToStructure(buffer, typeof(USEROBJECTFLAGS));
            result.Visible = (flags.dwFlags & WSF_VISIBLE) != 0;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        size = 512;
        buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (!GetUserObjectInformation(station, UOI_NAME, buffer, size, out needed)) throw LastError();
            result.Name = Marshal.PtrToStringUni(buffer);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return result;
    }

    /**
     * Starts and ends short-lived processes until a PID recurs or a bound is reached (pt-identity-reuse).
     * Each starts suspended, so its creation time can be read before it ends, and it costs no console.
     */
    public static PidReuse FindPidReuse(string application, string commandLine, int maxProcesses, int maxMs)
    {
        var result = new PidReuse();
        var seen = new Dictionary<int, long>();
        var startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        var clock = System.Diagnostics.Stopwatch.StartNew();
        while (result.Spawned < maxProcesses && clock.ElapsedMilliseconds < maxMs)
        {
            PROCESS_INFORMATION process;
            if (!CreateProcess(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED | CREATE_NO_WINDOW,
                    IntPtr.Zero, null, ref startup, out process))
                throw LastError();
            result.Spawned++;
            try
            {
                long creation, exit, kernel, user;
                if (!GetProcessTimes(process.hProcess, out creation, out exit, out kernel, out user)) throw LastError();
                long first;
                if (seen.TryGetValue(process.dwProcessId, out first))
                {
                    result.ReusedPid = process.dwProcessId;
                    result.FirstCreated = first.ToString();
                    result.SecondCreated = creation.ToString();
                }
                seen[process.dwProcessId] = creation;
            }
            finally
            {
                TerminateProcess(process.hProcess, 1);
                WaitForSingleObject(process.hProcess, 5000);
                CloseHandle(process.hThread);
                CloseHandle(process.hProcess);
            }
            if (result.ReusedPid.HasValue) break;
        }
        result.ElapsedMs = clock.ElapsedMilliseconds;
        return result;
    }
}
'@
  [VeydrProbeTree]::Detach()
} catch {
  Write-Reply @{ ready = $false; error = (Get-InnerException $_).Message }
  exit 1
}

Write-Reply @{ ready = $true }

$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
while ($null -ne ($line = $reader.ReadLine())) {
  $request = $null
  try {
    $request = ConvertFrom-Json -InputObject $line
    $result = $null
    # Each case assigns: output from a switch would be unrolled into the pipeline.
    switch ($request.op) {
      'ping' { $result = @{ pid = $PID } }
      'ignore-console-events' { [VeydrProbeTree]::IgnoreConsoleEvents() }
      'events-swallowed' { $result = @{ count = [VeydrProbeTree]::EventsSwallowed() } }
      'inspect' { $result = [VeydrProbeTree]::Inspect([int[]]$request.pids) }
      'snapshot' { $result = [VeydrProbeTree]::Snapshot() }
      'create-job' { $result = @{ job = [VeydrProbeTree]::CreateJob() } }
      'assign' { [VeydrProbeTree]::Assign([int]$request.job, [int]$request.pid) }
      'in-job' { $result = @{ inJob = [VeydrProbeTree]::InJob([int]$request.pid, [int]$request.job) } }
      'terminate-job' { [VeydrProbeTree]::TerminateJob([int]$request.job) }
      'own-job' { $result = [VeydrProbeTree]::OwnJob() }
      'start' { $result = @{ pid = [VeydrProbeTree]::Start([string]$request.application, [string]$request.commandLine, [bool]$request.suspended, [bool]$request.newGroup, [bool]$request.breakaway) } }
      'resume' { [VeydrProbeTree]::Resume([int]$request.pid) }
      'terminate' { [VeydrProbeTree]::Terminate([int]$request.pid) }
      'send-ctrl' { $result = [VeydrProbeTree]::SendCtrl([int]$request.pid, [uint32]$request.event) }
      'send-ctrl-direct' { $result = [VeydrProbeTree]::SendCtrlDirect([int]$request.pid) }
      'console-window' { $result = [VeydrProbeTree]::ConsoleWindow([int]$request.pid) }
      'window-station' { $result = [VeydrProbeTree]::CurrentWindowStation() }
      'pid-reuse' { $result = [VeydrProbeTree]::FindPidReuse([string]$request.application, [string]$request.commandLine, [int]$request.maxProcesses, [int]$request.maxMs) }
      default { throw "unknown op '$($request.op)'" }
    }
    Write-Reply @{ id = $request.id; ok = $true; result = $result }
  } catch {
    $exception = Get-InnerException $_
    $code = if ($exception -is [System.ComponentModel.Win32Exception]) { $exception.NativeErrorCode } else { $null }
    $id = if ($null -ne $request) { $request.id } else { $null }
    Write-Reply @{ id = $id; ok = $false; error = $exception.Message; code = $code }
  }
}
exit 0
