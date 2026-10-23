import type { ProjectView, VeydrApi } from '../../../shared/api'
import { createStore, UNREACHABLE, type WritableStore } from './store'

export type ProjectsState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly projects: readonly ProjectView[] }
  | { readonly status: 'error'; readonly message: string }

export function createProjectStore(): WritableStore<ProjectsState> {
  return createStore<ProjectsState>({ status: 'loading' })
}

/** Loads the registered projects (secret values arrive masked). */
export function loadProjects(store: WritableStore<ProjectsState>, api: Pick<VeydrApi['projects'], 'list'>): Promise<void> {
  return api.list().then(
    (result) => store.set(result.ok ? { status: 'ready', projects: result.value } : { status: 'error', message: result.error.message }),
    () => store.set({ status: 'error', message: UNREACHABLE }),
  )
}
