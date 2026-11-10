// Types for scripts/windows-probe/driver.mjs.
import type { ChildProcess } from 'node:child_process'
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

export function noConsoleAnswer(measurement: ContextMeasurement, driverPid: number): { answer: Answer; detail: string; data?: Record<string, unknown> }

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

export function system32(file: string): string

export interface ProgramResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  error?: string
}

export function runProgram(file: string, args: readonly string[], options?: { timeoutMs?: number; graceMs?: number; [option: string]: unknown }): Promise<ProgramResult>

export function stopProgram(child: ChildProcess): void

export function noAnswer(run: ProgramResult, timeoutMs: number): { answer: null; detail: string } | undefined

export function isEntryPoint(moduleUrl: string): boolean

export function driverMain(name: string, run: (args: string[]) => Promise<void>): void

export type Report = (id: string, answer: Answer, detail?: string, data?: Record<string, unknown>) => void

export function reportCheck(report: Report, id: string, check: () => Promise<{ answer: Answer; detail: string; data?: Record<string, unknown> }>): Promise<void>

/** A check as runDriver reads it: checks.mjs's entries are such checks, and so are a non-probe driver's own. */
export interface DriverCheck {
  readonly kind: 'check' | 'limit'
  readonly id: string
  readonly area: string
  readonly context?: { readonly user: 'admin' | 'standard' | 'both' }
}

/** The areas and checks a driver's `area` and `ids` are looked up in. */
export interface DriverCatalog {
  readonly areas: readonly string[]
  readonly checks: readonly DriverCheck[]
}

export interface RunDriverOptions {
  area: string
  user: User
  /** The area's checks this driver answers as `user`, other than the context checks. */
  ids: readonly string[]
  probe: (report: Report) => void | Promise<void>
  unavailable?: string
  /** Where `area` and `ids` are looked up; checks.mjs's probe areas and checks by default. */
  catalog?: DriverCatalog
  measure?: (driverPid: number) => Promise<ContextMeasurement>
  probeDirectory?: () => ProbeDirectory
  write?: (line: string) => void
}

export function runDriver(options: RunDriverOptions): Promise<void>
