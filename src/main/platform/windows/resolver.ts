import { lstat as nodeLstat, realpath as nodeRealpath, stat as nodeStat } from 'node:fs/promises'
import { win32 } from 'node:path'
import { envNameKey } from '../../../shared/config'
import { resolveWorkingDirectory } from '../resolve-cwd'
import type { CommandResolver, CommandSpec, Env, PlatformLog, ResolveResult, SpawnPlan } from '../types'
import { batchCommandLine, CommandLineError, helperLaunch, isBatchFile, shellCommandLine } from './command-line'

// Windows command resolution (add-windows-environment-and-commands design D2). Every path here is a
// Windows path, so `win32` is used explicitly: the resolver then behaves the same in the unit tests
// that run it on every system with a fake filesystem.

/**
 * How long one `Path` directory, or any other filesystem check of a start, may take to answer
 * (design D2): an unreachable network share delays a start but cannot block it.
 */
export const PATH_DIRECTORY_TIMEOUT_MS = 2000

/**
 * How many `Path` directories may go unanswered before the search stops. A check that does not
 * answer keeps one of libuv's four filesystem threads busy until Windows gives up on the share, so
 * more of them would stall every later check, and Veydr's other file access, behind it.
 */
export const MAX_UNANSWERED_DIRECTORIES = 2

/** The extensions tried when `PATHEXT` is unset or holds none (Windows' own default for `cmd.exe`). */
export const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/** The only file types Veydr starts on Windows; any other first match is refused, not skipped. */
export const ACCEPTED_PROGRAM_TYPES = ['.exe', '.com', '.bat', '.cmd'] as const

/** The Windows directory when `SystemRoot` is unset or not a full path. */
const FALLBACK_SYSTEM_ROOT = 'C:\\Windows'

const ACCEPTED_LIST = '.exe, .com, .bat and .cmd'

/** Characters no Windows file name can hold (`:` only after a drive letter), and control characters. */
const INVALID_NAME_CHARACTERS = /[<>:"|?*\u0000-\u001f]/

/**
 * DOS device names, which Windows resolves to a device in any directory and with any extension
 * (`C:\bin\nul.cmd` is the NUL device), so a check would find them everywhere.
 */
const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:[ ]*\..*)?$/i

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code

const isDriveFullPath = (path: string): boolean => /^[A-Za-z]:[\\/]/.test(path)
const isUncPath = (path: string): boolean => /^[\\/]{2}[^\\/.?]/.test(path)
const isDevicePath = (path: string): boolean => /^[\\/]{2}[.?][\\/]/.test(path)
/** `C:tool.exe`: relative to the current directory of drive C:, which Veydr does not control. */
const isDriveRelative = (path: string): boolean => /^[A-Za-z]:(?![\\/])/.test(path)
/** `\tool.exe`: relative to the root of the current drive. */
const isRootRelative = (path: string): boolean => /^[\\/](?![\\/])/.test(path)

/**
 * `cmd.exe` in the Windows system directory (design D2): `<SystemRoot>\System32\cmd.exe`, with
 * `SystemRoot` read from Veydr's own environment, or `C:\Windows` when it is unset or not a plain
 * full drive path. `%ComSpec%` is not used, since any process of the user can change it.
 */
export function systemCmdExe(systemRoot: string | undefined): string {
  return win32.join(isUsableSystemRoot(systemRoot) ? systemRoot : FALLBACK_SYSTEM_ROOT, 'System32', 'cmd.exe')
}

