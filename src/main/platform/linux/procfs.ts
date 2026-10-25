// Pure parsers for Linux /proc files (proc(5)). No I/O here; see `proc-reader.ts`.
import type { ProcessIdentity } from '../types'

/** The fields of `/proc/<pid>/stat` Veydr uses. */
export interface ProcStat {
  readonly pid: number
  /** Command name (field 2), at most 15 bytes; may contain spaces and parentheses. */
  readonly comm: string
  /** Field 3: R, S, D, Z (zombie), T, t, X, I, … */
  readonly state: string
  readonly ppid: number
  /** Process group ID. */
  readonly pgrp: number
  /** Session ID. */
  readonly session: number
  /**
   * Field 22: start time after boot in clock ticks. With the boot ID it identifies a process: a
   * reused PID has a different start time.
   */
  readonly starttime: number
}

const UNSIGNED = /^\d+$/

function unsigned(value: string | undefined): number | null {
  if (value === undefined || !UNSIGNED.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

/**
 * Parses `/proc/<pid>/stat`. The command name is delimited by the first `(` and the *last* `)`,
 * because it may itself contain both; all later fields are space-separated numbers or the state
 * letter. Returns `null` for anything malformed.
 */
export function parseStat(text: string): ProcStat | null {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 1 || close < open || text[open - 1] !== ' ') return null
  const pid = unsigned(text.slice(0, open - 1))
  // After the name: " <state> <ppid> <pgrp> <session> … <starttime>"; field n is at index n - 3.
  const fields = text.slice(close + 1).trim().split(' ')
  const [state, ppidText, pgrpText, sessionText] = fields
  const ppid = unsigned(ppidText)
  const pgrp = unsigned(pgrpText)
  const session = unsigned(sessionText)
  const starttime = unsigned(fields[19])
  if (pid === null || ppid === null || pgrp === null || session === null || starttime === null) return null
  if (state === undefined || !/^[A-Za-z]$/.test(state)) return null
  return { pid, comm: text.slice(open + 1, close), state, ppid, pgrp, session, starttime }
}

/** True for a process that can still run or be signalled: not a zombie (Z) and not dead (X/x). */
export function isLive(stat: ProcStat): boolean {
  return stat.state !== 'Z' && stat.state !== 'X' && stat.state !== 'x'
}

const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Parses `/proc/sys/kernel/random/boot_id`, which changes on every boot. */
export function parseBootId(text: string): string | null {
  const id = text.trim()
  return BOOT_ID.test(id) ? id : null
}

/**
 * Parses `/proc/<pid>/cmdline` (NUL-separated arguments). Kernel threads and zombies have none.
 */
export function parseCmdline(content: Buffer): string[] {
  if (content.length === 0) return []
  const args = content.toString('utf8').split('\0')
  if (args.at(-1) === '') args.pop()
  return args
}

/**
 * Name to show for a process: the file name of its first argument, else the kernel's command name.
 * The kernel name is often unhelpful (Node renames its main thread to `MainThread`).
 */
export function displayName(stat: Pick<ProcStat, 'comm'>, args: readonly string[]): string {
  const first = args[0] ?? ''
  const base = first.slice(first.lastIndexOf('/') + 1)
  return base === '' ? stat.comm : base
}

/**
 * The real, effective, saved, and file-system user IDs from `/proc/<pid>/status` (its `Uid:` line),
 * which every user can read; `null` if the line is missing or malformed.
 */
export function parseStatusUids(text: string): number[] | null {
  const line = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(text)
  return line === null ? null : line.slice(1).map(Number)
}

/** True for a /proc directory entry that names a process. */
export function isPidEntry(name: string): boolean {
  return UNSIGNED.test(name) && name !== '0'
}

/** Linux process identity (design D8): PID, start time (`/proc/<pid>/stat` field 22) and boot ID. */
export function linuxIdentity(bootId: string, stat: Pick<ProcStat, 'pid' | 'starttime'>): ProcessIdentity {
  return { pid: stat.pid, token: `${bootId}:${stat.starttime}` }
}

/** The boot ID and start time of a Linux identity token; `null` if it is not one. */
export function parseLinuxIdentity(identity: ProcessIdentity): { readonly bootId: string; readonly starttime: number } | null {
  const match = /^([0-9a-f-]{36}):(\d+)$/.exec(identity.token)
  if (match === null) return null
  const starttime = Number(match[2])
  return Number.isSafeInteger(starttime) ? { bootId: match[1] ?? '', starttime } : null
}
