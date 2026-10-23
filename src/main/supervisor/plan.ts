import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Env } from '../platform/types'
import type { LaunchTarget, PlanResult } from './supervisor'

/**
 * Variables of Veydr's own runtime that must not reach a command (design D6 denylist; the L5
 * environment provider extends it with what tests show Electron and AppImage inject).
 */
const RUNTIME_VARIABLES = new Set(['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'CHROME_DESKTOP'])

export function isRuntimeVariable(key: string): boolean {
  return key.startsWith('ELECTRON_') || RUNTIME_VARIABLES.has(key)
}

/**
 * Interim spawn planner for L3 (decision 2026-10-23), replaced in L5 by the platform
 * `CommandResolver` (PATH lookup with diagnostics, realpath containment) and `EnvProvider`
 * (login-shell environment):
 *
 * - direct mode: `file` and `args` unchanged, never through a shell; a `file` containing `/` is
 *   resolved against the working directory, a bare name is looked up on `PATH` by the OS;
 * - shell mode: `<shell> -c <script>`;
 * - working directory: the command's `cwd` resolved against the project root, rejected if it
 *   leaves the root lexically (symlinks are not resolved yet);
 * - environment: `baseEnv` without Veydr's runtime variables, then the command's overrides.
 */
export function createInterimPlanner(baseEnv: Readonly<Record<string, string | undefined>>): (target: LaunchTarget) => Promise<PlanResult> {
  const inherited: Record<string, string> = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined && !isRuntimeVariable(key)) inherited[key] = value
  }

  return (target) => Promise.resolve(planCommand(target, inherited))
}

export function planCommand({ project, command }: LaunchTarget, baseEnv: Env): PlanResult {
  const root = resolve(project.path)
  const cwd = resolve(root, command.cwd)
  const inside = relative(root, cwd)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return { ok: false, reason: `The working directory "${command.cwd}" is outside the project folder ${root}` }
  }

  const env: Record<string, string> = { ...baseEnv }
  for (const entry of command.env) env[entry.key] = entry.value

  const { execution } = command
  if (execution.mode === 'shell') {
    return { ok: true, plan: { file: execution.shell, args: ['-c', execution.script], cwd, env } }
  }
  const file = execution.file.includes('/') ? resolve(cwd, execution.file) : execution.file
  return { ok: true, plan: { file, args: [...execution.args], cwd, env } }
}
