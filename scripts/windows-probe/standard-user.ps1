# Runs a probe driver as a temporary local standard user (design D9), because the runner account is
# an administrator. Runs under Windows PowerShell 5.1 (design D2), as administrator:
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows-probe/standard-user.ps1 -Results <results-file> -Timeout <seconds> -Driver <driver.mjs> [<driver args>...]
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows-probe/standard-user.ps1 -Cleanup
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows-probe/standard-user.ps1 -CheckPasswords <count>
#
# A run:
# 1. creates the local account veydr-probe, outside Administrators, with a 32-character password from
#    a cryptographic random generator that has an upper-case letter, a lower-case letter, a digit and
#    a symbol and no part of the account name (Windows Server's default complexity rules). The
#    password is masked with ::add-mask:: before anything else uses it, and is never written to a
#    file, a result line or a command line;
# 2. copies scripts/windows-probe to C:\veydr-probe-std, which only that account, Administrators and
#    SYSTEM can access (the job collects the results as administrator), and checks, as the account,
#    that the Node runtime's directory is readable to it;
# 3. starts the Secondary Logon service and, through CreateProcessWithLogonW (LOGON_WITH_PROFILE,
#    CREATE_NO_WINDOW, no environment block, no desktop), starts launch-detached.mjs as the account
#    with the absolute node.exe path. The account's registry hive is loaded and its environment is
#    built from its profile, as at logon; nothing of the job's environment reaches the driver, which
#    gets `<driver args> --user standard` on its command line;
# 4. appends the driver's result lines to <results-file>, and prints the launcher's log;
# 5. removes the account, its profile and C:\veydr-probe-std, whatever happened.
#
# If the account cannot be created or used (steps 1–3, including compiling the P/Invoke helper), the
# driver is started as administrator with `--unavailable <error>` instead, so every check it would
# have answered as the standard user is NOT-TESTABLE with the error, and ctx-standard-user's detail
# names it. If the launcher ran but failed (the driver crashed, timed out or exited with another
# code), the lines it wrote are kept and the checks it did not report stay missing ("no result" in
# the summary); the script then exits 1. Windows' error messages never contain the password.
#
# The waits add up to well under the step's timeout, so step 5 runs. If the step is still killed (a
# cancelled run), -Cleanup, the job's last step before the upload, removes what is left: it stops
# the account's processes and removes the account and its profile, deletes C:\veydr-probe-std
# whoever created it, and fails if the account was still there, since that means a run did not
# clean up after itself. If the account cannot be removed, it fails and leaves the directory.
# -CheckPasswords generates that many passwords and checks each against the complexity rules with a
# separate check, printing only counts (tasks 3.2).
#
# Exit codes: 0 the driver ran as the standard user and the launcher succeeded (or the check
# passed); 1 anything else.
[CmdletBinding(DefaultParameterSetName = 'Run', PositionalBinding = $false)]
param(
  [Parameter(Mandatory = $true, ParameterSetName = 'Run')] [string] $Results,
  [Parameter(Mandatory = $true, ParameterSetName = 'Run')] [ValidateRange(1, 3600)] [int] $Timeout,
  [Parameter(Mandatory = $true, ParameterSetName = 'Run')] [string] $Driver,
  [Parameter(ParameterSetName = 'Run', ValueFromRemainingArguments = $true)] [string[]] $DriverArgs = @(),
  [Parameter(Mandatory = $true, ParameterSetName = 'Cleanup')] [switch] $Cleanup,
  [Parameter(Mandatory = $true, ParameterSetName = 'CheckPasswords')] [ValidateRange(1, 100000)] [int] $CheckPasswords
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$AccountName = 'veydr-probe'
$ProbeRoot = 'C:\veydr-probe-std'
$PasswordLength = 32
$Upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
$Lower = 'abcdefghijklmnopqrstuvwxyz'
$Digits = '0123456789'
# No '%': the runner unescapes %25, %0D and %0A in ::add-mask:: values, so a password holding one
# would be masked as a different string.
$Symbols = '!#*+-.=?@_~'

# The innermost exception's message: PowerShell wraps .NET exceptions in MethodInvocationException.
function Get-ErrorText([System.Management.Automation.ErrorRecord] $Record) {
  $exception = $Record.Exception
  while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
  return ($exception.Message -replace '\s+', ' ').Trim()
}

function Test-PasswordComplexity([string] $Candidate) {
  return $Candidate.Length -eq $PasswordLength -and
    $Candidate -cmatch '[A-Z]' -and $Candidate -cmatch '[a-z]' -and $Candidate -match '[0-9]' -and $Candidate -match '[^A-Za-z0-9]' -and
    $Candidate -notmatch 'veydr|probe'
}

# A password for the account: 32 characters drawn uniformly from the alphabet by rejection sampling
# of cryptographic random bytes, redrawn until it meets the complexity rules.
function New-ProbePassword {
  $alphabet = $Upper + $Lower + $Digits + $Symbols
  # The largest multiple of the alphabet's size that fits in a byte, so no character is more likely.
  $limit = 256 - (256 % $alphabet.Length)
  $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $byte = New-Object byte[] 1
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
      $builder = New-Object System.Text.StringBuilder
      while ($builder.Length -lt $PasswordLength) {
        $random.GetBytes($byte)
        if ($byte[0] -lt $limit) { [void]$builder.Append($alphabet[$byte[0] % $alphabet.Length]) }
      }
      $candidate = $builder.ToString()
      if (Test-PasswordComplexity $candidate) { return $candidate }
    }
    throw 'no password met the complexity rules in 100 attempts'
  } finally {
    $random.Dispose()
  }
}

