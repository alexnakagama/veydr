// Types for scripts/windows-probe/installer-standard-user.mjs.
import type { DriverCatalog, ProgramResult, Report, RunDriverOptions } from './driver.mjs'
import type { AclReport, AclViolation } from './install-acl.mjs'
import type { HelperRun } from './ports-standard-user.mjs'
import type { ProbeAnswer, SmokeRun } from './smoke-run.mjs'

export const AREA: 'installer-standard-user'
export const INSTALLER_ID: 'install-std-installer'
export const INSTALL_ID: 'install-std-install'
export const PERMISSIONS_ID: 'install-std-permissions'
export const HELPER_ID: 'install-std-helper'
export const SMOKE_ID: 'install-std-smoke'
export const UNINSTALL_ID: 'install-std-uninstall'
export const STEP_IDS: readonly string[]
export const CATALOG: DriverCatalog
export const SMOKE_CASES: readonly ['passed', 'not-testable', 'failed']
export type SmokeCase = (typeof SMOKE_CASES)[number]
export const PROTOCOL_VERSION: number
export const INSTALLER_NAME: RegExp
export const INSTALL_DIRECTORY: string
export const APP_NAME: string
export const UNINSTALLER_NAME: string
export const RESOURCES: readonly string[]
export const INSTALL_MS: number
export const UNINSTALL_GONE_MS: number
export const NO_PROCESS_WATCH_MS: number
export const CONTROL_WINDOW_MS: number
export const SMOKE_CHECKS: readonly string[]

export interface ParsedInstallerArgs {
  installerName: string
  sha256: string
  electron: string
  unavailable: string | undefined
}

export function parseInstallerArgs(args: readonly string[]): ParsedInstallerArgs

/** A program run with how long it took. */
export type TimedRun = ProgramResult & { ms?: number }

export interface UninstallEntry {
  key: string
  displayName: string
  uninstallString: string
  installLocation: string
}

export interface VeydrProcess {
  pid: number
  path: string | null
}

/** What an install left: its directory's programs and resources, and what is outside it. */
export interface InstallState {
  directory: boolean
  programs: string[]
  resources: string[]
  startMenu: { path: string; target: string } | null
  uninstall: UninstallEntry[]
  processes: VeydrProcess[]
}

export interface HelperOutcome {
  version: ProgramResult
  ports: HelperRun
  listener: { port: number; pid: number }
}

export interface ControlRun {
  version: ProgramResult
  window: ProgramResult
  /** stock-window.cjs wrote that its window's page loaded. */
  loaded: boolean
}

export type ControlOutcome = 'opened' | 'failed' | 'not-started'

export function installerAnswer(input: { installerName: string; expected: string; actual: string }): ProbeAnswer
export function veydrEntries(entries: readonly UninstallEntry[], installDir: string): UninstallEntry[]
export function installedProcesses(processes: readonly VeydrProcess[], installDir: string): VeydrProcess[]
export function installAnswer(input: { run: TimedRun; installDir: string; profile: string; state: InstallState; processes: readonly VeydrProcess[] }): ProbeAnswer
export function permissionsAnswer(input: { report: AclReport; installDir: string; required: readonly string[] }): ProbeAnswer & { data?: { violations?: AclViolation[] } }
export function helperAnswer(outcome: HelperOutcome): ProbeAnswer
export function smokeProblem(smoke: SmokeRun, installDir: string): string | undefined
export function controlOutcome(control: ControlRun): ControlOutcome
export function smokeAnswer(input: { smoke: SmokeRun; control: ControlRun | undefined; installDir: string }): ProbeAnswer
export function uninstallRemaining(state: InstallState, installDir: string): string[]
export function waitUntilUninstalled(installDir: string, deps: { inspect: (installDir: string) => Promise<InstallState>; pause: (ms: number) => Promise<void>; now: () => number }): Promise<InstallState>
export function uninstallAnswer(input: { run: TimedRun; state: InstallState; installDir: string }): ProbeAnswer

export function requireEveryPath(paths: readonly string[], entries: readonly { readonly path: string }[]): void
export function powershellJson(script: string, env?: Readonly<Record<string, string>>): Promise<unknown>

/** The steps installAsStandardUser runs; the unit tests replace them. */
export interface InstallerSteps {
  environment: () => { localAppData: string | undefined; profile: string | undefined }
  installerFile: (name: string) => string
  hash: (file: string) => Promise<string>
  exists: (path: string) => boolean
  install: (installer: string) => Promise<TimedRun>
  inspect: (installDir: string) => Promise<InstallState>
  watchProcesses: (installDir: string) => Promise<VeydrProcess[]>
  permissions: (installDir: string) => Promise<AclReport>
  helper: (helper: string) => Promise<HelperOutcome>
  smoke: (app: string, dir: string) => Promise<SmokeRun>
  control: (electron: string, dir: string) => Promise<ControlRun>
  uninstall: (uninstaller: string) => Promise<TimedRun>
  /** Waits between inspections of the uninstall; the unit tests advance their own clock instead. */
  pause: (ms: number) => Promise<void>
  now: () => number
  tempDir: () => string
  removeDir: (dir: string) => void
}

export const WINDOWS_STEPS: Readonly<InstallerSteps>

export function installAsStandardUser(report: Report, parsed: Pick<ParsedInstallerArgs, 'installerName' | 'sha256' | 'electron'>, steps?: InstallerSteps): Promise<void>

export function runInstallerStandardUser(args: readonly string[], options?: Partial<RunDriverOptions> & { steps?: InstallerSteps }): Promise<void>
