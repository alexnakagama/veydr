import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { sep } from 'node:path'
import { SpawnError } from '../errors'
import type { ManagedProcess, ProcessTree, SpawnPlan } from '../types'
import { startHelperRun, type HelperClientOptions } from './helper-client'
import { PROTOCOL_VERSION } from './protocol'

/** Reads what `veydr-helper.exe version` prints; rejects if it cannot be run. */
export type ReadHelperVersion = (helperPath: string) => Promise<string>

export interface WindowsProcessTreeOptions extends HelperClientOptions {
  /** `veydr-helper.exe version` outside tests. */
  readonly readHelperVersion?: ReadHelperVersion
}

/** How long `veydr-helper.exe version` may take. */
export const VERSION_TIMEOUT_MS = 10_000

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Whether `path` names a file without depending on a current drive or directory: `C:\…` or a UNC
 * path, the rule the helper applies to the program (a root-relative `\…` is not enough). Where
 * paths are POSIX, which only tests reach, an absolute path is enough.
 */
export const isFullyQualified = (path: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path) || (sep === '/' && path.startsWith('/'))

/** Runs `<helper> version`, hidden, and resolves with its stdout. */
export const runHelperVersion: ReadHelperVersion = (helperPath) =>
  new Promise((resolve, reject) => {
    execFile(
      helperPath,
      ['version'],
      { encoding: 'utf8', windowsHide: true, timeout: VERSION_TIMEOUT_MS, maxBuffer: 1024, shell: false },
      (error: Error | null, stdout: string) => (error === null ? resolve(stdout) : reject(error)),
    )
  })

/**
 * Windows process trees (add-windows-process-supervision design D1): each command runs through its
 * own `veydr-helper.exe run`, which holds the command's Job Object. `spawn` refuses, before any
 * process of the command exists, a helper that is missing or speaks another protocol version
 * (design D5). The helper's version is read once per helper file, and again after it changes.
 */
export function createWindowsProcessTree(options: WindowsProcessTreeOptions): Pick<ProcessTree, 'spawn'> {
  const readVersion = options.readHelperVersion ?? runHelperVersion
  /** The checked helper file (size and modification time) and its check, shared by concurrent spawns. */
  let checked: { readonly key: string; readonly result: Promise<void> } | null = null

  async function checkHelper(): Promise<void> {
    const { helperPath } = options
    // A bare name would be looked up on PATH.
    if (!isFullyQualified(helperPath)) throw new SpawnError('other', `The Windows helper path must be absolute: ${helperPath}`)
    let key: string
    try {
      const info = await stat(helperPath)
      if (!info.isFile()) throw new Error('not a file')
      key = `${info.size}:${info.mtimeMs}`
    } catch {
      throw new SpawnError('other', `Windows helper not found: ${helperPath}`)
    }
    if (checked?.key !== key) {
      const result = verifyVersion(helperPath, readVersion)
      checked = { key, result }
      // A failed check is not remembered: the next spawn checks again.
      result.catch(() => {
        if (checked?.result === result) checked = null
      })
    }
    return checked.result
  }

  return {
    async spawn(plan: SpawnPlan): Promise<ManagedProcess> {
      await checkHelper()
      await checkPlan(plan)
      return startHelperRun(plan, options)
    },
  }
}

async function verifyVersion(helperPath: string, readVersion: ReadHelperVersion): Promise<void> {
  let output: string
  try {
    output = await readVersion(helperPath)
  } catch (error) {
    throw new SpawnError('other', `The Windows helper ${helperPath} could not report its protocol version: ${messageOf(error)}`)
  }
  const version = output.trim()
  if (version !== String(PROTOCOL_VERSION)) {
    const shown = /^[0-9]{1,9}$/.test(version) ? version : JSON.stringify(version.slice(0, 40))
    throw new SpawnError('other', `The Windows helper ${helperPath} speaks protocol version ${shown}, but Veydr needs version ${PROTOCOL_VERSION}`)
  }
}

/**
 * What the helper cannot report precisely: Node fails to start the helper itself for a missing
 * working directory, and that must not read as a missing helper. The helper also refuses a program
 * that is not given by its full path, so that nothing is looked up in the working directory.
 */
async function checkPlan(plan: SpawnPlan): Promise<void> {
  const hasNul = (text: string): boolean => text.includes('\0')
  if (hasNul(plan.file) || hasNul(plan.cwd) || plan.args.some(hasNul)) {
    throw new SpawnError('other', `Could not start ${plan.file.replaceAll('\0', '\\0')}: the command contains a NUL character`)
  }
  if (!isFullyQualified(plan.file)) throw new SpawnError('executable-not-found', `Executable not found: ${plan.file} (a full path is needed)`)

  let cwd
  try {
    cwd = await stat(plan.cwd)
  } catch (error) {
    const code = errnoOf(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new SpawnError('cwd-missing', `Working directory does not exist: ${plan.cwd}`)
    if (code === 'EACCES' || code === 'EPERM') throw new SpawnError('cwd-inaccessible', `Working directory is not accessible: ${plan.cwd}`)
    throw new SpawnError('other', `Working directory cannot be checked: ${plan.cwd} (${code ?? messageOf(error)})`)
  }
  if (!cwd.isDirectory()) throw new SpawnError('cwd-not-directory', `Working directory is not a directory: ${plan.cwd}`)

  let file
  try {
    file = await stat(plan.file)
  } catch (error) {
    const code = errnoOf(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new SpawnError('executable-not-found', `Executable not found: ${plan.file}`)
    throw new SpawnError('other', `Executable cannot be checked: ${plan.file} (${code ?? messageOf(error)})`)
  }
  if (!file.isFile()) throw new SpawnError('not-executable', `Not an executable file: ${plan.file}`)
}
