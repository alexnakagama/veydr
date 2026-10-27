import type { EnvNameRule } from '../../shared/config'
import type { CommandResolver, CommandSpec } from '../platform/types'
import { effectiveEnvironment, type EnvironmentService } from '../projects/environment'
import type { LaunchTarget, PlanResult } from './supervisor'

export interface PlannerDeps {
  readonly resolver: CommandResolver
  readonly environment: Pick<EnvironmentService, 'base'>
  /** How the platform compares environment variable names (`PlatformConventions.envNames`). */
  readonly envNames: EnvNameRule
}

/** The resolver's view of a configured command. */
export function commandSpec({ project, command }: LaunchTarget): CommandSpec {
  const { execution } = command
  return execution.mode === 'shell'
    ? { mode: 'shell', file: '', args: [], script: execution.script, shellPath: execution.shell, projectRoot: project.path, cwd: command.cwd }
    : { mode: 'direct', file: execution.file, args: execution.args, script: '', shellPath: null, projectRoot: project.path, cwd: command.cwd }
}

/**
 * Plans a start (design D6): the session's base environment with the command's overrides applied
 * last, resolved by the platform `CommandResolver`, which checks that the project folder exists
 * (spec: directory missing), keeps the working directory inside it, and finds the executable.
 */
export function createPlanner({ resolver, environment, envNames }: PlannerDeps): (target: LaunchTarget) => Promise<PlanResult> {
  return async (target) => {
    const { env } = await environment.base()
    const resolved = await resolver.resolve(commandSpec(target), effectiveEnvironment(env, target.command.env, envNames))
    return resolved.ok ? { ok: true, plan: resolved.plan } : { ok: false, reason: resolved.diagnostics.join(' ') }
  }
}
