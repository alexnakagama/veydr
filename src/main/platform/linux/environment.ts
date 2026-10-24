import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { userInfo } from 'node:os'
import { isAbsolute } from 'node:path'
import { withoutRuntimeVariables } from '../runtime-env'
import type { Env, EnvProvider, PlatformLog } from '../types'
import { createCleanSpawner, type CleanSpawner } from './executable'

/** How long the login shell may take (design D6). */
export const LOGIN_SHELL_TIMEOUT_MS = 5_000
/** Output kept from the login shell; an environment is far smaller. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/**
 * Variables a login shell sets for itself that describe the shell, not the user's environment:
 * its working directory (Veydr's, not the command's), its last command, and its nesting level
 * (incremented by the login shell itself).
 */
const SHELL_STATE_VARIABLES = new Set(['PWD', 'OLDPWD', '_', 'SHLVL'])

export interface LinuxEnvProviderOptions {
  /** Veydr's own environment (`process.env`). */
  readonly inherited: Readonly<Record<string, string | undefined>>
  /** The user's login shell; defaults to `$SHELL`, then the account's shell, then `/bin/sh`. */
  readonly shell?: string
  readonly timeoutMs?: number
  readonly spawner?: CleanSpawner
  readonly log?: PlatformLog
}

/** The user's login shell: `$SHELL` if absolute, else the account's shell, else `/bin/sh`. */
export function loginShell(inherited: Readonly<Record<string, string | undefined>>): string {
  const fromEnv = inherited['SHELL']
  if (fromEnv !== undefined && isAbsolute(fromEnv)) return fromEnv
  try {
    const { shell } = userInfo()
    if (shell !== null && isAbsolute(shell)) return shell
  } catch {
    // No passwd entry (e.g. some containers).
  }
  return '/bin/sh'
}

/**
 * Parses `env -0` output found between `start` and `end` markers; anything outside them (rc-file
 * noise, banners) is ignored. `null` if the markers are missing.
 */
export function parseMarkedEnvironment(output: string, start: string, end: string): Record<string, string> | null {
  const from = output.indexOf(start)
  if (from === -1) return null
  const to = output.indexOf(end, from + start.length)
  if (to === -1) return null
  const env: Record<string, string> = {}
  for (const entry of output.slice(from + start.length, to).split('\0')) {
    const eq = entry.indexOf('=')
    // An entry without `=` or with an empty name cannot be passed on.
    if (eq <= 0) continue
    env[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return env
}

/**
 * Linux login environment (design D6): `$SHELL -l -i -c` prints `env -0` between unique markers,
 * with standard input not connected and a 5 s timeout. It starts from Veydr's environment without
 * its runtime variables; if it fails, that environment is the result, with a warning.
 */
export function createLinuxEnvProvider(options: LinuxEnvProviderOptions): EnvProvider {
  const timeoutMs = options.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS
  const spawner = options.spawner ?? createCleanSpawner()

  return {
    async base() {
      const inherited = withoutRuntimeVariables(options.inherited)
      const shell = options.shell ?? loginShell(options.inherited)
      try {
        const login = await readLoginEnvironment(spawner, shell, inherited, timeoutMs)
        for (const key of SHELL_STATE_VARIABLES) delete login[key]
        // Output is decoded as UTF-8; other bytes became U+FFFD, so those values are not what the shell had.
        const damaged = Object.keys(login).filter((key) => key.includes('\uFFFD') || (login[key] ?? '').includes('\uFFFD'))
        const warnings = damaged.length === 0 ? [] : [`Some variables of your login environment are not valid UTF-8 and were changed: ${damaged.join(', ')}.`]
        return { env: login, warnings }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        options.log?.record('warn', 'environment.login-shell-failed', { shell, reason })
        return {
          env: inherited,
          warnings: [`Your login shell environment could not be read (${shell}: ${reason}). Commands get Veydr's own environment instead, which may lack PATH entries from your shell configuration.`],
        }
      }
    },
  }
}

async function readLoginEnvironment(spawner: CleanSpawner, shell: string, env: Env, timeoutMs: number): Promise<Record<string, string>> {
  const id = randomBytes(16).toString('hex')
  const start = `__VEYDR_ENV_START_${id}__`
  const end = `__VEYDR_ENV_END_${id}__`
  // The markers are assembled by printf, so an echo of the command line (e.g. `set -x`) cannot fake them.
  const script = `printf '%s%s' __VEYDR_ENV_START_ ${id}__; env -0; printf '%s%s' __VEYDR_ENV_END_ ${id}__`
  // Its own session, so a timeout ends everything the shell configuration started.
  const child = await spawner.spawn(shell, ['-l', '-i', '-c', script], { env, stdio: ['ignore', 'pipe', 'ignore'], detached: true, shell: false })
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let exited = false
    let exitDescription = 'ended'
    let settled = false
    const parse = (): Record<string, string> | null => parseMarkedEnvironment(Buffer.concat(chunks).toString('utf8'), start, end)
    const finish = (outcome: { env: Record<string, string> } | { error: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout?.destroy()
      if ('env' in outcome) resolvePromise(outcome.env)
      else reject(new Error(outcome.error))
    }
    // Done once the shell has exited and its output is complete. A program the shell configuration
    // started in the background may keep the output pipe open, so the end marker counts as complete.
    const settleIfDone = (): void => {
      if (!exited) return
      const parsed = parse()
      if (parsed !== null) finish({ env: parsed })
    }
    const timer = setTimeout(() => {
      // Only a shell still running is ended (with its session); what it started and left running stays.
      if (!exited) killGroup(child)
      const parsed = parse()
      finish(parsed !== null ? { env: parsed } : { error: `no result within ${timeoutMs / 1000} s` })
    }, timeoutMs)
    child.on('error', (error) => finish({ error: error.message }))
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_OUTPUT_BYTES) {
        killGroup(child)
        return finish({ error: 'too much output' })
      }
      chunks.push(chunk)
      settleIfDone()
    })
    child.on('exit', (code, signal) => {
      exited = true
      exitDescription = signal !== null ? `ended by ${signal}` : `exited with status ${code ?? '?'}`
      settleIfDone()
    })
    child.on('close', () => {
      const parsed = parse()
      finish(parsed !== null ? { env: parsed } : { error: `${exitDescription} without printing the environment` })
    })
  })
}

/** Ends the login shell and anything it started in its session (it may still be running). */
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}
