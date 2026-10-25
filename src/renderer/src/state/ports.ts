import type { ApiErrorCode, PortSnapshot, VeydrApi } from '../../../shared/api'
import { createStore, UNREACHABLE, type Store } from './store'

/** How often the ports view refreshes while it is visible (design D12). */
export const PORTS_POLL_INTERVAL_MS = 3_000

export interface PortsState {
  /** The last successful listing, kept while a refresh fails. */
  readonly snapshot: PortSnapshot | null
  /** A request is in flight. */
  readonly loading: boolean
  /** Why the last request failed; `code` is `null` when main could not be reached. */
  readonly error: { readonly code: ApiErrorCode | null; readonly message: string } | null
}

/** Port listings while the view is visible: one request at a time, every 3 s and on demand. */
export interface PortsPoller extends Store<PortsState> {
  /** The view became visible: refreshes now, then every 3 s. */
  readonly start: () => void
  /** The view is hidden: no further requests until `start`. */
  readonly stop: () => void
  /** Refreshes now (after the request in flight, if any). */
  readonly refresh: () => void
}

export interface PollTimers {
  readonly setTimeout: (callback: () => void, ms: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
}

const defaultTimers: PollTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
}

/** The part of `document` that says whether the window is visible. */
export interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

/**
 * Polls while the window is visible (not minimized or hidden); returns the function that stops
 * following and polling, for when the view is closed.
 */
export function pollWhileVisible(poller: Pick<PortsPoller, 'start' | 'stop'>, source: VisibilitySource): () => void {
  const update = (): void => {
    if (source.visibilityState === 'hidden') poller.stop()
    else poller.start()
  }
  update()
  source.addEventListener('visibilitychange', update)
  return () => {
    source.removeEventListener('visibilitychange', update)
    poller.stop()
  }
}

export function createPortsPoller(api: Pick<VeydrApi['ports'], 'list'>, timers: PollTimers = defaultTimers): PortsPoller {
  const store = createStore<PortsState>({ snapshot: null, loading: false, error: null })
  let active = false
  let inFlight = false
  /** A refresh was asked for while a request was in flight. */
  let again = false
  let timer: unknown = null

  const cancelTimer = (): void => {
    if (timer !== null) timers.clearTimeout(timer)
    timer = null
  }

  const request = (): void => {
    cancelTimer()
    if (inFlight) {
      again = true
      return
    }
    inFlight = true
    store.set({ ...store.getState(), loading: true })
    void api.list().then(
      (result) => finish(result.ok ? { snapshot: result.value, error: null } : { error: { code: result.error.code, message: result.error.message } }),
      () => finish({ error: { code: null, message: UNREACHABLE } }),
    )
  }

  const finish = (outcome: Partial<PortsState>): void => {
    inFlight = false
    store.set({ ...store.getState(), ...outcome, loading: false })
    if (!active) return
    if (again) {
      again = false
      request()
    } else {
      // Counted from the end of a request, so a slow listing never overlaps the next one.
      timer = timers.setTimeout(() => {
        timer = null
        request()
      }, PORTS_POLL_INTERVAL_MS)
    }
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    start() {
      if (active) return
      active = true
      request()
    },
    stop() {
      active = false
      again = false
      cancelTimer()
    },
    refresh() {
      if (active) request()
    },
  }
}
