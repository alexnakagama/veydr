# Prints the code pages of the console this script was started with, for encoding.mjs (task 5.3,
# design D3). Runs under Windows PowerShell 5.1 (design D2):
#
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File codepages.ps1
#
# Prints one JSON line, { "acp": …, "oemcp": …, "consoleOutputCP": … }; GetConsoleOutputCP gives 0
# without a console. Only digits and ASCII, so the console's code page cannot garble it.
# Exit codes: 0 printed, 1 failure.
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

try {
  # C# 5: Add-Type in Windows PowerShell 5.1 compiles with the .NET Framework compiler.
  Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;

public static class VeydrProbeCodePages
{
    [DllImport("kernel32.dll")] public static extern uint GetACP();
    [DllImport("kernel32.dll")] public static extern uint GetOEMCP();
    [DllImport("kernel32.dll")] public static extern uint GetConsoleOutputCP();
}
'@
  $result = [ordered]@{
    acp = [VeydrProbeCodePages]::GetACP()
    oemcp = [VeydrProbeCodePages]::GetOEMCP()
    consoleOutputCP = [VeydrProbeCodePages]::GetConsoleOutputCP()
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Compress))
  exit 0
} catch {
  [Console]::Error.WriteLine("codepages.ps1: $($_.Exception.Message)")
  exit 1
}
