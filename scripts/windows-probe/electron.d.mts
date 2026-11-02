// Types for scripts/windows-probe/electron.mjs.
import type { ContextMeasurement, ProgramResult, RunDriverOptions } from './driver.mjs'
import type { ProbeAnswer, SmokeRun } from './smoke-run.mjs'

export interface ElectronMeasurements {
  smoke: SmokeRun
  playwright: ProgramResult
  mainConsole: { pid: number | undefined; measurement: ContextMeasurement }
}

export const KOFFI_NOT_APPROVED: string

export function playwrightAnswer(run: ProgramResult, timeoutMs?: number): ProbeAnswer
export function consoleAnswer(input: ElectronMeasurements['mainConsole']): ProbeAnswer
export function electronAnswers(input: ElectronMeasurements & { ids: readonly string[] }): { answers: Record<string, ProbeAnswer>; unknown: string[] }
export function runElectron(args: readonly string[], options?: Partial<RunDriverOptions> & { measureArea?: () => Promise<ElectronMeasurements> }): Promise<void>
