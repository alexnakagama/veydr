// Types for scripts/windows-probe/driver.mjs.
import type { CatalogEntry } from './checks.mjs'

export type User = 'admin' | 'standard'
export type Answer = 'yes' | 'no' | null

export const USERS: readonly User[]

export class DriverUsageError extends Error {}

export function parseDriverArgs(args: readonly string[]): { user: User; unavailable: string | undefined; positional: string[] }

export function contextIds(user: User, checks?: readonly CatalogEntry[]): string[]

export function jobLimitNames(flags: number): string[]

/** A section context.ps1 could not measure is `{ error }`. */
type Section<T> = T | { readonly error: string }

/** context.ps1's output, with `helper` added by measureContext, or `{ error }` if it could not be obtained. */
export type ContextMeasurement =
  | {
      readonly targetPid: number
      readonly parentPid: number
      readonly console: Section<{ readonly attached: boolean; readonly lastError: number; readonly window: number }>
      readonly job: Section<{ readonly driverInJob: boolean; readonly helperInJob: boolean; readonly limitFlags: number | null; readonly limitsError: string | null }>
      readonly token: Section<{ readonly user: string; readonly elevated: boolean; readonly elevationType: string; readonly administrators: string }>
      readonly hkcu: Section<{ readonly environment: 'present' | 'absent'; readonly environmentValues: number }>
      readonly helper?: 'detached' | 'attached'
      readonly detachedError?: string
    }
  | { readonly error: string }

export type ProbeDirectory = { readonly usable: true } | { readonly usable: false; readonly error: string }

export interface ContextAnswer {
  id: string
  answer: Answer
  detail: string
  data: Record<string, unknown>
}

export function contextAnswers(input: { user: User; measurement: ContextMeasurement; driverPid: number; probeDir?: ProbeDirectory }): ContextAnswer[]

export function contextResult(run: {
  code: number | null
  signal: string | null
  /** The result file's content, or undefined if context.ps1 wrote none. */
  fileText: string | undefined
  stdout?: string
  stderr?: string
}): ContextMeasurement

export function measureContext(driverPid?: number): Promise<ContextMeasurement>

export function checkProbeDirectory(dir?: string): ProbeDirectory

export function windowsPowerShell(): string

export interface ProgramResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  error?: string
}

export function runProgram(file: string, args: readonly string[], options?: { timeoutMs?: number; [option: string]: unknown }): Promise<ProgramResult>

export function isEntryPoint(moduleUrl: string): boolean

export function driverMain(name: string, run: (args: string[]) => Promise<void>): void

export type Report = (id: string, answer: Answer, detail?: string, data?: Record<string, unknown>) => void

export interface RunDriverOptions {
  area: string
  user: User
  /** The area's checks this driver answers as `user`, other than the context checks. */
  ids: readonly string[]
  probe: (report: Report) => void | Promise<void>
  unavailable?: string
  measure?: (driverPid: number) => Promise<ContextMeasurement>
  probeDirectory?: () => ProbeDirectory
  write?: (line: string) => void
}

export function runDriver(options: RunDriverOptions): Promise<void>
