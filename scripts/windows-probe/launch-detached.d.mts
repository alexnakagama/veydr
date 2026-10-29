// Types for scripts/windows-probe/launch-detached.mjs.

export class LaunchUsageError extends Error {}

export interface LaunchOptions {
  driver: string
  driverArgs: string[]
  out: string
  log: string | undefined
  timeoutMs: number
  /** Started on the launcher's console instead of detached: the negative control (design D9). */
  attached: boolean
}

export function parseLaunchArgs(args: readonly string[], env?: Readonly<Record<string, string | undefined>>): LaunchOptions

export function isResultLine(text: string): boolean

export function launch(options: {
  driver: string
  driverArgs?: readonly string[]
  out: string
  timeoutMs: number
  attached?: boolean
  log?: (text: string) => void
  drainMs?: number
}): Promise<{ ok: boolean; lines: number; problems: string[] }>
