import { join } from 'node:path'
import { z } from 'zod'
import { DIRECTORY_MODE, writeFileAtomic } from '../config/atomic'
import { isChmodUnsupported, isErrno, nodeConfigFs, type ConfigFs } from '../config/fs'
import { fileTimestamp } from '../config/paths'
import type { LedgerEntry, PlatformLog, ProcessIdentity } from '../platform/types'

/** Directory (inside the configuration directory) and file of the runtime ledger (design D4, D9). */
export const LEDGER_DIR = 'runtime'
export const LEDGER_FILE = 'ledger.json'

/** Descendant updates are written at most this often (design D9); new and ended runs at once. */
export const LEDGER_UPDATE_INTERVAL_MS = 1_000

const identitySchema = z.strictObject({ pid: z.int().min(1), token: z.string().min(1) })

const entrySchema = z.strictObject({
  commandId: z.string().min(1),
  runId: z.string().min(1),
  leader: identitySchema,
  sessionId: z.int().min(1).nullable(),
  descendants: z.array(identitySchema),
})

const ledgerSchema = z.strictObject({ version: z.literal(1), entries: z.array(entrySchema) })

export interface LedgerLoad {
  /** Runs recorded by the previous session that it did not see end. */
  readonly entries: readonly LedgerEntry[]
  /** Why the ledger could not be read, if it could not; its runs are then unknown. */
  readonly problem: string | null
}

/**
 * Durable record of every run whose processes may be alive (design D9), so that a later launch
 * can find processes that outlived a crash of Veydr. Runs are added when they start and removed
 * once nothing of them is alive; a run that ended with survivors (or an unverified stop) stays.
 * After a clean quit the ledger holds no entries of that session.
 */
export interface RunLedger {
  /** Reads the ledger the previous session left. Call once, before anything is recorded. */
  load(): Promise<LedgerLoad>
  /**
   * Records a started run; written at once. Resolves once the write is done (or failed; failures
   * are reported), so a caller can wait until the run is durable.
   */
  add(entry: LedgerEntry): Promise<void>
  /** Replaces the observed descendants of a recorded run; written at most once per second. */
  updateDescendants(runId: string, descendants: readonly ProcessIdentity[]): void
  /** Removes a run because nothing of it is alive (or the user chose to forget it); written at once. */
  remove(runId: string): void
  /** Every recorded run, those of the previous session first. */
  entries(): readonly LedgerEntry[]
  /** Runs started in this session (not loaded from the previous one). */
  sessionEntries(): readonly LedgerEntry[]
  /** Resolves once everything recorded so far has been written (or failed to be; failures are reported). */
  flush(): Promise<void>
}

