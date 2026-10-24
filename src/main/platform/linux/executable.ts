import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { constants } from 'node:fs'
import { access, open, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, resolve } from 'node:path'
import { SpawnError } from '../errors'
import type { Env } from '../types'

/** Search path when the environment has no `PATH` (glibc's default for `execvp`). */
export const DEFAULT_SEARCH_PATH = '/usr/bin:/bin'

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code

/** Whether `path` is a regular file this user may execute. */
async function executableAt(path: string): Promise<'ok' | 'missing' | 'not-executable'> {
  let info
  try {
    info = await stat(path)
  } catch (error) {
    const code = errnoOf(error)
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'not-executable'
  }
  if (!info.isFile()) return 'not-executable'
  try {
    await access(path, constants.X_OK)
    return 'ok'
  } catch {
    return 'not-executable'
  }
}

/**
 * For a script, checks the interpreter named on its `#!` line: if it is missing, `exec` would fail
 * only after the exec wrapper started, so the start would not be reported as failed (L5-03).
 */
async function checkInterpreter(path: string, file: string): Promise<void> {
  let head = ''
  try {
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(256)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      head = buffer.subarray(0, bytesRead).toString('latin1')
    } finally {
      await handle.close()
    }
  } catch {
    // Unreadable but executable (e.g. mode 0711): the kernel may still run it.
    return
  }
  if (!head.startsWith('#!')) return
  const interpreter = head.slice(2).split('\n')[0]?.trim().split(/[ \t]/)[0] ?? ''
  if (!isAbsolute(interpreter)) return
  const found = await executableAt(interpreter)
  if (found === 'missing') throw new SpawnError('executable-not-found', `Interpreter not found: ${interpreter} (named on the first line of ${file})`)
  if (found === 'not-executable') throw new SpawnError('not-executable', `Permission denied: the interpreter ${interpreter} of ${file} is not executable`)
}

/**
 * The absolute path `file` runs as, the way `execvp` finds it: a name containing `/` is taken
 * relative to `cwd`; any other name is searched in `env.PATH` (empty or relative entries relative
 * to `cwd`), taking the first executable regular file. Rejects with the `SpawnError` the user sees.
 */
export async function findExecutable(file: string, cwd: string, env: Env): Promise<string> {
  if (file.includes('/')) {
    const path = resolve(cwd, file)
    const found = await executableAt(path)
    if (found === 'missing') throw new SpawnError('executable-not-found', `Executable not found: ${file}`)
    if (found === 'not-executable') throw new SpawnError('not-executable', `Permission denied: ${file} is not executable`)
    await checkInterpreter(path, file)
    return path
  }
  let denied: string | null = null
  for (const entry of (env['PATH'] ?? DEFAULT_SEARCH_PATH).split(delimiter)) {
    const path = resolve(cwd, entry, file)
    const found = await executableAt(path)
    if (found === 'ok') {
      await checkInterpreter(path, file)
      return path
    }
    if (found === 'not-executable') denied ??= path
  }
  // Like `execvp`, a match that cannot be executed is reported only when nothing else is found.
  if (denied !== null) throw new SpawnError('not-executable', `Permission denied: ${denied} is not executable`)
  throw new SpawnError('executable-not-found', `Executable not found: ${file} (searched PATH)`)
}

/**
 * Closes every inherited descriptor above 2, then runs the remaining arguments. Electron's main
 * process holds descriptors without close-on-exec (Chromium IPC sockets and pipes, files in the
 * configuration directory), which `child_process.spawn` would otherwise pass on (L4 review, L4-02).
 * It needs no variables of its own: bash runs with an empty environment, so nothing of the
 * command's environment (`SHELLOPTS`, `BASHOPTS`, `GLOBIGNORE`, exported functions, …) changes
 * how this script behaves. Multi-digit descriptors rule out `dash`. Without `/proc` it closes
 * nothing, so it exits with status 125 instead of running the program.
 */
