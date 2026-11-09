import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The system's temporary directory by its real path. On the Windows runner `os.tmpdir()` is an 8.3
 * short path (`C:\Users\RUNNER~1\…`), while the paths Veydr reports (checked or resolved folders)
 * are long ones; using the real path everywhere keeps the paths a test expects equal to them.
 */
const root = realpathSync.native(tmpdir())

/** A new, empty, private temporary directory whose name starts with `prefix`. */
export function tempDir(prefix: string): string {
  return mkdtempSync(join(root, prefix))
}

/**
 * Removes `path` and everything below it, if it exists. Retries for a while: Chromium's helper
 * processes may still hold files of a profile briefly after the app exited, which on Windows keeps
 * them from being removed (EBUSY, EPERM).
 */
export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
