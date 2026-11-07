import { realpath as nodeRealpath, stat as nodeStat } from 'node:fs/promises'
import nodePath from 'node:path'

// The project-folder and working-directory checks every command resolver makes before it plans a
// command (foundation design D6, add-windows-environment-and-commands design D2). They moved here
// from `linux/resolver.ts`, so that the Linux and Windows resolvers share them; they are unchanged
// apart from the injectable filesystem calls and path flavor (`isInside` takes the flavor too).

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code

/** The path functions the checks use: `node:path` of the running system, or a flavor for tests. */
export type PathFlavor = Pick<typeof nodePath, 'isAbsolute' | 'relative' | 'resolve' | 'sep'>

export interface ResolveCwdOptions {
  /**
   * Resolves symbolic links (and on Windows junctions and 8.3 short names) of an absolute path;
   * rejects with an errno error (`ENOENT`, `ENOTDIR`, …). Linux uses `realpath`, Windows
   * `realpath.native`.
   */
  readonly realpath?: (path: string) => Promise<string>
  readonly stat?: (path: string) => Promise<{ isDirectory(): boolean }>
  readonly path?: PathFlavor
}

/** Whether `path` is `root` or lies below it (both absolute and normalized). */
export function isInside(root: string, path: string, flavor: PathFlavor = nodePath): boolean {
  const inside = flavor.relative(root, path)
  return inside === '' || !(inside === '..' || inside.startsWith(`..${flavor.sep}`) || flavor.isAbsolute(inside))
}

export type CwdResult =
  | { readonly ok: true; /** The resolved project folder. */ readonly root: string; /** The resolved working directory. */ readonly cwd: string }
  | { readonly ok: false; readonly diagnostics: readonly string[] }

const failed = (...diagnostics: string[]): CwdResult => ({ ok: false, diagnostics })

/**
 * The resolved working directory of a command:
 *
 * - the project folder must exist and be a directory;
 * - the working directory (`cwd` relative to the project folder) must stay inside the project
 *   folder both lexically and after resolving symbolic links; the result is the resolved path.
 */
export async function resolveWorkingDirectory(spec: { readonly projectRoot: string; readonly cwd: string }, options: ResolveCwdOptions = {}): Promise<CwdResult> {
  const realpath = options.realpath ?? nodeRealpath
  const stat = options.stat ?? nodeStat
  const path = options.path ?? nodePath

  let root: string
  try {
    root = await realpath(spec.projectRoot)
    if (!(await stat(root)).isDirectory()) return failed(`The project folder is not a directory: ${spec.projectRoot}`)
  } catch (error) {
    const code = errnoOf(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return failed(`The project folder is missing: ${spec.projectRoot}`)
    return failed(`The project folder cannot be read: ${spec.projectRoot} (${code ?? String(error)})`)
  }

  const lexical = path.resolve(root, spec.cwd)
  if (!isInside(root, lexical, path)) return failed(`The working directory "${spec.cwd}" is outside the project folder ${root}`)
  let cwd: string
  try {
    cwd = await realpath(lexical)
  } catch (error) {
    const code = errnoOf(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return failed(`Working directory does not exist: ${lexical}`)
    return failed(`Working directory cannot be read: ${lexical} (${code ?? String(error)})`)
  }
  if (!isInside(root, cwd, path)) return failed(`The working directory "${spec.cwd}" is outside the project folder ${root} (it resolves to ${cwd})`)
  return { ok: true, root, cwd }
}
