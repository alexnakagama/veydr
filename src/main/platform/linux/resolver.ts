import { isAbsolute } from 'node:path'
import { SpawnError } from '../errors'
import { resolveWorkingDirectory } from '../resolve-cwd'
import type { CommandResolver, CommandSpec, Env, ResolveResult } from '../types'
import { findExecutable } from './executable'

const failed = (...diagnostics: string[]): ResolveResult => ({ ok: false, diagnostics })

/**
 * Linux command resolution (design D6):
 *
 * - the project folder and the working directory are checked by `resolveWorkingDirectory`
 *   (`../resolve-cwd.ts`); the plan uses the resolved working directory;
 * - direct mode runs `file` with `args` unchanged and never through a shell; a `file` containing
 *   `/` is relative to the working directory, any other name is looked up on the effective `PATH`
 *   (`env.PATH`) here, so a missing executable is reported by name before anything is started;
 * - shell mode runs `<shell> -c <script>` with the configured absolute shell.
 */
export function createLinuxCommandResolver(): CommandResolver {
  return {
    async resolve(spec: CommandSpec, env: Env): Promise<ResolveResult> {
      const folders = await resolveWorkingDirectory(spec)
      if (!folders.ok) return folders
      const { cwd } = folders

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