export interface RunLedgerOptions {
  /** The configuration directory (`app.getPath('userData')`). */
  readonly dir: string
  readonly log: PlatformLog
  /** Called when the ledger cannot be written, so crash recovery may miss runs. */
  readonly onWriteError?: (message: string) => void
  readonly fs?: ConfigFs
  readonly now?: () => number
  /**
   * Whether the platform can flush a directory (`platform.conventions.directorySync`, default
   * true). When false, writes skip the directory flush instead of failing on it.
   */
  readonly directorySync?: boolean
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const copyEntry = (entry: LedgerEntry): LedgerEntry => ({
  ...entry,
  leader: { ...entry.leader },
  descendants: entry.descendants.map((d) => ({ ...d })),
})

const sameIdentities = (a: readonly ProcessIdentity[], b: readonly ProcessIdentity[]): boolean =>
  a.length === b.length && a.every((identity, i) => identity.pid === b[i]?.pid && identity.token === b[i]?.token)

/** A ledger that could not be read or parsed, moved aside so the next write does not destroy it. */
export function damagedLedgerName(stamp: string): string {
  return `ledger.damaged-${stamp}.json`
}

export function ledgerPath(configDir: string): string {
  return join(configDir, LEDGER_DIR, LEDGER_FILE)
}

/**
 * The ledger at `<configDir>/runtime/ledger.json`, written atomically (`writeFileAtomic`: 0600
 * temporary file, fsync, rename, directory fsync where the platform supports it) in a 0700
 * directory. Writes are serialized and coalesced: each write stores the state at the moment it
 * starts.
 */
export function createRunLedger(options: RunLedgerOptions): RunLedger {
  const fs = options.fs ?? nodeConfigFs
  const now = options.now ?? Date.now
  const syncDirectory = options.directorySync ?? true
  const dir = join(options.dir, LEDGER_DIR)
  const path = join(dir, LEDGER_FILE)
  const runs = new Map<string, LedgerEntry>()
  const inherited = new Set<string>()

  /** A write is due that has not started yet. */
  let dirty = false
  let writing: Promise<void> | null = null
  let lazyTimer: NodeJS.Timeout | null = null
  let lastWriteAt = Number.NEGATIVE_INFINITY
  let directoryReady = false

  const prepareDirectory = async (): Promise<void> => {
    if (directoryReady) return
    await fs.mkdir(dir, DIRECTORY_MODE)
    try {
      await fs.chmod(dir, DIRECTORY_MODE)
    } catch (error) {
      if (!isChmodUnsupported(error)) throw error
      options.log.record('warn', 'ledger.chmod-failed', { path: dir, code: (error as NodeJS.ErrnoException).code })
    }
    directoryReady = true
  }

  const writeLoop = async (): Promise<void> => {
    while (dirty) {
      dirty = false
      lastWriteAt = now()
      const data = new TextEncoder().encode(`${JSON.stringify({ version: 1, entries: [...runs.values()] }, null, 2)}\n`)
      try {
        await prepareDirectory()
        await writeFileAtomic(fs, path, data, { syncDirectory })
      } catch (error) {
        options.log.record('error', 'ledger.write-failed', { path, message: messageOf(error) })
        options.onWriteError?.(messageOf(error))
      }
    }
  }

  const kick = (): void => {
    if (writing !== null) return
    writing = writeLoop().finally(() => {
      writing = null
      // A change may have arrived after the loop's last check and before this callback.
      if (dirty) kick()
    })
  }

  const writeNow = (): void => {
    if (lazyTimer !== null) {
      clearTimeout(lazyTimer)
      lazyTimer = null
    }
    dirty = true
    kick()
  }

  const writeSoon = (): void => {
    // A pending write (queued or timed) will include this change.
    if (dirty || lazyTimer !== null) return
    lazyTimer = setTimeout(
      () => {
        lazyTimer = null
        dirty = true
        kick()
      },
      Math.max(0, lastWriteAt + LEDGER_UPDATE_INTERVAL_MS - now()),
    )
    lazyTimer.unref()
  }

  const flush = async (): Promise<void> => {
    if (lazyTimer !== null) writeNow()
    while (writing !== null) await writing
  }

  /** Moves the unusable ledger aside; returns where it was kept, or `null` if it could not be. */
  const keepAside = async (): Promise<string | null> => {
    const stamp = fileTimestamp(new Date(now()))
    try {
      let kept = join(dir, damagedLedgerName(stamp))
      for (let n = 1; await fs.exists(kept); n += 1) kept = join(dir, damagedLedgerName(`${stamp}-${n}`))
      await fs.rename(path, kept)
      return kept
    } catch (error) {
      options.log.record('error', 'ledger.keep-failed', { path, message: messageOf(error) })
      return null
    }
  }

  const unusable = async (reason: string): Promise<LedgerLoad> => {
    const kept = await keepAside()
    return { entries: [], problem: kept === null ? `${path} ${reason}` : `${path} ${reason}; it was kept as ${kept}` }
  }

  return {
    async load() {
      let text: string
      try {
        text = new TextDecoder().decode(await fs.readFile(path))
      } catch (error) {
        if (isErrno(error, 'ENOENT')) return { entries: [], problem: null }
        options.log.record('error', 'ledger.read-failed', { path, message: messageOf(error) })
        return unusable(`could not be read (${messageOf(error)})`)
      }
      let parsed: z.infer<typeof ledgerSchema>
      try {
        parsed = ledgerSchema.parse(JSON.parse(text))
      } catch (error) {
        options.log.record('error', 'ledger.invalid', { path, message: messageOf(error) })
        return unusable('is damaged')
      }
      for (const entry of parsed.entries) {
        runs.set(entry.runId, entry)
        inherited.add(entry.runId)
      }
      return { entries: parsed.entries.map(copyEntry), problem: null }
    },

    add(entry) {
      runs.set(entry.runId, copyEntry(entry))
      writeNow()
      return flush()
    },

    updateDescendants(runId, descendants) {
      const entry = runs.get(runId)
      if (entry === undefined || sameIdentities(entry.descendants, descendants)) return
      runs.set(runId, { ...entry, descendants: descendants.map((d) => ({ ...d })) })
      writeSoon()
    },

    remove(runId) {
      if (!runs.delete(runId)) return
      inherited.delete(runId)
      writeNow()
    },

    entries: () => [...runs.values()].map(copyEntry),
    sessionEntries: () => [...runs.values()].filter((entry) => !inherited.has(entry.runId)).map(copyEntry),

    flush,
  }
}
