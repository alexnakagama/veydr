import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isChmodUnsupported, isErrno, type ConfigFs } from './fs'

export const FILE_MODE = 0o600
export const DIRECTORY_MODE = 0o700

/**
 * The new file is already in place (the rename succeeded) but flushing the
 * directory failed, so the rename may not survive a power loss.
 */
export class DirectorySyncError extends Error {
  override readonly name = 'DirectorySyncError'
  constructor(
    readonly path: string,
    override readonly cause: unknown,
  ) {
    super(`Saved ${path}, but flushing its directory failed: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/** How a rename that fails because another program holds the file is retried. */
export interface RenameRetry {
  /** Rename attempts in total, including the first: an integer of at least 1. */
  readonly attempts: number
  /** Wait before the second attempt, at least 0; each later wait is longer by the same amount. */
  readonly delayMs: number
  /** Waits `ms` milliseconds (injected by tests). */
  readonly sleep?: (ms: number) => Promise<void>
}

/** 5 attempts, waiting 50, 100, 150, and 200 ms in between (0.5 s in total). */
export const DEFAULT_RENAME_RETRY: RenameRetry = { attempts: 5, delayMs: 50 }

/**
 * Rename errors that mean another program briefly holds the source or target
 * open (on Windows: an antivirus scanner, a search indexer, or an editor).
 */
const TRANSIENT_RENAME_ERRORS = ['EPERM', 'EBUSY', 'EACCES'] as const

const isTransientRenameError = (error: unknown): boolean => TRANSIENT_RENAME_ERRORS.some((code) => isErrno(error, code))

export interface AtomicWriteOptions {
  /**
   * Flush the directory after the rename (default true). A caller that writes
   * several files into one directory may skip it for all but the last write,
   * since one directory fsync persists every rename before it. Callers on a
   * platform that cannot flush a directory always pass false.
   */
  readonly syncDirectory?: boolean
  /** Retries of a rename that fails transiently (default `DEFAULT_RENAME_RETRY`). */
  readonly renameRetry?: RenameRetry
}

/** Rejects a retry policy whose loop might not terminate (e.g. `attempts: NaN`) or wait sensibly. */
function checkRenameRetry(retry: RenameRetry): void {
  if (!Number.isInteger(retry.attempts) || retry.attempts < 1) {
    throw new RangeError(`renameRetry.attempts must be an integer of at least 1, got ${retry.attempts}`)
  }
  if (!Number.isFinite(retry.delayMs) || retry.delayMs < 0) {
    throw new RangeError(`renameRetry.delayMs must be a finite number of at least 0, got ${retry.delayMs}`)
  }
}

/**
 * Renames `from` over `to`, retrying only the errors in `TRANSIENT_RENAME_ERRORS`
 * with linear backoff. Any other error, and the last attempt's error, is
 * rethrown unchanged.
 */
async function renameWithRetry(fs: ConfigFs, from: string, to: string, retry: RenameRetry): Promise<void> {
  const sleep = retry.sleep ?? ((ms: number) => delay(ms))
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(from, to)
      return
    } catch (error) {
      if (attempt >= retry.attempts || !isTransientRenameError(error)) throw error
    }
    await sleep(retry.delayMs * attempt)
  }
}

/**
 * Replaces `path` with `data` so that, if the sequence is interrupted at any
 * step, `path` is either its complete previous content or the complete new
 * content: write `<path>.tmp` (mode 0600) → fsync → rename over `path` →
 * fsync the directory. A stale `<path>.tmp` from an earlier interruption is
 * removed first; nothing else ever reads it.
 *
 * A rename failing with `EPERM`, `EBUSY`, or `EACCES` (another program briefly
 * holding the file, common on Windows) is retried a bounded number of times
 * (`renameRetry`); on Linux these errors are permanent, so the same error is
 * reported after at most the total backoff. When the rename finally fails,
 * `path` is untouched and the complete `<path>.tmp` is left for the next write
 * to remove.
 */
export async function writeFileAtomic(
  fs: ConfigFs,
  path: string,
  data: Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const retry = options.renameRetry ?? DEFAULT_RENAME_RETRY
  // Checked before anything is written, so an invalid policy never leaves a temporary file.
  checkRenameRetry(retry)
  const tmp = `${path}.tmp`
  try {
    await fs.unlink(tmp)
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
  }

  const file = await fs.createExclusive(tmp, FILE_MODE)
  try {
    // The creation mode is filtered by the umask; set it explicitly. Where modes cannot be set,
    // the file keeps its creation mode (0600 minus the umask, never looser).
    try {
      await file.chmod(FILE_MODE)
    } catch (error) {
      if (!isChmodUnsupported(error)) throw error
    }
    await file.writeFile(data)
    await file.sync()
  } finally {
    await file.close()
  }
  await renameWithRetry(fs, tmp, path, retry)

  if (options.syncDirectory === false) return
  try {
    const dir = await fs.openDirectory(dirname(path))
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  } catch (error) {
    throw new DirectorySyncError(path, error)
  }
}
