// Shared by the process fixtures: every fixture process appends one JSON line describing itself
// to a ledger file, so tests know exactly which processes were spawned (design D14).
import { appendFileSync, readFileSync } from 'node:fs'

/**
 * Identity and grouping of this process. `pid` and `ppid` come from Node on every system. The
 * process group, session and start time come from /proc/self/stat (proc(5)) and are recorded only
 * where /proc exists: on Windows they are absent, never invented, and the tests that read them are
 * `[linux-only: /proc]`. A test that needs a start time elsewhere reads it with `processIdentity`.
 */
export function selfStat() {
  const own = { pid: process.pid, ppid: process.ppid }
  let text
  try {
    text = readFileSync('/proc/self/stat', 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return own
    throw error
  }
  // The command name (field 2) may contain spaces and parentheses; fields after it never do.
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(' ')
  return { ...own, ppid: Number(fields[1]), pgid: Number(fields[2]), sid: Number(fields[3]), starttime: fields[19] }
}

/**
 * Appends `{pid, ppid, pgid?, sid?, starttime?, role, ...extra}` to `ledger`. One line is far below
 * PIPE_BUF, so concurrent appends from many processes (O_APPEND) never interleave.
 */
export function record(ledger, role, extra = {}) {
  appendFileSync(ledger, `${JSON.stringify({ ...selfStat(), role, ...extra })}\n`)
}

/** Keeps the event loop alive until the process is signalled. */
export function stayAlive() {
  setInterval(() => undefined, 1 << 30)
}
