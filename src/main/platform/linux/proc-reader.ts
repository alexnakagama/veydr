import { readFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isPidEntry, parseBootId, parseCmdline, parseStat, type ProcStat } from './procfs'

/** Reads process information from /proc. Every read tolerates processes vanishing mid-read. */
export interface ProcReader {
  /** The current boot's ID; read once. */
  bootId(): string
  /** `/proc/<pid>/stat`, read synchronously (used right before signalling); `null` if gone or unreadable. */
  stat(pid: number): ProcStat | null
  /** The command-line arguments; empty if gone or unreadable. */
  commandLine(pid: number): string[]
  /** `stat` of every visible process. */
  scan(): Promise<ProcStat[]>
}

export function createProcReader(root = '/proc'): ProcReader {
  let bootId: string | null = null

  return {
    bootId() {
      if (bootId === null) {
        const parsed = parseBootId(readFileSync(join(root, 'sys/kernel/random/boot_id'), 'utf8'))
        if (parsed === null) throw new Error('Unreadable boot ID in /proc/sys/kernel/random/boot_id')
        bootId = parsed
      }
      return bootId
    },

    stat(pid) {
      try {
        return parseStat(readFileSync(join(root, String(pid), 'stat'), 'utf8'))
      } catch {
        return null
      }
    },

    commandLine(pid) {
      try {
        return parseCmdline(readFileSync(join(root, String(pid), 'cmdline')))
      } catch {
        return []
      }
    },

    async scan() {
      const names = (await readdir(root)).filter(isPidEntry)
      const stats = await Promise.all(
        names.map(async (name) => {
          try {
            return parseStat(await readFile(join(root, name, 'stat'), 'utf8'))
          } catch {
            // Exited between readdir and read, or hidden (hidepid).
            return null
          }
        }),
      )
      return stats.filter((stat): stat is ProcStat => stat !== null)
    },
  }
}
