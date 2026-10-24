'use strict'
// Test-only: loaded with `-r`. Simulates processes Veydr is not permitted to signal (as with a
// setuid program): `process.kill` fails with EPERM for every process whose command line contains
// `:setsid`, i.e. the escaped subtree of the `tree.mjs --escape` fixture. Nothing else changes.
const { readFileSync } = require('node:fs')

const kill = process.kill.bind(process)
process.kill = (pid, signal) => {
  if (typeof pid === 'number' && pid > 0) {
    let cmdline = ''
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, 'latin1')
    } catch {
      // Gone: let the real call report it.
    }
    if (cmdline.includes(':setsid')) {
      throw Object.assign(new Error(`kill EPERM`), { code: 'EPERM', errno: -1, syscall: 'kill' })
    }
  }
  return kill(pid, signal)
}
