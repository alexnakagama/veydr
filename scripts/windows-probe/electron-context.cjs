'use strict'
// Loaded with `-r` into Electron's main process by electron.mjs (task 7.1), so that context.ps1 runs as
// a child of that process and measures its console, for ctx-electron-no-console. The result goes to the
// file named by VEYDR_PROBE_CONTEXT_FILE. As in driver.mjs's fallback, context.ps1 starts attached,
// since Windows PowerShell 5.1 started detached does not run it on the runner (task group 3 notes).
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const outFile = process.env.VEYDR_PROBE_CONTEXT_FILE
if (process.type === 'browser' && outFile) {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = join(__dirname, 'context.ps1')
  const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-TargetPid', String(process.pid), '-OutFile', outFile], {
    windowsHide: true,
    stdio: 'ignore',
  })
  child.on('error', (error) => {
    try {
      writeFileSync(outFile, JSON.stringify({ error: `cannot start Windows PowerShell: ${error.message}` }))
    } catch {
      // electron.mjs then reports that no result came; a probe must not throw inside the app.
    }
  })
}
