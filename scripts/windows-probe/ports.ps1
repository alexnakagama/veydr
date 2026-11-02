# Reads the listening TCP sockets for ports.mjs (tasks 6.1–6.2, design D3), through Get-NetTCPConnection
# and GetExtendedTcpTable, and the name and creation time of every listener's owner. Runs under Windows
# PowerShell 5.1 (design D2):
#
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ports.ps1 -OutFile <file> -Calls <n>
#
# Writes one JSON object to <file>, as UTF-8 without a BOM:
#
#   { "ps": <listing>, "api": <listing>, "owners": { "rows": [<owner>...] } }
#
# A listing is { "durationsMs": [...], "rows": [{ "address", "port", "pid" }...] }. Each of the <n> reads
# is timed in this process, without PowerShell's startup or the C#'s compilation, and the rows are the
# last read's; `ps` comes first, so its first read includes loading the module, as the prediction
# says. One GetExtendedTcpTable read is the IPv4 table and the IPv6 table. An owner is { Pid, Name,
# NameError, Created, CreatedError, Gone }: the name comes from the process list, which needs no
# rights, and the creation time from a handle, which does. `Gone` is a process that ended after the
# table was read. The name and the creation time are read one after the other, and the table holds no
# creation time, so a PID reused in between would pair them wrongly; W3 must read them from one
# handle, or compare creation times. Created is a string, since a FILETIME does not fit a JSON number. Any section that
# fails is { "error": … } instead, and the others are still measured. It goes to a file, not stdout,
# because stdout is in the console's code page, and a process name may hold any character.
#
# Exit codes: 0 written, 1 failure. C# 5: Add-Type in Windows PowerShell 5.1 compiles with the .NET
# Framework compiler.
param(
  [Parameter(Mandatory = $true)] [string] $OutFile,
  [Parameter(Mandatory = $true)] [ValidateRange(1, 100)] [int] $Calls
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$utf8 = New-Object System.Text.UTF8Encoding $false

function Get-ErrorText([System.Management.Automation.ErrorRecord] $Record) {
  $exception = $Record.Exception
  while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
  return ($exception.Message -replace '\s+', ' ').Trim()
}

# Runs $Read, which returns a hashtable, or the section's { error }.
function Get-Section([scriptblock] $Read) {
  try {
    return (& $Read)
  } catch {
    return @{ error = (Get-ErrorText $_) }
  }
}

# Both sources name their properties alike, so one projection serves them.
function Measure-Listing([scriptblock] $Read) {
  $durations = New-Object 'System.Collections.Generic.List[double]'
  $connections = @()
  for ($call = 0; $call -lt $Calls; $call++) {
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $connections = @(& $Read)
    $clock.Stop()
    $durations.Add($clock.Elapsed.TotalMilliseconds)
  }
  $rows = @($connections | ForEach-Object {
    [ordered]@{ address = [string]$_.LocalAddress; port = [int]$_.LocalPort; pid = [int]$_.OwningProcess }
  })
  return @{ durationsMs = $durations.ToArray(); rows = $rows }
}

function Read-Api {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Net;
using System.Runtime.InteropServices;

public sealed class VeydrProbeListener
{
    public string LocalAddress { get; set; }
    public int LocalPort { get; set; }
    public int OwningProcess { get; set; }
}

public sealed class VeydrProbeOwner
{
    public int Pid { get; set; }
    public string Name { get; set; }
    public string NameError { get; set; }
    public string Created { get; set; }
    public string CreatedError { get; set; }
    public bool Gone { get; set; }
}

public static class VeydrProbePorts
{
    const int AF_INET = 2, AF_INET6 = 23, TCP_TABLE_OWNER_PID_LISTENER = 3;
    const uint NO_ERROR = 0, ERROR_INSUFFICIENT_BUFFER = 122;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const int ERROR_INVALID_PARAMETER = 87;
    /** The table can grow between asking for its size and reading it. */
    const int MaxAttempts = 5;
    /** Room for sockets opened between the two calls, so that a growing table rarely needs another attempt. */
    const int SlackBytes = 1024;
    /** A table's rows start after its DWORD count. */
    const int RowsOffset = 4;
    /** MIB_TCPROW_OWNER_PID: state, local address, local port, remote address, remote port, PID. */
    const int Row4Size = 24, Row4Address = 4, Row4Port = 8, Row4Pid = 20;
    /** MIB_TCP6ROW_OWNER_PID: local address and scope, local port, remote address, scope and port, state, PID. */
    const int Row6Size = 56, Row6Address = 0, Row6Port = 20, Row6Pid = 52;

    [DllImport("iphlpapi.dll")]
    static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool sorted, int family, int tableClass, uint reserved);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    public static VeydrProbeListener[] Listeners()
    {
        var rows = new List<VeydrProbeListener>();
        Read(AF_INET, 4, Row4Size, Row4Address, Row4Port, Row4Pid, rows);
        Read(AF_INET6, 16, Row6Size, Row6Address, Row6Port, Row6Pid, rows);
        return rows.ToArray();
    }

    static void Read(int family, int addressLength, int rowSize, int addressOffset, int portOffset, int pidOffset, List<VeydrProbeListener> rows)
    {
        for (int attempt = 0; attempt < MaxAttempts; attempt++)
        {
            int size = 0;
            uint result = GetExtendedTcpTable(IntPtr.Zero, ref size, false, family, TCP_TABLE_OWNER_PID_LISTENER, 0);
            if (result != NO_ERROR && result != ERROR_INSUFFICIENT_BUFFER) throw new Win32Exception((int)result);
            if (size < RowsOffset) throw new InvalidOperationException("GetExtendedTcpTable reported no room for a table");
            size += SlackBytes;
            IntPtr table = Marshal.AllocHGlobal(size);
            try
            {
                result = GetExtendedTcpTable(table, ref size, false, family, TCP_TABLE_OWNER_PID_LISTENER, 0);
                if (result == ERROR_INSUFFICIENT_BUFFER) continue;
                if (result != NO_ERROR) throw new Win32Exception((int)result);
                int count = Marshal.ReadInt32(table);
                for (int i = 0; i < count; i++)
                {
                    IntPtr row = IntPtr.Add(table, RowsOffset + i * rowSize);
                    var address = new byte[addressLength];
                    Marshal.Copy(IntPtr.Add(row, addressOffset), address, 0, addressLength);
                    // The port is in network byte order, in the low 16 bits of its DWORD.
                    int port = Marshal.ReadByte(row, portOffset) << 8 | Marshal.ReadByte(row, portOffset + 1);
                    var listener = new VeydrProbeListener();
                    listener.LocalAddress = new IPAddress(address).ToString();
                    listener.LocalPort = port;
                    listener.OwningProcess = Marshal.ReadInt32(row, pidOffset);
                    rows.Add(listener);
                }
                return;
            }
            finally
            {
                Marshal.FreeHGlobal(table);
            }
        }
        throw new InvalidOperationException("the TCP table kept growing while it was read");
    }

    public static VeydrProbeOwner ReadOwner(int processId)
    {
        var owner = new VeydrProbeOwner();
        owner.Pid = processId;
        try
        {
            using (var process = Process.GetProcessById(processId)) owner.Name = process.ProcessName;
        }
        catch (Exception error)
        {
            owner.NameError = error.Message;
        }
        IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        if (handle == IntPtr.Zero)
        {
            int error = Marshal.GetLastWin32Error();
            owner.CreatedError = new Win32Exception(error).Message;
            // ERROR_INVALID_PARAMETER: no such process, even if the name was read just before it ended.
            // PID 0, the Idle process, also gives it, and exists.
            owner.Gone = error == ERROR_INVALID_PARAMETER && processId != 0;
            return owner;
        }
        try
        {
            long creation, exit, kernel, user;
            if (GetProcessTimes(handle, out creation, out exit, out kernel, out user)) owner.Created = creation.ToString();
            else owner.CreatedError = new Win32Exception(Marshal.GetLastWin32Error()).Message;
        }
        finally
        {
            CloseHandle(handle);
        }
        return owner;
    }
}
'@
  return (Measure-Listing { [VeydrProbePorts]::Listeners() })
}

function Read-Owners($Listing) {
  $owners = @($Listing.rows | ForEach-Object { $_['pid'] } | Sort-Object -Unique | ForEach-Object { [VeydrProbePorts]::ReadOwner([int]$_) })
  return @{ rows = $owners }
}

try {
  $report = [ordered]@{}
  $report.ps = Get-Section { Measure-Listing { Get-NetTCPConnection -State Listen } }
  $report.api = Get-Section { Read-Api }
  $report.owners = if ($report.api.ContainsKey('error')) {
    @{ error = 'GetExtendedTcpTable gave no listeners to read' }
  } else {
    Get-Section { Read-Owners $report.api }
  }
  [System.IO.File]::WriteAllText($OutFile, (ConvertTo-Json -InputObject $report -Compress -Depth 5), $utf8)
  exit 0
} catch {
  $text = "ports.ps1: $(Get-ErrorText $_)"
  [Console]::Error.WriteLine($text)
  try { [System.IO.File]::WriteAllText($OutFile, (ConvertTo-Json -InputObject @{ error = $text } -Compress), $utf8) } catch { }
  exit 1
}
