import type { CommandConfig, Config, ProjectConfig } from '../../shared/config'

/** The configured command `commandId` with its project, or `null` if it does not exist. */
export function findCommand(config: Config, commandId: string): { project: ProjectConfig; command: CommandConfig } | null {
  for (const project of config.projects) {
    const command = project.commands.find((c) => c.id === commandId)
    if (command !== undefined) return { project, command }
  }
  return null
}
