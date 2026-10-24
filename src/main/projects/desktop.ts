import { EDITOR_PATH_PLACEHOLDER, type Config } from '../../shared/config'
import { NotFoundError, UserError } from '../errors'
import { SpawnError } from '../platform/errors'
import type { CommandResolver, ProcessTree } from '../platform/types'
import type { EnvironmentService } from './environment'
import { isDirectory } from './service'

/** Hand-offs to the desktop: the folder picker, the file manager, and the configured editor. */
export interface DesktopActions {
  /** The folder the user chose, or `null` if the picker was cancelled. */
  pickDirectory(): Promise<string | null>
  /** Opens the project folder in the file manager; only an existing directory is opened. */
  openFolder(projectId: string): Promise<void>
  /** Starts the configured editor on the project folder, unsupervised and without a shell. */
  openInEditor(projectId: string): Promise<void>
}

export interface DesktopDeps {
  readonly config: () => Config
  /** The native folder picker (Electron `dialog.showOpenDialog`). */
  readonly showDirectoryPicker: () => Promise<string | null>
  /** Electron `shell.openPath`: resolves with an error message, or `''` on success. */
  readonly openPath: (path: string) => Promise<string>
  readonly launcher: Pick<ProcessTree, 'launchDetached'>
  readonly resolver: CommandResolver
  readonly environment: Pick<EnvironmentService, 'base'>
}

/** An editor argument template with the project path substituted; each template entry stays one argument. */
export function editorArguments(template: readonly string[], projectPath: string): string[] {
  // A function replacer: a string replacement would expand `$$`, `$&`, … found in the path.
  return template.map((arg) => arg.replaceAll(EDITOR_PATH_PLACEHOLDER, () => projectPath))
}

export function createDesktopActions(deps: DesktopDeps): DesktopActions {
  /** The project, whose folder must be an existing directory right now (spec: path is not a directory). */
  const existingProject = async (projectId: string) => {
    const project = deps.config().projects.find((p) => p.id === projectId)
    if (project === undefined) throw new NotFoundError(`Project ${projectId} does not exist`)
    if (!(await isDirectory(project.path))) throw new UserError(`Nothing was opened: the folder of "${project.name}" is missing or not a folder (${project.path}).`)
    return project
  }

  return {
    pickDirectory: () => deps.showDirectoryPicker(),

    async openFolder(projectId) {
      const project = await existingProject(projectId)
      const error = await deps.openPath(project.path)
      if (error !== '') throw new UserError(`The folder could not be opened: ${error}`)
    },

    async openInEditor(projectId) {
      const editor = deps.config().settings.editor
      if (editor === null) throw new UserError('No editor is configured. Choose one in Settings.')
      const project = await existingProject(projectId)
      const { env } = await deps.environment.base()
      const spec = {
        mode: 'direct' as const,
        file: editor.file,
        args: editorArguments(editor.args, project.path),
        script: '',
        shellPath: null,
        projectRoot: project.path,
        cwd: '.',
      }
      const resolved = await deps.resolver.resolve(spec, env)
      if (!resolved.ok) throw new UserError(`The editor could not be started: ${resolved.diagnostics.join(' ')}`)
      try {
        await deps.launcher.launchDetached(resolved.plan)
      } catch (error) {
        if (error instanceof SpawnError) throw new UserError(`The editor could not be started: ${error.message}`)
        throw error
      }
    },
  }
}
