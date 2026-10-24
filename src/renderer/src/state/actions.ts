import type { ApiResult, CommandInput, CommandView, EnvironmentPreview, ProjectView, VeydrApi } from '../../../shared/api'
import type { EditorConfig, Settings } from '../../../shared/config'
import { UNREACHABLE } from './store'

/** What a request led to; `message` explains a failure to the user. */
export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

/** Project, command, environment, and settings requests made from the UI. */
export interface ProjectActions {
  pickDirectory(): Promise<Outcome<string | null>>
  addProject(path: string, name: string): Promise<Outcome<ProjectView>>
  renameProject(projectId: string, name: string): Promise<Outcome<ProjectView>>
  removeProject(projectId: string): Promise<Outcome<null>>
  relocateProject(projectId: string, path: string): Promise<Outcome<ProjectView>>
  openFolder(projectId: string): Promise<Outcome<null>>
  openInEditor(projectId: string): Promise<Outcome<null>>
  saveCommand(projectId: string, command: CommandInput): Promise<Outcome<CommandView>>
  removeCommand(commandId: string): Promise<Outcome<null>>
  previewEnvironment(commandId: string, refresh: boolean): Promise<Outcome<EnvironmentPreview>>
  revealSecret(commandId: string, key: string): Promise<Outcome<string>>
  getSettings(): Promise<Outcome<Settings>>
  setEditor(editor: EditorConfig | null): Promise<Outcome<Settings>>
}

type Api = Pick<VeydrApi, 'projects' | 'commands' | 'settings'>

function outcome<T>(request: Promise<ApiResult<T>>): Promise<Outcome<T>> {
  return request.then(
    (result) => (result.ok ? { ok: true, value: result.value } : { ok: false, message: result.error.message }),
    () => ({ ok: false, message: UNREACHABLE }),
  )
}

/**
 * Requests through the preload API. After every successful change, `reload` refreshes the project
 * list, so the UI shows what main stored (including whether folders are missing).
 */
export function createProjectActions(api: Api, reload: () => Promise<void>): ProjectActions {
  const change = async <T>(request: Promise<ApiResult<T>>): Promise<Outcome<T>> => {
    const result = await outcome(request)
    if (result.ok) await reload()
    return result
  }
  return {
    pickDirectory: () => outcome(api.projects.pickDirectory()),
    addProject: (path, name) => change(api.projects.add({ path, name })),
    renameProject: (projectId, name) => change(api.projects.update({ projectId, name })),
    removeProject: (projectId) => change(api.projects.remove({ projectId })),
    relocateProject: (projectId, path) => change(api.projects.relocate({ projectId, path })),
    openFolder: (projectId) => outcome(api.projects.openFolder({ projectId })),
    openInEditor: (projectId) => outcome(api.projects.openInEditor({ projectId })),
    saveCommand: (projectId, command) => change(api.commands.upsert({ projectId, command })),
    removeCommand: (commandId) => change(api.commands.remove({ commandId })),
    previewEnvironment: (commandId, refresh) => outcome(api.commands.previewEnvironment({ commandId, refresh })),
    revealSecret: async (commandId, key) => {
      const result = await outcome(api.commands.revealSecret({ commandId, key }))
      return result.ok ? { ok: true, value: result.value.value } : result
    },
    getSettings: () => outcome(api.settings.get()),
    setEditor: (editor) => outcome(api.settings.setEditor({ editor })),
  }
}