/** Whether `systemCmdExe` uses `systemRoot`: a full drive path without `"`, `%`, NUL or a line break. */
export function isUsableSystemRoot(systemRoot: string | undefined): systemRoot is string {
  return systemRoot !== undefined && isDriveFullPath(systemRoot) && !/["%\0\r\n]/.test(systemRoot)
}

/** The filesystem calls the resolver makes; Windows' own by default, a fake in unit tests. */
export interface WindowsResolverFs {
  /**
   * Existence of a program: `lstat`, so App Execution Aliases (reparse points, for which `stat` can
   * fail with `EACCES` or `UNKNOWN`) are found.
   */
  readonly lstat: (path: string) => Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>
  /** The native realpath, which follows junctions and symbolic links and expands 8.3 short names. */
  readonly realpath: (path: string) => Promise<string>
  readonly stat: (path: string) => Promise<{ isDirectory(): boolean }>
}

/** `fs/promises` `realpath` is the native realpath (`fs.realpath.native`'s semantics). */
const NODE_FS: WindowsResolverFs = { lstat: nodeLstat, realpath: nodeRealpath, stat: nodeStat }

export interface WindowsResolverOptions {
  /** The full path of the `cmd.exe` that runs batch files (`systemCmdExe`); the shell setting does not apply. */
  readonly cmdExe: string
  readonly fs?: Partial<WindowsResolverFs>
  /** The time limit of one `Path` directory and of any other check, `PATH_DIRECTORY_TIMEOUT_MS` by default. */
  readonly directoryTimeoutMs?: number
  readonly log?: PlatformLog
}

const failed = (...diagnostics: string[]): ResolveResult => ({ ok: false, diagnostics })

/** A value of `env` looked up regardless of letter case, as Windows does (the first match). */
function lookup(env: Env, name: string): string | undefined {
  const key = envNameKey(name, 'case-insensitive')
  for (const [entry, value] of Object.entries(env)) if (envNameKey(entry, 'case-insensitive') === key) return value
  return undefined
}

/** The usable extensions of a `PATHEXT` value, in order; entries that are not `.<name>` are ignored. */
export function usableExtensions(pathext: string): string[] {
  return pathext
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => /^\.[^\\/.<>:"|?*\s]+$/.test(entry))
}

/** The extensions tried: those of `PATHEXT`, or `DEFAULT_PATHEXT`'s when it is unset or has none usable. */
export function pathExtensions(pathext: string | undefined): string[] {
  const extensions = pathext === undefined ? [] : usableExtensions(pathext)
  return extensions.length > 0 ? extensions : usableExtensions(DEFAULT_PATHEXT)
}

/**
 * The directories of `Path` that are searched, in order. As `cmd.exe` reads it, double quotes are
 * removed and a `;` between them belongs to the entry (`"C:\a;b"` is one directory). Entries left
 * empty, relative, drive- or root-relative, or device paths are skipped. The working directory is
 * never added (W0 `cmd-pathext-cwd`).
 */
export function pathDirectories(path: string | undefined): string[] {
  if (path === undefined) return []
  const entries: string[] = []
  let entry = ''
  let quoted = false
  for (const ch of path) {
    if (ch === '"') quoted = !quoted
    else if (ch === ';' && !quoted) {
      entries.push(entry)
      entry = ''
    } else entry += ch
  }
  entries.push(entry)
  return entries.filter((directory) => (isDriveFullPath(directory) || isUncPath(directory)) && !/[\0\r\n]/.test(directory))
}

/**
 * Why `name`, a file name or the last segment of a path, cannot name a program, or `null`. Windows
 * drops trailing dots and spaces from a file name, so a name ending in one would start another file
 * than the one shown, and `:` would name a data stream.
 */
function badFileName(name: string): string | null {
  if (name === '' || name === '.' || name === '..') return 'it names no file'
  if (INVALID_NAME_CHARACTERS.test(name)) return 'it contains a character Windows file names cannot hold (< > : " | ? * or a control character)'
  if (/[. ]$/.test(name)) return 'it ends in a dot or a space, which Windows drops from file names'
  if (RESERVED_DEVICE_NAME.test(name)) return `"${name}" is a Windows device name (such as CON, NUL, COM1 or LPT1), not a file`
  return null
}

/**
 * Why the path `path`, as the user gave it, cannot name a program, or `null`. Its drive or UNC
 * prefix is not a segment; `.`, `..` and empty segments are allowed on the way, but every named
 * segment, and the last segment, must be a usable file name (`badFileName`).
 */
function badPath(path: string): string | null {
  const rest = isDriveFullPath(path) ? path.slice(3) : /^[\\/]{2}/.test(path) ? path.slice(2) : path
  const segments = rest.split(/[\\/]/)
  for (const [index, segment] of segments.entries()) {
    if (index < segments.length - 1 && (segment === '' || segment === '.' || segment === '..')) continue
    const bad = badFileName(segment)
    if (bad !== null) return bad
  }
  return null
}

const programType = (path: string): string => win32.extname(path).toLowerCase()

type Found = { readonly kind: 'found'; readonly path: string } | { readonly kind: 'missing' } | { readonly kind: 'directory' }

const isMissing = (error: unknown): boolean => errnoOf(error) === 'ENOENT' || errnoOf(error) === 'ENOTDIR'

/**
 * Whether `path` exists as something other than a directory; rejects for any error but "missing".
 * A symbolic link or junction is followed with `stat` to see whether it leads to a directory or
 * nowhere; one `stat` cannot follow (an App Execution Alias) counts as found.
 */
async function existing(fs: WindowsResolverFs, path: string, stopped: () => boolean = () => false): Promise<Found> {
  let info
  try {
    info = await fs.lstat(path)
  } catch (error) {
    if (isMissing(error)) return { kind: 'missing' }
    throw error
  }
  if (info.isDirectory()) return { kind: 'directory' }
  if (!info.isSymbolicLink()) return { kind: 'found', path }
  // An abandoned search (see `search`) starts no further check.
  if (stopped()) return { kind: 'missing' }
  try {
    return (await fs.stat(path)).isDirectory() ? { kind: 'directory' } : { kind: 'found', path }
  } catch (error) {
    return isMissing(error) ? { kind: 'missing' } : { kind: 'found', path }
  }
}

const TIMED_OUT = Symbol('timed out')

async function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined
  try {
    // `race` handles a later rejection of `promise`, so an abandoned check cannot go unhandled.
    return await Promise.race([promise, new Promise<typeof TIMED_OUT>((done) => (timer = setTimeout(() => done(TIMED_OUT), ms)))])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Checks that did not answer in time and are still running, by key (a directory or a path). Each
 * one holds a libuv filesystem thread until Windows gives up on its share, which can take tens of
 * seconds, so a later start does not add another check of the same place while one is waiting:
 * that place counts as unanswered at once. An entry goes once its check settles.
 */
class Abandoned {
  readonly #waiting = new Map<string, Promise<unknown>>()

  has(key: string): boolean {
    return this.#waiting.has(key)
  }

  add(key: string, check: Promise<unknown>): void {
    this.#waiting.set(key, check)
    const clear = (): void => {
      if (this.#waiting.get(key) === check) this.#waiting.delete(key)
    }
    check.then(clear, clear)
  }
}

const STILL_WAITING = 'an earlier check of it has not answered yet'

/**
 * The key a hung check is remembered by: for a UNC path its server (`\\server`), since a server
 * that does not answer hangs every path on it; otherwise the path itself, without letter case or a
 * trailing separator. A mapped network drive is keyed by path, so several paths on one dead mapped
 * drive can each hold a thread (design D2).
 */
export function checkKey(path: string): string {
  const normalized = win32.normalize(path).toLowerCase()
  const server = /^\\\\([^\\]+)/.exec(normalized)
  if (server !== null) return `\\\\${server[1] ?? ''}`
  return /^[a-z]:\\$/.test(normalized) ? normalized : normalized.replace(/\\+$/, '')
}

const timeoutError = (message: string): Error => Object.assign(new Error(message), { code: 'ETIMEDOUT' })

/**
 * `call` of one path, rejecting with an `ETIMEDOUT` error when it has not answered within `ms`, or
 * at once while an earlier call for the same path (`key`) is still waiting.
 */
function bounded<T>(call: (path: string) => Promise<T>, ms: number, abandoned: Abandoned): (path: string) => Promise<T> {
  return async (path) => {
    const key = checkKey(path)
    if (abandoned.has(key)) throw timeoutError(STILL_WAITING)
    const check = call(path)
    const result = await within(check, ms)
    if (result === TIMED_OUT) {
      abandoned.add(key, check)
      throw timeoutError(`no answer within ${ms} ms`)
    }
    return result
  }
}

/** How a failed check is shown: the timeout in words, otherwise the error code. */
const reasonOf = (error: unknown): string => (errnoOf(error) === 'ETIMEDOUT' ? (error as Error).message : (errnoOf(error) ?? String(error)))

/**
 * A plan, after the checks the helper repeats at spawn (`helperLaunch`), so that a refusal is
 * reported now, with its reason, and no process is ever created for it.
 */
function checkedPlan(plan: SpawnPlan): ResolveResult {
  try {
    helperLaunch(plan)
    return { ok: true, plan }
  } catch (error) {
    if (error instanceof CommandLineError) return failed(error.message)
    throw error
  }
}

/**
 * Windows command resolution (design D2):
 *
 * - the project folder and working directory are checked by `resolveWorkingDirectory`, with the
 *   native realpath and Windows paths (compared regardless of case);
 * - direct mode:
 *   - a full drive or UNC path is used as given (normalized), a drive-relative (`C:tool.exe`) or
 *     root-relative (`\tool.exe`) path is refused, and any other path containing `\` or `/` is
 *     resolved against the working directory;
 *   - a bare name is looked up in the effective `Path`, never in the working directory: in each
 *     directory the name as given if it has an extension, then with each `PATHEXT` extension in
 *     order. Each directory has `directoryTimeoutMs`; one that does not answer, or cannot be read,
 *     is skipped and named, and the search stops after `MAX_UNANSWERED_DIRECTORIES` unanswered;
 *   - the first match must be an `.exe`, `.com`, `.bat` or `.cmd` file; another type is refused,
 *     not skipped, so Veydr never starts a later match the user did not expect;
 *   - a batch file runs through `options.cmdExe` with a `batchCommandLine`, any other program with
 *     its own path and `args`;
 * - shell mode runs the script verbatim through the configured shell, which must be a full path to
 *   a file named `cmd.exe` (`shellCommandLine`);
 * - every other filesystem check (the project folder, the working directory, a program or shell
 *   given by path) has the same time limit, so no unreachable share can block a start;
 * - a directory or path whose earlier check has not answered yet, in any search of this resolver,
 *   counts as unanswered at once, so repeated starts cannot pile up hung checks (`Abandoned`,
 *   keyed by `checkKey`). This works only within one resolver: the platform must create a single
 *   resolver for all starts, never one per start.
 */
export function createWindowsCommandResolver(options: WindowsResolverOptions): CommandResolver {
  const fs: WindowsResolverFs = { ...NODE_FS, ...options.fs }
  const timeoutMs = options.directoryTimeoutMs ?? PATH_DIRECTORY_TIMEOUT_MS
  const abandoned = new Abandoned()
  // Every check outside the PATH search, which limits each directory as a whole.
  const limitedRealpath = bounded(fs.realpath, timeoutMs, abandoned)
  const limitedStat = bounded(fs.stat, timeoutMs, abandoned)
  const limitedExisting = bounded((path: string) => existing(fs, path), timeoutMs, abandoned)
  const { cmdExe } = options

  /** The program at `path`, which the user gave (`shown`), checked for existence and type. */
  async function programAt(path: string, shown: string, what: 'Executable' | 'Shell'): Promise<{ ok: true; path: string } | { ok: false; diagnostic: string }> {
    let found: Found
    try {
      found = await limitedExisting(path)
    } catch (error) {
      return { ok: false, diagnostic: `${what} cannot be read: ${path} (${reasonOf(error)})` }
    }
    if (found.kind === 'missing') return { ok: false, diagnostic: `${what} not found: ${shown}` }
    if (found.kind === 'directory') return { ok: false, diagnostic: `${what} is a directory, not a file: ${path}` }
    return { ok: true, path }
  }

  /** The first existing candidate for the bare `name` in the effective `Path` (design D2). */
  async function search(name: string, env: Env): Promise<{ ok: true; path: string } | { ok: false; diagnostics: string[] }> {
    const pathext = lookup(env, 'PATHEXT')
    const extensions = pathExtensions(pathext)
    if (pathext !== undefined && pathext.trim() !== '' && usableExtensions(pathext).length === 0) {
      options.log?.record('warn', 'command.pathext-unusable', { fallback: DEFAULT_PATHEXT })
    }
    const candidates = [...(win32.extname(name) === '' ? [] : [name]), ...extensions.map((extension) => name + extension)]
    const skipped: string[] = []
    let unanswered = 0
    /** Counts an unanswered directory; the search result once too many did not answer, else `null`. */
    const unansweredDirectory = (directory: string, reason: string, logged: string): { ok: false; diagnostics: string[] } | null => {
      unanswered++
      skipped.push(`${directory} (${reason})`)
      options.log?.record('warn', 'command.path-directory-skipped', { directory, reason: logged })
      if (unanswered < MAX_UNANSWERED_DIRECTORIES) return null
      return {
        ok: false,
        diagnostics: [
          `Executable not found: ${name} (the search of PATH stopped after ${unanswered} directories did not answer within ${timeoutMs} ms)`,
          `These PATH directories were skipped: ${skipped.join('; ')}`,
        ],
      }
    }
    for (const directory of pathDirectories(lookup(env, 'PATH'))) {
      const key = checkKey(directory)
      if (abandoned.has(key)) {
        const stop = unansweredDirectory(directory, STILL_WAITING, 'still-waiting')
        if (stop !== null) return stop
        continue
      }
      // Set once the directory's time is up, so that no further check is started in it.
      let cancelled = false
      const stopped = (): boolean => cancelled
      const inDirectory = async (): Promise<string | null> => {
        for (const candidate of candidates) {
          if (cancelled) return null
          const found = await existing(fs, win32.join(directory, candidate), stopped)
          if (found.kind === 'found') return found.path
        }
        return null
      }
      const check = inDirectory()
      let match: string | null | typeof TIMED_OUT
      try {
        match = await within(check, timeoutMs)
      } catch (error) {
        skipped.push(`${directory} (${reasonOf(error)})`)
        options.log?.record('warn', 'command.path-directory-skipped', { directory, reason: errnoOf(error) ?? 'error' })
        continue
      }
      if (match === TIMED_OUT) {
        cancelled = true
        abandoned.add(key, check)
        const stop = unansweredDirectory(directory, `no answer within ${timeoutMs} ms`, 'timeout')
        if (stop !== null) return stop
        continue
      }
      if (match !== null) return { ok: true, path: match }
    }
    return {
      ok: false,
      diagnostics: [
        `Executable not found: ${name} (searched PATH with the extensions ${extensions.join(';')})`,
        ...(skipped.length === 0 ? [] : [`These PATH directories were skipped: ${skipped.join('; ')}`]),
      ],
    }
  }

  async function direct(spec: CommandSpec, cwd: string, env: Env): Promise<ResolveResult> {
    const { file } = spec
    if (file === '') return failed('No program is given')
    if (file.includes('\0')) return failed('The program contains a NUL character')
    if (isDevicePath(file)) return failed(`The program must be an ordinary drive or UNC path, not a \\\\.\\ or \\\\?\\ path: ${file}`)
    if (isDriveRelative(file) || isRootRelative(file)) {
      return failed(`The program "${file}" depends on the current drive or its current directory: give a full path (C:\\…) or a path relative to the working directory`)
    }

    let program: string
    if (/[\\/]/.test(file)) {
      const bad = badPath(file)
      if (bad !== null) return failed(`The program path "${file}" cannot be used: ${bad}`)
      // A full path is used as given; any other path is relative to the working directory.
      const path = win32.resolve(cwd, file)
      const found = await programAt(path, file, 'Executable')
      if (!found.ok) return failed(found.diagnostic)
      program = found.path
    } else {
      const bad = badFileName(file)
      if (bad !== null) return failed(`The program name "${file}" cannot be used: ${bad}`)
      const found = await search(file, env)
      if (!found.ok) return failed(...found.diagnostics)
      program = found.path
    }

    if (!(ACCEPTED_PROGRAM_TYPES as readonly string[]).includes(programType(program))) {
      return failed(`${program} is not a program Veydr can start on Windows: only ${ACCEPTED_LIST} files are started`)
    }
    if (!isBatchFile(program)) return checkedPlan({ file: program, args: [...spec.args], cwd, env })
    try {
      return checkedPlan({ file: cmdExe, args: [], cwd, env, commandLine: batchCommandLine(cmdExe, program, spec.args) })
    } catch (error) {
      if (error instanceof CommandLineError) return failed(error.message)
      throw error
    }
  }

  async function shell(spec: CommandSpec, cwd: string, env: Env): Promise<ResolveResult> {
    const shellPath = spec.shellPath ?? ''
    const full = isDriveFullPath(shellPath) || isUncPath(shellPath)
    if (full) {
      const bad = badPath(shellPath)
      if (bad !== null) return failed(`The shell path "${shellPath}" cannot be used: ${bad}`)
    }
    const normalized = full ? win32.normalize(shellPath) : ''
    if (normalized === '' || win32.basename(normalized).toLowerCase() !== 'cmd.exe') {
      return failed(`On Windows, shell mode supports cmd.exe only, given by its full path (such as ${systemCmdExe(undefined)}): ${shellPath === '' ? 'no shell is set' : shellPath}`)
    }
    const found = await programAt(normalized, shellPath, 'Shell')
    if (!found.ok) return failed(found.diagnostic)
    try {
      return checkedPlan({ file: found.path, args: [], cwd, env, commandLine: shellCommandLine(found.path, spec.script) })
    } catch (error) {
      if (error instanceof CommandLineError) return failed(error.message)
      throw error
    }
  }

  return {
    async resolve(spec: CommandSpec, env: Env): Promise<ResolveResult> {
      const folders = await resolveWorkingDirectory(spec, { realpath: limitedRealpath, stat: limitedStat, path: win32 })
      if (!folders.ok) return folders
      return spec.mode === 'shell' ? shell(spec, folders.cwd, env) : direct(spec, folders.cwd, env)
    },
  }
}
