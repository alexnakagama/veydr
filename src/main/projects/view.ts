import type { CommandView, EnvEntryView, ProjectView } from '../../shared/api'
import type { CommandConfig, Config, EnvEntry, ProjectConfig } from '../../shared/config'

/** Secret values never leave the main process in a view (design D2); they are sent as `null`. */
export function envEntryView(entry: EnvEntry): EnvEntryView {
  return entry.secret ? { key: entry.key, secret: true, value: null } : { key: entry.key, secret: false, value: entry.value }
}

export function commandView(command: CommandConfig): CommandView {
  return {
    id: command.id,
    name: command.name,
    execution: command.execution.mode === 'direct' ? { ...command.execution, args: [...command.execution.args] } : { ...command.execution },
    cwd: command.cwd,
    env: command.env.map(envEntryView),
    stopTimeoutMs: command.stopTimeoutMs,
  }
}

export function projectView(project: ProjectConfig): ProjectView {
  return { id: project.id, name: project.name, path: project.path, commands: project.commands.map(commandView) }
}

export function projectViews(config: Config): ProjectView[] {
  return config.projects.map(projectView)
}

/** Every configured command ID, in project and command order. */
export function commandIds(config: Config): string[] {
  return config.projects.flatMap((project) => project.commands.map((command) => command.id))
}
