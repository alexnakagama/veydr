# Reads the registry environment for environment.mjs (task 5.2, design D3), since Node has no registry
# API. Runs under Windows PowerShell 5.1 (design D2):
#
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File registry-env.ps1 -OutFile <file>
#
# Writes one JSON object to <file>, as UTF-8 without a BOM: { "machine": { name: value }, "user": { name:
# value } }, or { "error": … } with exit code 1. It goes to a file, not stdout, because stdout is in
# the console's code page, and a value may hold any character. The file holds real variable values,
# so the driver deletes it and writes only names to the result lines.
#
# Only REG_SZ and REG_EXPAND_SZ values are read, the kinds Windows puts in an environment.
# RegistryKey.GetValue expands REG_EXPAND_SZ against this process's environment, which is the driver's.
# A user without HKCU\Environment has an empty `user`.
param(
  [Parameter(Mandatory = $true)] [string] $OutFile
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$utf8 = New-Object System.Text.UTF8Encoding $false

function Read-Environment([Microsoft.Win32.RegistryKey] $Hive, [string] $Path) {
  $values = @{}
  $key = $Hive.OpenSubKey($Path)
  if ($null -eq $key) { return $values }
  try {
    foreach ($name in $key.GetValueNames()) {
      if ($name -eq '') { continue }
      $kind = $key.GetValueKind($name)
      if ($kind -eq [Microsoft.Win32.RegistryValueKind]::String -or $kind -eq [Microsoft.Win32.RegistryValueKind]::ExpandString) {
        $values[$name] = [string]$key.GetValue($name)
      }
    }
  } finally {
    $key.Close()
  }
  return $values
}

try {
  $result = [ordered]@{
    machine = Read-Environment ([Microsoft.Win32.Registry]::LocalMachine) 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
    user = Read-Environment ([Microsoft.Win32.Registry]::CurrentUser) 'Environment'
  }
  [System.IO.File]::WriteAllText($OutFile, (ConvertTo-Json -InputObject $result -Compress -Depth 3), $utf8)
  exit 0
} catch {
  $text = "registry-env.ps1: $($_.Exception.Message)"
  [Console]::Error.WriteLine($text)
  try { [System.IO.File]::WriteAllText($OutFile, (ConvertTo-Json -InputObject @{ error = $text } -Compress), $utf8) } catch { }
  exit 1
}
