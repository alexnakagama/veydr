import type { VeydrApi } from '../../../shared/api'
import { connectLogStore, createLogViewStore, type LogViewStore } from './logs'
import { connectNoticeStore, createNoticeStore, type NoticeStore } from './notices'
import { connectProcessStore, createProcessStore, type ProcessStore } from './processes'
import { createProjectStore, loadProjects, type ProjectsState } from './projects'
import type { WritableStore } from './store'

export interface Stores {
  readonly notices: NoticeStore
  readonly projects: WritableStore<ProjectsState>
  readonly processes: ProcessStore
  /** Output of the selected command's current run. */
  readonly logs: LogViewStore
}

/**
 * Creates the renderer stores and connects them to main. Runs once per document, outside React,
 * so a reload starts from a fresh snapshot and a fresh set of subscriptions.
 */
export function connectStores(api: VeydrApi): Stores {
  const stores: Stores = {
    notices: createNoticeStore(),
    projects: createProjectStore(),
    processes: createProcessStore(),
    logs: createLogViewStore(api.logs),
  }
  connectNoticeStore(stores.notices, api.app)
  connectProcessStore(stores.processes, api.processes)
  connectLogStore(stores.logs, api.logs)
  // Process states follow the configured commands: events of removed commands are ignored.
  stores.projects.subscribe(() => {
    const projects = stores.projects.getState()
    if (projects.status !== 'ready') return
    stores.processes.setCommands(projects.projects.flatMap((project) => project.commands.map((command) => command.id)))
  })
  void loadProjects(stores.projects, api.projects)
  // Folders may be deleted or restored while Veydr runs: check again when the window regains focus.
  if (typeof window !== 'undefined') window.addEventListener('focus', () => void loadProjects(stores.projects, api.projects))
  return stores
}
