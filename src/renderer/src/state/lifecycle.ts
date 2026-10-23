import type { VeydrApi } from '../../../shared/api'
import { UNREACHABLE } from './store'

export type LifecycleAction = 'start' | 'stop' | 'restart'

/**
 * Requests a lifecycle action; resolves with an error message for the user, or `null` on success.
 * The resulting states arrive as `processes.onState` events, so the result value is not needed.
 */
export type LifecycleRequest = (action: LifecycleAction, commandId: string) => Promise<string | null>

export function createLifecycleRequest(api: Pick<VeydrApi['processes'], 'start' | 'stop' | 'restart'>): LifecycleRequest {
  return async (action, commandId) => {
    const request = { commandId }
    try {
      const result = action === 'start' ? await api.start(request) : action === 'stop' ? await api.stop(request) : await api.restart(request)
      return result.ok ? null : result.error.message
    } catch {
      return UNREACHABLE
    }
  }
}
