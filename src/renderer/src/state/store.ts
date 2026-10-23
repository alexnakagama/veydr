import { useSyncExternalStore } from 'react'

/**
 * A minimal external store for `useSyncExternalStore`: immutable states, change notification.
 * Members are properties, not methods, because stores are passed around detached.
 */
export interface Store<S> {
  readonly getState: () => S
  readonly subscribe: (listener: () => void) => () => void
}

export interface WritableStore<S> extends Store<S> {
  /** Replaces the state; listeners run only if `next` is a different object. */
  readonly set: (next: S) => void
}

export function createStore<S>(initial: S): WritableStore<S> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(next) {
      if (Object.is(next, state)) return
      state = next
      for (const listener of [...listeners]) listener()
    },
  }
}

export function useStore<S>(store: Store<S>): S {
  return useSyncExternalStore(store.subscribe, store.getState)
}

/** Message shown when a request to the main process fails without a typed error. */
export const UNREACHABLE = 'Could not reach the application.'
