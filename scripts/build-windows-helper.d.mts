// Types for scripts/build-windows-helper.mjs, so TypeScript tests can import it.

export const SOURCE_PATH: string
export const OUTPUT_DIR: string
export const HELPER_PATH: string
export const HASH_PATH: string
export const NOT_WINDOWS_MESSAGE: string

export class BuildError extends Error {}

export interface CompilerResult {
  status: number | null
  output: string
  error?: Error | undefined
}

export interface BuildOptions {
  platform?: string
  compiler?: string
  source?: string
  binary?: string
  hashFile?: string
  partial?: string
  run?: (compiler: string, args: readonly string[]) => CompilerResult
}

export function compilerPath(windir?: string): string
export function compilerArguments(source: string, output: string): string[]
export function sourceHash(source?: string): string
export function isUpToDate(input: { binary?: string; hashFile?: string; hash: string }): boolean
export function buildHelper(options?: BuildOptions): 'built' | 'up-to-date'
export function runBuildCli(
  args: readonly string[],
  options?: BuildOptions,
  output?: { stdout?: (line: string) => void; stderr?: (line: string) => void },
): number