const CLOSE_AND_EXEC = '[ -d /proc/$$/fd ] || exit 125; for f in /proc/$$/fd/*; do n=${f##*/}; case $n in 0|1|2|*[!0-9]*) ;; *) eval "exec $n>&-" ;; esac; done; exec "$@"'

/** Locations tried for the programs the exec wrapper needs. */
const BASH_PATHS = ['/bin/bash', '/usr/bin/bash']
const ENV_PATHS = ['/usr/bin/env', '/bin/env']
const NICE_PATHS = ['/usr/bin/nice', '/bin/nice']

export interface ExecWrapper {
  readonly bash: string
  readonly env: string
  /** Runs a path `env` would take for an assignment (see `wrappedCommand`); `null` if not installed. */
  readonly nice: string | null
}

async function firstExecutable(paths: readonly string[]): Promise<string | null> {
  for (const path of paths) if ((await executableAt(path)) === 'ok') return path
  return null
}

/** The programs of the exec wrapper, or `null` if this system lacks bash or env. */
export async function findExecWrapper(): Promise<ExecWrapper | null> {
  const [bash, env, nice] = await Promise.all([firstExecutable(BASH_PATHS), firstExecutable(ENV_PATHS), firstExecutable(NICE_PATHS)])
  return bash === null || env === null ? null : { bash, env, nice }
}

/**
 * How to spawn `file` (absolute) with `args` and `env` so that the started program holds only the
 * descriptors Node sets up (0–2): bash closes the rest and execs `env -i`, which sets exactly
 * `env` (any variable name, unlike a shell) and execs `file`. The process keeps its PID (and start
 * time) through every exec. `env` treats an operand containing `=` as an assignment, so a `file`
 * containing `=` is run through `nice -n 0 --`, which execs it without changing the environment.
 */
export function wrappedCommand(wrapper: ExecWrapper, file: string, args: readonly string[], env: Env): { file: string; args: string[] } {
  if (!isAbsolute(file)) throw new Error(`Not an absolute path: ${file}`)
  const assignments = Object.entries(env).map(([key, value]) => `${key}=${value}`)
  if (file.includes('=') && wrapper.nice === null) throw new SpawnError('other', `Cannot start ${file}: a path containing "=" needs nice, which is not installed`)
  const target = file.includes('=') && wrapper.nice !== null ? [wrapper.nice, '-n', '0', '--', file] : [file]
  return { file: wrapper.bash, args: ['-c', CLOSE_AND_EXEC, 'veydr-exec', wrapper.env, '-i', '--', ...assignments, ...target, ...args] }
}

export const WRAPPER_UNAVAILABLE =
  'Veydr cannot start programs safely: bash or env is not installed (needed to close the files and connections Veydr holds open)'

export type SpawnChild = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export const spawnChildDirectly: SpawnChild = (file, args, options) => nodeSpawn(file, args, options)

export interface CleanSpawner {
  /**
   * Spawns `file` (absolute) like `child_process.spawn` with `options.env` as its environment,
   * closing inherited descriptors above 2. Without the exec wrapper (bash or env missing) nothing
   * is started: it rejects with `SpawnError` (fail closed, L5-02), and `onUnavailable` was told once.
   */
  spawn(file: string, args: readonly string[], options: SpawnOptions & { readonly env: Env }): Promise<ChildProcess>
}

export function createCleanSpawner(
  spawnChild: SpawnChild = spawnChildDirectly,
  onUnavailable: () => void = () => undefined,
  find: () => Promise<ExecWrapper | null> = findExecWrapper,
): CleanSpawner {
  let wrapper: Promise<ExecWrapper | null> | null = null
  return {
    async spawn(file, args, options) {
      wrapper ??= find().then((found) => {
        if (found === null) onUnavailable()
        return found
      })
      const found = await wrapper
      if (found === null) throw new SpawnError('other', WRAPPER_UNAVAILABLE)
      const wrapped = wrappedCommand(found, file, args, options.env)
      return spawnChild(wrapped.file, wrapped.args, { ...options, env: {} })
    },
  }
}
