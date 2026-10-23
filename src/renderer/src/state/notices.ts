import type { Notice, Unsubscribe, VeydrApi } from '../../../shared/api'
import { createStore, type Store } from './store'

export interface NoticesState {
  /** Notices not dismissed in this document, oldest first. */
  readonly visible: readonly Notice[]
  /** Why notices cannot be received; notices may then be missing. */
  readonly error: string | null
}

export interface NoticeStore extends Store<NoticesState> {
  /** Adds a notice; one already received (main replays notices on every subscription) is ignored. */
  readonly receive: (notice: Notice) => void
  /** Hides a notice in this document. Main still holds it, so a reload shows it again. */
  readonly dismiss: (id: string) => void
  readonly failed: (message: string) => void
}

export function createNoticeStore(): NoticeStore {
  const store = createStore<NoticesState>({ visible: [], error: null })
  const seen = new Set<string>()
  return {
    getState: store.getState,
    subscribe: store.subscribe,
    receive(notice) {
      if (seen.has(notice.id)) return
      seen.add(notice.id)
      store.set({ ...store.getState(), visible: [...store.getState().visible, notice] })
    },
    dismiss(id) {
      const { visible } = store.getState()
      if (!visible.some((notice) => notice.id === id)) return
      store.set({ ...store.getState(), visible: visible.filter((notice) => notice.id !== id) })
    },
    failed(message) {
      store.set({ ...store.getState(), error: message })
    },
  }
}

export function connectNoticeStore(store: NoticeStore, api: Pick<VeydrApi['app'], 'onNotice'>): Unsubscribe {
  return api.onNotice(
    (notice) => store.receive(notice),
    (error) => store.failed(error.message),
  )
}
