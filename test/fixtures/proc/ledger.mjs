// Shared by the process fixtures: every fixture process appends one JSON line describing itself
// to a ledger file, so tests know exactly which processes were spawned (design D14).
import { appendFileSync, readFileSync } from 'node:fs'

/** Identity and grouping of this process, read from /proc/self/stat (proc(5)). */
export function selfStat() {
  const text = readFileSync('/proc/self/stat', 'utf8')
  // The command name (field 2) may contain spaces and parentheses; fields after it never do.
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(' ')
  return {
    pid: process.pid,
    ppid: Number(fields[1]),
    pgid: Number(fields[2]),
    sid: Number(fields[3]),
    starttime: fields[19],
  }
}

/**
 * Appends `{pid, ppid, pgid, sid, starttime, role, ...extra}` to `ledger`. One line is far below
 * PIPE_BUF, so concurrent appends from many processes (O_APPEND) never interleave.
 */
export function record(ledger, role, extra = {}) {
  appendFileSync(ledger, `${JSON.stringify({ ...selfStat(), role, ...extra })}\n`)
}

/** Keeps the event loop alive until the process is signalled. */
export function stayAlive() {
  setInterval(() => undefined, 1 << 30)
}
