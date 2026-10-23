import type { z } from 'zod'
import type { Contract, EventSpec, InvokeSpec } from './contract'
import type { ApiError, ApiResult } from './result'

export * from './app'
export * from './channels'
export * from './commands'
export * from './contract'
export * from './logs'
export * from './ports'
export * from './processes'
export * from './projects'
export * from './result'
export * from './settings'

/** Removes the listener; calling it again does nothing. */
export type Unsubscribe = () => void

/**
 * Called if main refuses or cannot be reached for the subscription (after one retry); events of
 * the topic are then not received until the listener is registered again.
 */
export type SubscriptionErrorListener = (error: ApiError) => void

/** The function the preload bridge exposes for one contract entry. */
export type ApiFunction<S> =
  S extends InvokeSpec<infer Req, infer Res>
    ? undefined extends z.input<Req>
      ? () => Promise<ApiResult<z.output<Res>>>
      : (request: z.input<Req>) => Promise<ApiResult<z.output<Res>>>
    : S extends EventSpec<infer P>
      ? (listener: (payload: z.output<P>) => void, onError?: SubscriptionErrorListener) => Unsubscribe
      : never

/** `window.veydr`, derived from the contract so the two cannot drift apart. */
export type VeydrApi = {
  readonly [G in keyof Contract]: { readonly [K in keyof Contract[G]]: ApiFunction<Contract[G][K]> }
}
