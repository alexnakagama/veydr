# Windows process-tree fixture (add-windows-process-supervision task 4.2): a tree whose processes all
# leave their console with FreeConsole, so that no Ctrl+Break can reach any of them. Like tree.mjs,
# every process carries `-Marker <id>` on its command line and writes <Dir>/<Role>.json
# ({"pid":...}) once it and its children have left the console. Processes then stay alive until
# they are ended.
#
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File free-console.ps1
#                  -Marker <id> -Dir <dir> [-Role R] [-Children N]
#
# Children are started on this process's console (as a command's tools start theirs) before it
# leaves it, and each leaves it too.
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f-]+$')][string]$Marker,
  [Parameter(Mandatory = $true)][string]$Dir,
  [ValidatePattern('^[a-z0-9.]+$')][string]$Role = 'root',
  [ValidateRange(0, 8)][int]$Children = 0
)
$ErrorActionPreference = 'Stop'

Add-Type -Namespace VeydrFixture -Name Native -MemberDefinition '
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
'

function ReadyFile([string]$name) { Join-Path $Dir "$name.json" }

# Arguments quoted for the child's command line; none of them contains a quote.
function Quote([string]$text) { '"' + $text + '"' }

$powershell = (Get-Process -Id $PID).Path
for ($i = 0; $i -lt $Children; $i++) {
  $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Quote $PSCommandPath),
    '-Marker', $Marker, '-Dir', (Quote $Dir), '-Role', "$Role.$i") -join ' '
  Start-Process -FilePath $powershell -ArgumentList $arguments -NoNewWindow | Out-Null
}
for ($i = 0; $i -lt $Children; $i++) {
  while (-not (Test-Path -LiteralPath (ReadyFile "$Role.$i"))) { Start-Sleep -Milliseconds 20 }
}

if (-not [VeydrFixture.Native]::FreeConsole()) { throw "FreeConsole failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
if ([VeydrFixture.Native]::GetConsoleWindow() -ne [IntPtr]::Zero) { throw 'still attached to a console' }

$file = ReadyFile $Role
[IO.File]::WriteAllText("$file.tmp", "{`"pid`":$PID}")
[IO.File]::Move("$file.tmp", $file)

# Alive until ended; never ends on its own within a test.
while ($true) { Start-Sleep -Seconds 3600 }
