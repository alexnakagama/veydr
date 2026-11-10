// Types for scripts/windows-probe/ports-standard-user.mjs.
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { Answer, DriverCatalog, RunDriverOptions } from './driver.mjs'

export const AREA: 'ports-standard-user'
export const EXIT_ID: 'ports-std-helper-exit'
export const OUTPUT_ID: 'ports-std-helper-output'
export const CATALOG: DriverCatalog
export const HELPER_PATH: string
export const MAX_OUTPUT_BYTES: number
export const HELPER_TIMEOUT_MS: number

export interface HelperRun {
  code: number | null
  signal: string | null
  stdout: Buffer
  stderr: string
  ms: number
  error?: string
  stopped?: 'timeout' | 'output'
}

export function runHelperPorts(
  helperPath?: string,
  options?: { timeoutMs?: number; maxOutputBytes?: number; spawnImpl?: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess },
): Promise<HelperRun>

export interface HelperAnswer {
  answer: Answer
  detail: string
  data: Record<string, unknown>
}

export function helperAnswers(run: HelperRun): { exit: HelperAnswer; output: HelperAnswer }

export function runPortsStandardUser(args: readonly string[], options?: Partial<RunDriverOptions> & { runHelper?: () => Promise<HelperRun> }): Promise<void>
