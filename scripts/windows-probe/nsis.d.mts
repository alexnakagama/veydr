// Types for scripts/windows-probe/nsis.mjs.
import type { ProgramResult, RunDriverOptions } from './driver.mjs'
import type { ProbeAnswer, SmokeRun } from './smoke-run.mjs'

export interface NsisBuild {
  run: ProgramResult
  installer?: string
  installerSize?: number | undefined
  configChanged: boolean
}

export interface Programs {
  app: string | undefined
  uninstaller: string | undefined
}

export interface NsisInstall {
  reason?: string
  install?: ProgramResult
  directory?: string | undefined
  /** What Programs holds when the install directory is not there. */
  found?: string[]
  programs?: Programs
  smoke?: SmokeRun | undefined
  uninstall?: ProgramResult
  left?: boolean
}

export const BUILD_MS: number
export const INSTALL_MS: number
export const UNINSTALL_MS: number

export const INSTALL_DIRECTORY: string

export function builderEnv(env?: Readonly<Record<string, string | undefined>>): Record<string, string>
export function builderArgs(outputDir: string): string[]
export function nsisBuildAnswer(build: NsisBuild, timeoutMs?: number): ProbeAnswer
export function installedPrograms(names: readonly string[]): Programs
export function installAnswer(steps: NsisInstall & { install: ProgramResult }): ProbeAnswer
export function nsisAnswers(input: { ids: readonly string[]; build: NsisBuild; installed: NsisInstall }): { answers: Record<string, ProbeAnswer>; unknown: string[] }
export function runNsis(args: readonly string[], options?: Partial<RunDriverOptions> & { measureArea?: () => Promise<{ build: NsisBuild; installed: NsisInstall }> }): Promise<void>
