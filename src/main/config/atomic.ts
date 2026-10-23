import { dirname } from 'node:path'
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

export interface AtomicWriteOptions {
  /**
   * Flush the directory after the rename (default true). A caller that writes
   * several files into one directory may skip it for all but the last write,
   * since one directory fsync persists every rename before it.
   */
  readonly syncDirectory?: boolean
}

/**
 * Replaces `path` with `data` so that, if the sequence is interrupted at any
 * step, `path` is either its complete previous content or the complete new
 * content: write `<path>.tmp` (mode 0600) → fsync → rename over `path` →
 * fsync the directory. A stale `<path>.tmp` from an earlier interruption is
 * removed first; nothing else ever reads it.
 *
 * Windows needs rename retries on `EPERM`/`EBUSY` and has no directory fsync;
 * both belong to the Windows follow-up changes and are isolated here.
 */
export async function writeFileAtomic(
  fs: ConfigFs,
  path: string,
  data: Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
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
  await fs.rename(tmp, path)

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