# One argument quoted by the CommandLineToArgvW rules, which Node uses to split its command line.
function ConvertTo-CommandLineArgument([string] $Value) {
  if ($Value -ne '' -and $Value -notmatch '[\s"]') { return $Value }
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($char in $Value.ToCharArray()) {
    if ($char -eq [char]92) {
      $backslashes++
      continue
    }
    # Backslashes before a quote are doubled, and the quote escaped; elsewhere they are literal.
    $count = if ($char -eq [char]34) { 2 * $backslashes + 1 } else { $backslashes }
    if ($count -gt 0) { [void]$builder.Append([char]92, $count) }
    [void]$builder.Append($char)
    $backslashes = 0
  }
  if ($backslashes -gt 0) { [void]$builder.Append([char]92, 2 * $backslashes) }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Join-CommandLine([string[]] $Arguments) {
  return (($Arguments | ForEach-Object { ConvertTo-CommandLineArgument $_ }) -join ' ')
}

# Stops the account's processes, then removes the account and its profile. Throws if the account
# cannot be removed; a profile still locked is a warning, since the runner VM is discarded anyway.
function Remove-ProbeAccount {
  $account = Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue
  if ($null -eq $account) { return }
  # Processes the driver left behind would keep the account's files and profile open.
  Get-Process -IncludeUserName -ErrorAction SilentlyContinue | Where-Object { $_.UserName -like "*\$AccountName" } | Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-LocalUser -SID $account.SID
  Write-Host "standard-user.ps1: removed the account $AccountName"
  try {
    $profiles = @(Get-CimInstance -ClassName Win32_UserProfile -Filter "SID = '$($account.SID.Value)'")
    $profiles | Remove-CimInstance
    if ($profiles.Count -gt 0) { Write-Host "standard-user.ps1: removed the profile of $AccountName" }
  } catch {
    Write-Warning "standard-user.ps1: cannot remove the profile of ${AccountName}: $(Get-ErrorText $_)"
  }
}

# Removes C:\veydr-probe-std; a file still locked is a warning, for the same reason.
function Remove-ProbeDirectory {
  if (-not (Test-Path -LiteralPath $ProbeRoot)) { return }
  try {
    Remove-Item -LiteralPath $ProbeRoot -Recurse -Force
    Write-Host "standard-user.ps1: removed $ProbeRoot"
  } catch {
    Write-Warning "standard-user.ps1: cannot remove ${ProbeRoot}: $(Get-ErrorText $_)"
  }
}

if ($PSCmdlet.ParameterSetName -eq 'Cleanup') {
  $leftover = $null -ne (Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue)
  try {
    Remove-ProbeAccount
  } catch {
    [Console]::Error.WriteLine("standard-user.ps1: cannot remove the account ${AccountName}: $(Get-ErrorText $_)")
    exit 1
  }
  Remove-ProbeDirectory
  if ($null -ne (Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue)) {
    [Console]::Error.WriteLine("standard-user.ps1: the account $AccountName still exists")
    exit 1
  }
  if ($leftover) {
    [Console]::Error.WriteLine("standard-user.ps1: the account $AccountName was left by an earlier step, which did not clean up; it is removed now")
    exit 1
  }
  Write-Host "standard-user.ps1: the account $AccountName does not exist"
  exit 0
}

if ($PSCmdlet.ParameterSetName -eq 'CheckPasswords') {
  # Checked character by character, independently of Test-PasswordComplexity, which the generator uses.
  $failed = 0
  $seen = New-Object 'System.Collections.Generic.HashSet[string]'
  for ($i = 0; $i -lt $CheckPasswords; $i++) {
    $sample = New-ProbePassword
    $classes = @{ upper = 0; lower = 0; digit = 0; symbol = 0; other = 0 }
    foreach ($char in $sample.ToCharArray()) {
      if ($Upper.IndexOf($char) -ge 0) { $classes.upper++ }
      elseif ($Lower.IndexOf($char) -ge 0) { $classes.lower++ }
      elseif ($Digits.IndexOf($char) -ge 0) { $classes.digit++ }
      elseif ($Symbols.IndexOf($char) -ge 0) { $classes.symbol++ }
      else { $classes.other++ }
    }
    $lowered = $sample.ToLowerInvariant()
    $ok = $sample.Length -eq $PasswordLength -and $classes.upper -gt 0 -and $classes.lower -gt 0 -and $classes.digit -gt 0 -and
      $classes.symbol -gt 0 -and $classes.other -eq 0 -and -not $lowered.Contains('veydr') -and -not $lowered.Contains('probe') -and
      $seen.Add($sample)
    if (-not $ok) { $failed++ }
  }
  $sample = $null
  if ($failed -gt 0) {
    [Console]::Error.WriteLine("standard-user.ps1: $failed of $CheckPasswords passwords break the complexity rules or repeat")
    exit 1
  }
  Write-Host "standard-user.ps1: $CheckPasswords passwords, each $PasswordLength characters with an upper-case letter, a lower-case letter, a digit and a symbol, none containing the account name, all distinct"
  exit 0
}

# ---------------------------------------------------------------------------------------------
# A run

# The P/Invoke helper for CreateProcessWithLogonW, compiled on first use, inside the run's error
# handling: a compile error then makes the standard user unavailable, with the reason.
# C# 5: Add-Type in Windows PowerShell 5.1 compiles with the .NET Framework compiler.
function Initialize-Logon {
  if ($null -ne ('VeydrProbeLogon' -as [type])) { return }
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security;
using System.Text;

public static class VeydrProbeLogon
{
    const uint LOGON_WITH_PROFILE = 0x1;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint WAIT_OBJECT_0 = 0x0, WAIT_TIMEOUT = 0x102;

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

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessWithLogonW(string username, string domain, IntPtr password, uint logonFlags, string applicationName,
        StringBuilder commandLine, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);

    /**
     * Starts `application` with `commandLine` as the local account `username`, with its profile and the
     * environment built from it, no console window and no desktop, and waits for it. Returns its exit
     * code, or null if it was still running after `timeoutMs` and was terminated.
     */
    public static int? Run(string username, SecureString password, string application, string commandLine, string directory, int timeoutMs)
    {
        var startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION process;
        IntPtr secret = Marshal.SecureStringToGlobalAllocUnicode(password);
        try
        {
            if (!CreateProcessWithLogonW(username, ".", secret, LOGON_WITH_PROFILE, application, new StringBuilder(commandLine),
                    CREATE_NO_WINDOW, IntPtr.Zero, directory, ref startup, out process))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally
        {
            Marshal.ZeroFreeGlobalAllocUnicode(secret);
        }
        try
        {
            uint wait = WaitForSingleObject(process.hProcess, (uint)timeoutMs);
            if (wait == WAIT_TIMEOUT)
            {
                TerminateProcess(process.hProcess, 1);
                WaitForSingleObject(process.hProcess, 10000);
                return null;
            }
            if (wait != WAIT_OBJECT_0) throw new Win32Exception(Marshal.GetLastWin32Error());
            uint code;
            if (!GetExitCodeProcess(process.hProcess, out code)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return unchecked((int)code);
        }
        finally
        {
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
        }
    }
}
'@
}

# An exit code, with what 0xC0000142 (STATUS_DLL_INIT_FAILED) usually means for a process started
# by CreateProcessWithLogonW without a desktop.
function Format-ExitCode([int] $Code) {
  if ($Code -eq -1073741502) { return "$Code (0xC0000142: a DLL failed to initialize, usually because the process has no access to the window station or desktop)" }
  return [string]$Code
}

# Paths are checked before the account exists, so a misconfigured step changes nothing.
if ($Driver -notmatch '^[a-z0-9-]+\.mjs$' -or -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $Driver) -PathType Leaf)) {
  [Console]::Error.WriteLine("standard-user.ps1: -Driver must name a driver in scripts/windows-probe, not '$Driver'")
  exit 1
}
foreach ($arg in $DriverArgs) {
  # Plain words only: the driver's options are added here, and nothing else reaches its command line.
  if ($arg -notmatch '^[a-z0-9][a-z0-9-]*$') {
    [Console]::Error.WriteLine("standard-user.ps1: driver arguments must be plain words, not '$arg'")
    exit 1
  }
}
$resultsPath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine((Get-Location).ProviderPath, $Results))
if (-not (Test-Path -LiteralPath $resultsPath -PathType Leaf)) {
  [Console]::Error.WriteLine("standard-user.ps1: $resultsPath does not exist; identity.mjs writes its first line")
  exit 1
}
$node = @(Get-Command -Name node.exe -CommandType Application)[0].Source
$launcher = Join-Path $PSScriptRoot 'launch-detached.mjs'
$stdScripts = Join-Path $ProbeRoot 'scripts\windows-probe'
$stdResults = Join-Path $ProbeRoot 'results\standard.jsonl'
$stdLog = Join-Path $ProbeRoot 'results\launcher.log'

