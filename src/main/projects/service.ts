import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { CommandInput, CommandView, ProjectView } from '../../shared/api'
import { projectPathKey, type CommandConfig, type Config, type EnvEntry, type ProjectConfig, type Settings } from '../../shared/config'
import { ConfigReadOnlyError, ConfigValidationError, type ConfigStore } from '../config'
import { NotFoundError, UserError } from '../errors'
import { findCommand } from './lookup'
import { commandView, projectView } from './view'

export interface ProjectServiceDeps {
  readonly store: Pick<ConfigStore, 'current' | 'update'>
  /** IDs of commands whose processes may be alive (`Supervisor.active`). */
  readonly activeCommands: () => ReadonlySet<string>
  readonly newId?: () => string
}

/** Project and command configuration (spec: project-registry). Never touches files in a project folder. */
export interface ProjectService {
  /** Every project, each checked for a missing folder now (spec: directory missing). */
  list(): Promise<ProjectView[]>
  add(request: { readonly path: string; readonly name: string }): Promise<ProjectView>
  rename(request: { readonly projectId: string; readonly name: string }): Promise<ProjectView>
  /** Refused while any of its commands may be running (spec: remove project with running commands). */
  remove(projectId: string): Promise<void>
  /** Points a project at another folder (spec: relocate project); refused while it runs. */
  relocate(request: { readonly projectId: string; readonly path: string }): Promise<ProjectView>
  upsertCommand(projectId: string, command: CommandInput): Promise<CommandView>
  /** Refused while the command may be running. */
  removeCommand(commandId: string): Promise<void>
  /** The stored value of a secret override, for an explicit reveal in the UI. */
  revealSecret(commandId: string, key: string): string
  setEditor(editor: Settings['editor']): Promise<Settings>
}

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code

