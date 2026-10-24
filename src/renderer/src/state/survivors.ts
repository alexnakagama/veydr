import type { ProcessInfo, ResolveSurvivorsRequest, VeydrApi } from '../../../shared/api'
import { UNREACHABLE } from './store'

export type SurvivorAction = ResolveSurvivorsRequest['action']

export type SurvivorOutcome = { readonly ok: true; readonly remaining: readonly ProcessInfo[] } | { readonly ok: false; readonly message: string }

/**
 * Resolves the survivors of an earlier session (`crash-survivors` notice): `terminate` ends them,
 * `dismiss` leaves them running. Survivors that could not be terminated arrive as a new notice.
 */
export type SurvivorRequest = (action: SurvivorAction) => Promise<SurvivorOutcome>

export function createSurvivorRequest(api: Pick<VeydrApi['processes'], 'resolveSurvivors'>): SurvivorRequest {
  return async (action) => {
    try {
      const result = await api.resolveSurvivors({ action })
      return result.ok ? { ok: true, remaining: result.value.remaining } : { ok: false, message: result.error.message }
    } catch {
      return { ok: false, message: UNREACHABLE }
    }
  }
}