$failure = $null
$unavailable = $null
$launcherRan = $false
$created = $false
$directoryCreated = $false
try {
  try {
    $password = New-ProbePassword
    # Masked before anything else uses it, so the runner hides it in every later log line.
    [Console]::Out.WriteLine("::add-mask::$password")
    [Console]::Out.Flush()
    $securePassword = ConvertTo-SecureString -String $password -AsPlainText -Force
    $password = $null

    try {
      Initialize-Logon
    } catch {
      throw "cannot compile the CreateProcessWithLogonW helper: $(Get-ErrorText $_)"
    }

    try {
      if ($null -ne (Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue)) { throw "the account already exists" }
      $account = New-LocalUser -Name $AccountName -Password $securePassword -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword `
        -Description 'Temporary standard user of the Windows probes'
      $created = $true
      # Users (S-1-5-32-545), which new local accounts are usually in already; never Administrators.
      try {
        Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $account
      } catch {
        if ($_.FullyQualifiedErrorId -notlike 'MemberExists*') { throw }
      }
    } catch {
      throw "cannot create the account ${AccountName}: $(Get-ErrorText $_)"
    }
    Write-Host "standard-user.ps1: created the account $AccountName ($($account.SID))"

    try {
      if (Test-Path -LiteralPath $ProbeRoot) { throw "$ProbeRoot already exists" }
      $directory = New-Item -ItemType Directory -Path $ProbeRoot
      $directoryCreated = $true
      $acl = New-Object System.Security.AccessControl.DirectorySecurity
      # Nothing inherited from C:\, where every user may read. Administrators and SYSTEM keep access,
      # so the job, as administrator, can collect the results and remove the directory.
      $acl.SetAccessRuleProtection($true, $false)
      $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
      foreach ($sid in @($account.SID, (New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-544'), (New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'))) {
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, [System.Security.AccessControl.FileSystemRights]::FullControl,
          $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)))
      }
      $directory.SetAccessControl($acl)
      New-Item -ItemType Directory -Path (Join-Path $ProbeRoot 'scripts'), (Join-Path $ProbeRoot 'results') | Out-Null
      Copy-Item -LiteralPath $PSScriptRoot -Destination (Join-Path $ProbeRoot 'scripts') -Recurse
    } catch {
      throw "cannot prepare ${ProbeRoot}: $(Get-ErrorText $_)"
    }

    try {
      Start-Service -Name seclogon
    } catch {
      throw "cannot start the Secondary Logon service (seclogon): $(Get-ErrorText $_)"
    }

    $nodeDirectory = Split-Path -Parent $node
    try {
      $code = [VeydrProbeLogon]::Run($AccountName, $securePassword, $node,
        (Join-CommandLine @($node, '-e', "require('fs').readdirSync(require('path').dirname(process.execPath))")), $ProbeRoot, 60000)
    } catch {
      throw "cannot start node.exe as $AccountName through CreateProcessWithLogonW: $(Get-ErrorText $_)"
    }
    if ($null -eq $code) { throw "node.exe, started as $AccountName to read the Node runtime's directory, did not finish within 60 s" }
    if ($code -ne 0) { throw "the Node runtime's directory $nodeDirectory is not readable to $AccountName (node.exe exited with $(Format-ExitCode $code))" }
  } catch {
    $unavailable = Get-ErrorText $_
    throw
  }

  $commandLine = Join-CommandLine (@($node, (Join-Path $stdScripts 'launch-detached.mjs'), '--timeout', [string]$Timeout, '--out', $stdResults, '--log', $stdLog, '--',
      (Join-Path $stdScripts $Driver)) + $DriverArgs + @('--user', 'standard'))
  Write-Host "standard-user.ps1: running $Driver $($DriverArgs -join ' ') as $AccountName"
  try {
    # The launcher stops its driver at -Timeout; a minute more lets it do so and report.
    $code = [VeydrProbeLogon]::Run($AccountName, $securePassword, $node, $commandLine, $ProbeRoot, ($Timeout + 60) * 1000)
  } catch {
    $unavailable = "cannot start the launcher as $AccountName through CreateProcessWithLogonW: $(Get-ErrorText $_)"
    throw $unavailable
  }
  $launcherRan = $true
  if ($null -eq $code) { throw "the launcher did not finish within $($Timeout + 60) s" }
  if ($code -ne 0) { throw "the launcher exited with $(Format-ExitCode $code)" }
} catch {
  $failure = Get-ErrorText $_
} finally {
  # Each part on its own: a failure collecting the results must not leave the account behind.
  if ($launcherRan) {
    try {
      # Written by the standard user: each line is prefixed, so none can start a workflow command (::).
      if (Test-Path -LiteralPath $stdLog) { Get-Content -LiteralPath $stdLog -Encoding UTF8 | ForEach-Object { Write-Host "  | $_" } }
      # Byte for byte: the launcher writes UTF-8, which Windows PowerShell's text cmdlets would re-encode.
      if (Test-Path -LiteralPath $stdResults) {
        $bytes = [System.IO.File]::ReadAllBytes($stdResults)
        $stream = [System.IO.File]::Open($resultsPath, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write)
        try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
        Write-Host "standard-user.ps1: appended the standard user's results to $Results"
      }
    } catch {
      $collection = "cannot collect the standard user's results: $(Get-ErrorText $_)"
      $failure = if ($null -eq $failure) { $collection } else { "$failure; $collection" }
    }
  }
  # Only an account this run created: one that existed before is not ours to remove (-Cleanup reports it).
  if ($created) {
    try {
      Remove-ProbeAccount
    } catch {
      $removal = "cannot remove the account ${AccountName}: $(Get-ErrorText $_)"
      $failure = if ($null -eq $failure) { $removal } else { "$failure; $removal" }
    }
  }
  if ($directoryCreated) { Remove-ProbeDirectory }
}

# The account could not be created or used: the driver's checks as the standard user are answered
# with the error, by the same driver started as administrator, through the same launcher. It
# measures nothing, so a minute is ample.
if ($null -ne $unavailable) {
  $arguments = @($launcher, '--timeout', '60', '--out', $resultsPath, '--', (Join-Path $PSScriptRoot $Driver)) + $DriverArgs + @('--user', 'standard', '--unavailable', $unavailable)
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $node
  $info.Arguments = Join-CommandLine $arguments
  $info.UseShellExecute = $false
  $process = [System.Diagnostics.Process]::Start($info)
  if (-not $process.WaitForExit(90000)) {
    # The launcher's detached driver too, not the launcher alone.
    & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $process.Id /T /F 2>&1 | Out-Null
    $failure = "$failure; the driver reporting the standard user as unavailable did not finish"
  } elseif ($process.ExitCode -ne 0) {
    $failure = "$failure; the driver reporting the standard user as unavailable exited with $($process.ExitCode)"
  }
}

if ($null -ne $failure) {
  [Console]::Error.WriteLine("standard-user.ps1: $failure")
  exit 1
}
exit 0
