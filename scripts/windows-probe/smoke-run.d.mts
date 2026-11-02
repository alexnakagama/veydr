// Types for scripts/windows-probe/smoke-run.mjs.
import type { Answer, ProgramResult, Report } from './driver.mjs'

export interface SmokeReport {
  result: 'pass' | 'fail'
  packaged: boolean
  appPath?: string
  checks: { name: string; ok: boolean; detail: string }[]
}

export interface SmokeRun {
  run: ProgramResult
  report?: SmokeReport
  problem?: string
  reportVia: 'pipe' | 'file' | null
  fileRun?: ProgramResult
}

export interface ProbeAnswer {
  answer: Answer
  detail: string
  data?: Record<string, unknown>
}

export const SMOKE_REPORT_PREFIX: string
export const SMOKE_RUN_MS: number

export function expectedExitCode(report: SmokeReport): number
export function outputTail(text: string): string
export function appEnv(env?: Readonly<Record<string, string | undefined>>): Record<string, string>
export function parseSmokeReport(stdout: string): { report: SmokeReport } | { problem: string }
export function runSmoke(file: string, args: readonly string[], options: { dir: string; env?: Record<string, string>; timeoutMs?: number }): Promise<SmokeRun>
export function smokeData(smoke: SmokeRun): Record<string, unknown>
export function launchAnswer(smoke: SmokeRun): ProbeAnswer
export function smokeAnswers(input: { prefix: string; ids: readonly string[]; smoke: SmokeRun; packaged: boolean }): { answers: Record<string, ProbeAnswer>; unknown: string[] }
export function smokeIds(ids: readonly string[], prefix: string): string[]
export function reportAnswers(report: Report, ids: readonly string[], result: { answers: Readonly<Record<string, ProbeAnswer>>; unknown?: readonly string[] }): void
