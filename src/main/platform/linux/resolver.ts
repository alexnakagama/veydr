import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { SpawnError } from '../errors'
import type { CommandResolver, CommandSpec, Env, ResolveResult } from '../types'
import { findExecutable } from './executable'

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code

/** Whether `path` is `root` or lies below it (both absolute and normalized). */
export function isInside(root: string, path: string): boolean {
  const inside = relative(root, path)
  return inside === '' || !(inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
}

const failed = (...diagnostics: string[]): ResolveResult => ({ ok: false, diagnostics })

/**
 * Linux command resolution (design D6):
 *
 * - the project folder must exist and be a directory;
 * - the working directory (`cwd` relative to the project folder) must stay inside the project
 *   folder both lexically and after resolving symbolic links; the plan uses the resolved path;
 * - direct mode runs `file` with `args` unchanged and never through a shell; a `file` containing
 *   `/` is relative to the working directory, any other name is looked up on the effective `PATH`
 *   (`env.PATH`) here, so a missing executable is reported by name before anything is started;
 * - shell mode runs `<shell> -c <script>` with the configured absolute shell.
 */
export function createLinuxCommandResolver(): CommandResolver {
  return {
    async resolve(spec: CommandSpec, env: Env): Promise<ResolveResult> {
      let root: string
      try {
        root = await realpath(spec.projectRoot)
        if (!(await stat(root)).isDirectory()) return failed(`The project folder is not a directory: ${spec.projectRoot}`)
      } catch (error) {
        const code = errnoOf(error)
        if (code === 'ENOENT' || code === 'ENOTDIR') return failed(`The project folder is missing: ${spec.projectRoot}`)
        return failed(`The project folder cannot be read: ${spec.projectRoot} (${code ?? String(error)})`)
      }

      const lexical = resolve(root, spec.cwd)
      if (!isInside(root, lexical)) return failed(`The working directory "${spec.cwd}" is outside the project folder ${root}`)
      let cwd: string
      try {
        cwd = await realpath(lexical)
      } catch (error) {
        const code = errnoOf(error)
        if (code === 'ENOENT' || code === 'ENOTDIR') return failed(`Working directory does not exist: ${lexical}`)
        return failed(`Working directory cannot be read: ${lexical} (${code ?? String(error)})`)
      }
      if (!isInside(root, cwd)) return failed(`The working directory "${spec.cwd}" is outside the project folder ${root} (it resolves to ${cwd})`)

      const [file, args] = spec.mode === 'shell' ? [spec.shellPath ?? '', ['-c', spec.script]] : [spec.file, [...spec.args]]
      if (spec.mode === 'shell' && !isAbsolute(file)) return failed(`The shell must be an absolute path: ${file}`)
      try {
        return { ok: true, plan: { file: await findExecutable(file, cwd, env), args, cwd, env } }
      } catch (error) {
        if (error instanceof SpawnError) return failed(error.message)
        throw error
      }
    },
  }
}
