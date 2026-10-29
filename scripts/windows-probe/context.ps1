# Measures the context of a probe driver (design D9) for driver.mjs, which starts this script as its
# own child and turns the measurement into the ctx-no-console, ctx-job and ctx-standard-user answers.
# Runs under Windows PowerShell 5.1 (design D2):
#
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File context.ps1 -TargetPid <driver PID> [-ReadJobLimits]
#
# Node cannot call these APIs itself, so they are measured from here:
# - console: after FreeConsole, AttachConsole(ATTACH_PARENT_PROCESS) attaches to the console of this
#   script's parent, the driver. It fails with ERROR_INVALID_HANDLE (6) when the driver has none, and
#   GetConsoleWindow then returns no window. `parentPid` lets driver.mjs check the parent is the driver.
# - job: IsProcessInJob on the driver with no job handle. With -ReadJobLimits (driver.mjs passes it
#   when it started this script detached, so libuv put it in no job of its own), a process in a job
#   is in the driver's innermost job, and QueryInformationJobObject with no handle reads its limits.
# - token: the driver's token, its elevation and whether it holds Administrators (S-1-5-32-544),
#   including as a deny-only group, as in an administrator's filtered token.
# - hkcu: whether the user's registry hive is loaded (HKCU\Software opens), and whether
#   HKCU\Environment exists and opens; an access error on either is the section's error.
#
# Prints one JSON object to stdout, as UTF-8. A section that could not be measured is { "error": … }.
# Exit codes: 0 printed, 1 failure.
param(
  [Parameter(Mandatory = $true)] [int] $TargetPid,
  [switch] $ReadJobLimits
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

# Taken before any console call: FreeConsole and AttachConsole must not change where the result goes.
$stdout = [Console]::OpenStandardOutput()

# C# 5: Add-Type in Windows PowerShell 5.1 compiles with the .NET Framework compiler.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;

public static class VeydrProbeContext
{
    const uint ATTACH_PARENT_PROCESS = 0xFFFFFFFF;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint TOKEN_QUERY = 0x0008;
    const int TokenUser = 1, TokenGroups = 2, TokenElevationType = 18, TokenElevation = 20;
    const int JobObjectExtendedLimitInformation = 9;
    const int SE_GROUP_ENABLED = 0x4, SE_GROUP_USE_FOR_DENY_ONLY = 0x10;
    const string Administrators = "S-1-5-32-544";

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr ExitStatus, PebBaseAddress, AffinityMask, BasePriority, UniqueProcessId, InheritedFromUniqueProcessId;
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
    struct SID_AND_ATTRIBUTES
    {
        public IntPtr Sid;
        public int Attributes;
    }

    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint processId);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length, IntPtr returnLength);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returnLength);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int infoClass, ref PROCESS_BASIC_INFORMATION info, int length, out int returnLength);

    public sealed class ConsoleResult
    {
        public bool Attached;
        public int Error;
        public long Window;
    }

    public sealed class JobResult
    {
        public bool DriverInJob;
        public bool HelperInJob;
        public object LimitFlags;
        public string LimitsError;
    }

    public sealed class TokenResult
    {
        public string User;
        public bool Elevated;
        public string ElevationType;
        public string Administrators;
    }

    /** This process's parent PID, so the caller can check that ATTACH_PARENT_PROCESS means the driver. */
    public static int ParentPid()
    {
        var info = new PROCESS_BASIC_INFORMATION();
        int length;
        int status = NtQueryInformationProcess(GetCurrentProcess(), 0, ref info, Marshal.SizeOf(info), out length);
        if (status != 0) throw new InvalidOperationException("NtQueryInformationProcess failed with NTSTATUS 0x" + status.ToString("X8"));
        return info.InheritedFromUniqueProcessId.ToInt32();
    }

    /** Attaches to the parent's console, if it has one, records the result and the console window, and detaches again. */
    public static ConsoleResult ParentConsole()
    {
        // A helper started attached has a console of its own, which AttachConsole would refuse to replace.
        FreeConsole();
        var result = new ConsoleResult();
        result.Attached = AttachConsole(ATTACH_PARENT_PROCESS);
        result.Error = result.Attached ? 0 : Marshal.GetLastWin32Error();
        result.Window = GetConsoleWindow().ToInt64();
        if (result.Attached) FreeConsole();
        return result;
    }

    static bool InJob(IntPtr process)
    {
        bool inJob;
        if (!IsProcessInJob(process, IntPtr.Zero, out inJob)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return inJob;
    }

    static IntPtr OpenTarget(int processId)
    {
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        return process;
    }

    public static JobResult Job(int processId, bool readLimits)
    {
        var result = new JobResult();
        IntPtr process = OpenTarget(processId);
        try
        {
            result.DriverInJob = InJob(process);
        }
        finally
        {
            CloseHandle(process);
        }
        result.HelperInJob = InJob(GetCurrentProcess());
        if (!result.DriverInJob) return result;
        if (!readLimits)
        {
            result.LimitsError = "context.ps1 was started attached, so it is in libuv's job, not the driver's";
        }
        else if (!result.HelperInJob)
        {
            // The driver's job lets children leave silently, so this script is in no job to read.
            result.LimitsError = "context.ps1 is in no job although the driver is, so the driver's job allows silent breakaway";
        }
        else
        {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;
            if (QueryInformationJobObject(IntPtr.Zero, JobObjectExtendedLimitInformation, out info, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)), IntPtr.Zero))
                result.LimitFlags = info.BasicLimitInformation.LimitFlags;
            else
                result.LimitsError = new Win32Exception(Marshal.GetLastWin32Error()).Message;
        }
        return result;
    }

    static IntPtr TokenInformation(IntPtr token, int infoClass)
    {
        int length;
        GetTokenInformation(token, infoClass, IntPtr.Zero, 0, out length);
        if (length <= 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr buffer = Marshal.AllocHGlobal(length);
        if (!GetTokenInformation(token, infoClass, buffer, length, out length))
        {
            int error = Marshal.GetLastWin32Error();
            Marshal.FreeHGlobal(buffer);
            throw new Win32Exception(error);
        }
        return buffer;
    }

    public static TokenResult Token(int processId)
    {
        IntPtr process = OpenTarget(processId);
        IntPtr token;
        try
        {
            if (!OpenProcessToken(process, TOKEN_QUERY, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally
        {
            CloseHandle(process);
        }
        try
        {
            var result = new TokenResult();
            IntPtr buffer = TokenInformation(token, TokenUser);
            try
            {
                var sid = new SecurityIdentifier(Marshal.ReadIntPtr(buffer));
                try { result.User = sid.Translate(typeof(NTAccount)).Value; }
                catch (IdentityNotMappedException) { result.User = sid.Value; }
            }
            finally { Marshal.FreeHGlobal(buffer); }

            buffer = TokenInformation(token, TokenElevation);
            try { result.Elevated = Marshal.ReadInt32(buffer) != 0; }
            finally { Marshal.FreeHGlobal(buffer); }

            buffer = TokenInformation(token, TokenElevationType);
            try
            {
                int type = Marshal.ReadInt32(buffer);
                result.ElevationType = type == 1 ? "default" : type == 2 ? "full" : type == 3 ? "limited" : "unknown (" + type + ")";
            }
            finally { Marshal.FreeHGlobal(buffer); }

            // TOKEN_GROUPS: a DWORD count, then SID_AND_ATTRIBUTES entries aligned to a pointer.
            buffer = TokenInformation(token, TokenGroups);
            try
            {
                result.Administrators = "absent";
                int count = Marshal.ReadInt32(buffer);
                int size = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
                for (int i = 0; i < count; i++)
                {
                    var entry = (SID_AND_ATTRIBUTES)Marshal.PtrToStructure(new IntPtr(buffer.ToInt64() + IntPtr.Size + i * size), typeof(SID_AND_ATTRIBUTES));
                    if (new SecurityIdentifier(entry.Sid).Value != Administrators) continue;
                    result.Administrators = (entry.Attributes & SE_GROUP_USE_FOR_DENY_ONLY) != 0 ? "deny-only"
                        : (entry.Attributes & SE_GROUP_ENABLED) != 0 ? "enabled" : "disabled";
                }
            }
            finally { Marshal.FreeHGlobal(buffer); }
            return result;
        }
        finally
        {
            CloseHandle(token);
        }
    }
}
'@

# The innermost exception's message: PowerShell wraps .NET exceptions in MethodInvocationException.
function Get-ErrorText([System.Management.Automation.ErrorRecord] $Record) {
  $exception = $Record.Exception
  while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
  return $exception.Message
}

try {
  $result = [ordered]@{ targetPid = $TargetPid; parentPid = [VeydrProbeContext]::ParentPid() }

  try {
    $console = [VeydrProbeContext]::ParentConsole()
    $result.console = [ordered]@{ attached = $console.Attached; lastError = $console.Error; window = $console.Window }
  } catch {
    $result.console = @{ error = (Get-ErrorText $_) }
  }

  try {
    $job = [VeydrProbeContext]::Job($TargetPid, $ReadJobLimits.IsPresent)
    $result.job = [ordered]@{ driverInJob = $job.DriverInJob; helperInJob = $job.HelperInJob; limitFlags = $job.LimitFlags; limitsError = $job.LimitsError }
  } catch {
    $result.job = @{ error = (Get-ErrorText $_) }
  }

  try {
    $token = [VeydrProbeContext]::Token($TargetPid)
    $result.token = [ordered]@{ user = $token.User; elevated = $token.Elevated; elevationType = $token.ElevationType; administrators = $token.Administrators }
  } catch {
    $result.token = @{ error = (Get-ErrorText $_) }
  }

  # Whether the user's hive is loaded: HKCU\Software exists in every hive, including one just created
  # from the default profile. HKCU\Environment may be absent there, so it is recorded on its own:
  # whether it exists and how many values it holds. Values are never recorded.
  try {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software')
    if ($null -eq $key) {
      $result.hkcu = @{ error = 'HKCU\Software does not exist, so the user''s registry hive is not loaded' }
    } else {
      $key.Close()
      $environment = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
      if ($null -eq $environment) {
        $result.hkcu = [ordered]@{ environment = 'absent'; environmentValues = 0 }
      } else {
        try { $result.hkcu = [ordered]@{ environment = 'present'; environmentValues = $environment.GetValueNames().Count } } finally { $environment.Close() }
      }
    }
  } catch {
    $result.hkcu = @{ error = (Get-ErrorText $_) }
  }

  $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $result -Compress -Depth 4))
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
  exit 0
} catch {
  [Console]::Error.WriteLine("context.ps1: $(Get-ErrorText $_)")
  exit 1
}
