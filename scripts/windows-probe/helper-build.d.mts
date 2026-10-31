// Types for scripts/windows-probe/helper-build.mjs.
import type { Answer, ProgramResult, RunDriverOptions } from './driver.mjs'

export function compilerPath(windir?: string): string
export function compilerVersion(output: string): string | null
export function helperReport(stdout: string): { inJob?: boolean; childExitCode?: number; activeProcesses?: number } | undefined
export function buildAnswer(input: {
  compile: ProgramResult
  run: ProgramResult
  report?: { inJob?: boolean }
  tree?: Record<string, number>
  alive: readonly string[]
}): { answer: Answer; detail: string }
export function compileHelper(name: string, dir: string): Promise<{ compiler: string; binary: string; result: ProgramResult }>
export function describeExit(run: ProgramResult): string
export function runHelperBuild(args: readonly string[], options?: Partial<RunDriverOptions>): Promise<void>