/** Whether `path` exists and is a directory now. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** The real path of `path`, which must be an existing directory (spec: reject non-directory). */
async function existingDirectory(path: string): Promise<string> {
  let real: string
  try {
    real = await realpath(path)
  } catch (error) {
    const code = errnoOf(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new UserError(`${path} does not exist.`)
    if (code === 'EACCES') throw new UserError(`${path} cannot be accessed.`)
    throw new UserError(`${path} cannot be checked (${code ?? String(error)}).`)
  }
  if (!(await isDirectory(real))) throw new UserError(`${path} is not a folder.`)
  return real
}

/** Real path of a registered project folder, or `null` if it cannot be resolved now. */
async function realOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

/**
 * A working directory that leaves the project folder is rejected when saving (spec: working
 * directory outside project rejected): lexically, and, if it exists, after resolving symbolic
 * links. Starting checks again, since links can change.
 */
async function checkWorkingDirectory(projectPath: string, cwd: string): Promise<void> {
  const inside = (root: string, path: string): boolean => {
    const rel = relative(root, path)
    return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
  }
  const outside = `The working directory "${cwd}" is outside the project folder ${projectPath}.`
  if (!inside(projectPath, resolve(projectPath, cwd))) throw new UserError(outside)
  const root = await realOrNull(projectPath)
  const real = root === null ? null : await realOrNull(resolve(root, cwd))
  if (root !== null && real !== null && !inside(root, real)) throw new UserError(`${outside} It resolves to ${real}.`)
}

export function createProjectService({ store, activeCommands, newId = randomUUID }: ProjectServiceDeps): ProjectService {
  const projectOf = (config: Config, projectId: string): ProjectConfig => {
    const project = config.projects.find((p) => p.id === projectId)
    if (project === undefined) throw new NotFoundError(`Project ${projectId} does not exist`)
    return project
  }

  /** Applies `change` to the stored configuration; storage refusals are explained to the user. */
  const save = async (change: (config: Config) => Config): Promise<Config> => {
    try {
      return await store.update(change)
    } catch (error) {
      if (error instanceof ConfigReadOnlyError || error instanceof ConfigValidationError) throw new UserError(`${error.message} Nothing was changed.`)
      throw error
    }
  }

  const replaceProject = (config: Config, projectId: string, next: (project: ProjectConfig) => ProjectConfig): Config => ({
    ...config,
    projects: config.projects.map((p) => (p.id === projectId ? next(p) : p)),
  })

  const running = (project: ProjectConfig): CommandConfig[] => {
    const active = activeCommands()
    return project.commands.filter((command) => active.has(command.id))
  }

  const refuseWhileRunning = (project: ProjectConfig, action: string): void => {
    const busy = running(project)
    if (busy.length > 0) throw new UserError(`Stop the running commands of "${project.name}" first (${busy.map((c) => c.name).join(', ')}), then ${action}.`)
  }

  /** The registered project whose folder is `real` (by stored path or by its real path now). */
  const registeredAt = async (real: string, except: string | null): Promise<ProjectConfig | null> => {
    const key = projectPathKey(real)
    for (const project of store.current().projects) {
      if (project.id === except) continue
      if (projectPathKey(project.path) === key) return project
      const current = await realOrNull(project.path)
      if (current !== null && projectPathKey(current) === key) return project
    }
    return null
  }

  const checkNotRegistered = async (real: string, except: string | null): Promise<void> => {
    const existing = await registeredAt(real, except)
    if (existing !== null) throw new UserError(`This folder is already registered as project "${existing.name}" (${existing.path}).`)
  }

  const viewOf = async (project: ProjectConfig): Promise<ProjectView> => projectView(project, !(await isDirectory(project.path)))

  return {
    async list() {
      return Promise.all(store.current().projects.map(viewOf))
    },

    async add({ path, name }) {
      const real = await existingDirectory(path)
      await checkNotRegistered(real, null)
      const project: ProjectConfig = { id: newId(), name: name.trim(), path: real, commands: [] }
      // Checked again inside the update, in case another request registered the folder meanwhile.
      await save((config) => {
        if (config.projects.some((p) => projectPathKey(p.path) === projectPathKey(real))) throw new UserError('This folder is already registered.')
        return { ...config, projects: [...config.projects, project] }
      })
      return viewOf(project)
    },

    async rename({ projectId, name }) {
      projectOf(store.current(), projectId)
      const config = await save((c) => replaceProject(c, projectId, (p) => ({ ...p, name: name.trim() })))
      return viewOf(projectOf(config, projectId))
    },

    async remove(projectId) {
      refuseWhileRunning(projectOf(store.current(), projectId), 'remove the project')
      await save((config) => {
        refuseWhileRunning(projectOf(config, projectId), 'remove the project')
        return { ...config, projects: config.projects.filter((p) => p.id !== projectId) }
      })
    },

    async relocate({ projectId, path }) {
      refuseWhileRunning(projectOf(store.current(), projectId), 'relocate the project')
      const real = await existingDirectory(path)
      await checkNotRegistered(real, projectId)
      const config = await save((c) => {
        refuseWhileRunning(projectOf(c, projectId), 'relocate the project')
        return replaceProject(c, projectId, (p) => ({ ...p, path: real }))
      })
      return viewOf(projectOf(config, projectId))
    },

    async upsertCommand(projectId, input) {
      const project = projectOf(store.current(), projectId)
      if (input.id !== null) {
        const found = findCommand(store.current(), input.id)
        if (found === null || found.project.id !== projectId) throw new NotFoundError(`Command ${input.id} does not exist in this project`)
      }
      await checkWorkingDirectory(project.path, input.cwd)
      const id = input.id ?? newId()
      const saved: { command?: CommandConfig } = {}
      await save((config) => {
        const target = projectOf(config, projectId)
        const previous = target.commands.find((c) => c.id === id)
        // Re-checked here: the command may have been removed since the check above.
        if (input.id !== null && previous === undefined) throw new NotFoundError(`Command ${input.id} does not exist in this project`)
        const env = input.env.map((entry): EnvEntry => {
          if (entry.value !== null) return { key: entry.key, value: entry.value, secret: entry.secret }
          // `null` keeps the stored value of a secret the renderer never received.
          const stored = previous?.env.find((e) => e.key === entry.key && e.secret)
          if (stored === undefined) throw new UserError(`Enter a value for the secret variable "${entry.key}".`)
          return { key: entry.key, value: stored.value, secret: true }
        })
        const command: CommandConfig = { id, name: input.name.trim(), execution: input.execution, cwd: input.cwd, env, stopTimeoutMs: input.stopTimeoutMs }
        saved.command = command
        const commands = previous === undefined ? [...target.commands, command] : target.commands.map((c) => (c.id === id ? command : c))
        return replaceProject(config, projectId, (p) => ({ ...p, commands }))
      })
      if (saved.command === undefined) throw new Error('Command was not saved')
      return commandView(saved.command)
    },

    async removeCommand(commandId) {
      const refuse = (config: Config): ProjectConfig => {
        const found = findCommand(config, commandId)
        if (found === null) throw new NotFoundError(`Command ${commandId} does not exist`)
        if (activeCommands().has(commandId)) throw new UserError(`Stop "${found.command.name}" first, then remove it.`)
        return found.project
      }
      refuse(store.current())
      await save((config) => {
        const project = refuse(config)
        return replaceProject(config, project.id, (p) => ({ ...p, commands: p.commands.filter((c) => c.id !== commandId) }))
      })
    },

    revealSecret(commandId, key) {
      const found = findCommand(store.current(), commandId)
      const entry = found?.command.env.find((e) => e.key === key && e.secret)
      if (entry === undefined) throw new NotFoundError(`No secret variable "${key}" in command ${commandId}`)
      return entry.value
    },

    async setEditor(editor) {
      return (await save((config) => ({ ...config, settings: { ...config.settings, editor } }))).settings
    },
  }
}
