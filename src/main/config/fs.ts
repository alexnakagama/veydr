import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'

/** A file opened for writing. */
export interface WritableFile {
  chmod(mode: number): Promise<void>
  writeFile(data: Uint8Array): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

/** A directory opened only to flush its entries (`fsync` on the directory). */
export interface SyncableDirectory {
  sync(): Promise<void>
  close(): Promise<void>
}

/**
 * The filesystem operations configuration storage uses. Injected so that
 * unit tests can interrupt a save at any single step.
 */
export interface ConfigFs {
  mkdir(path: string, mode: number): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  exists(path: string): Promise<boolean>
  readFile(path: string): Promise<Uint8Array>
  /** Creates `path` exclusively (`O_CREAT | O_EXCL`); fails if it exists. */
  createExclusive(path: string, mode: number): Promise<WritableFile>
  openDirectory(path: string): Promise<SyncableDirectory>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
}

export const nodeConfigFs: ConfigFs = {
  async mkdir(path, mode) {
    await mkdir(path, { recursive: true, mode })
  },
  chmod: (path, mode) => chmod(path, mode),
  async exists(path) {
    try {
      await lstat(path)
      return true
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return false
      throw error
    }
  },
  readFile: (path) => readFile(path),
  createExclusive: (path, mode) => open(path, 'wx', mode),
  openDirectory: (path) => open(path, 'r'),
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
}

export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}

/**
 * chmod errors meaning "permissions cannot be changed here" (a directory owned
 * by someone else, or a filesystem without POSIX modes such as FAT or some
 * network mounts). Configuration storage keeps working and reports them.
 */
export function isChmodUnsupported(error: unknown): boolean {
  return ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL'].some((code) => isErrno(error, code))
}
