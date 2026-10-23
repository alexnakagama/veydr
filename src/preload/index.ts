import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { channels, internalChannels, type EventTopic } from '../shared/api/channels'
import type { ApiError, SubscriptionErrorListener, Unsubscribe, VeydrApi } from '../shared/api'

/** Identifies this document to main, which drops a previous document's subscriptions on reload. */
const documentToken = crypto.randomUUID()

/** Topics this document is currently subscribed to. */
const activeTopics = new Set<EventTopic>()

/** Sends a subscribe/unsubscribe request; resolves to the error, or `null` on success. */
function setSubscription(channel: string, topic: EventTopic): Promise<ApiError | null> {
  return ipcRenderer.invoke(channel, { topic, token: documentToken }).then(
    (result: { ok: boolean; error?: ApiError }) =>
      result.ok ? null : (result.error ?? { code: 'internal', message: 'The request was rejected.' }),
    (): ApiError => ({ code: 'internal', message: 'Could not reach the application.' }),
  )
}

/** Subscribes main to `topic`, retrying once; reports a lasting failure while the topic is still wanted. */
function subscribe(topic: EventTopic, onFailure: (error: ApiError) => void): void {
  const attempt = (retries: number): void => {
    void setSubscription(internalChannels.subscribe, topic).then((error) => {
      if (error === null || !activeTopics.has(topic)) return
      if (retries > 0) attempt(retries - 1)
      else onFailure(error)
    })
  }
  attempt(1)
}

interface ListenerEntry {
  readonly fn: (payload: unknown) => void
  readonly onError: SubscriptionErrorListener | undefined
}

/**
 * Event subscription for one topic. Main is subscribed while at least one listener exists; the
 * returned function removes exactly the listener it was created for, once.
 */
function eventSource(topic: EventTopic): (listener: (payload: never) => void, onError?: SubscriptionErrorListener) => Unsubscribe {
  const listeners = new Set<ListenerEntry>()
  const each = (call: (entry: ListenerEntry) => void, what: string): void => {
    for (const entry of [...listeners]) {
      try {
        call(entry)
      } catch (error) {
        console.error(`Veydr: a ${topic} ${what} threw`, error)
      }
    }
  }
  // The IPC event object is not forwarded: it would expose `sender` (ipcRenderer) to the page.
  const dispatch = (_event: IpcRendererEvent, payload: unknown): void => each((entry) => entry.fn(payload), 'listener')
  const failed = (error: ApiError): void => {
    console.warn(`Veydr: subscribing to ${topic} failed`, error)
    each((entry) => entry.onError?.({ code: error.code, message: error.message }), 'error listener')
  }

  return (listener, onError) => {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    if (onError !== undefined && typeof onError !== 'function') throw new TypeError('onError must be a function')
    const entry: ListenerEntry = { fn: listener as (payload: unknown) => void, onError }
    const first = listeners.size === 0
    listeners.add(entry)
    if (first) {
      ipcRenderer.on(topic, dispatch)
      activeTopics.add(topic)
      subscribe(topic, failed)
    }

    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      listeners.delete(entry)
      if (listeners.size > 0) return
      ipcRenderer.removeListener(topic, dispatch)
      activeTopics.delete(topic)
      void setSubscription(internalChannels.unsubscribe, topic)
    }
  }
}

// Named operations only; there is deliberately no generic invoke/send. Each function forwards at
// most one argument, which main validates against the operation's schema.
const api: VeydrApi = {
  app: {
    getInfo: () => ipcRenderer.invoke(channels.app.getInfo),
    onNotice: eventSource(channels.app.onNotice),
  },
  projects: {
    list: () => ipcRenderer.invoke(channels.projects.list),
    pickDirectory: () => ipcRenderer.invoke(channels.projects.pickDirectory),
    add: (request) => ipcRenderer.invoke(channels.projects.add, request),
    update: (request) => ipcRenderer.invoke(channels.projects.update, request),
    remove: (request) => ipcRenderer.invoke(channels.projects.remove, request),
    relocate: (request) => ipcRenderer.invoke(channels.projects.relocate, request),
    openFolder: (request) => ipcRenderer.invoke(channels.projects.openFolder, request),
    openInEditor: (request) => ipcRenderer.invoke(channels.projects.openInEditor, request),
  },
  commands: {
    upsert: (request) => ipcRenderer.invoke(channels.commands.upsert, request),
    remove: (request) => ipcRenderer.invoke(channels.commands.remove, request),
    previewEnvironment: (request) => ipcRenderer.invoke(channels.commands.previewEnvironment, request),
    revealSecret: (request) => ipcRenderer.invoke(channels.commands.revealSecret, request),
  },
  processes: {
    snapshot: () => ipcRenderer.invoke(channels.processes.snapshot),
    start: (request) => ipcRenderer.invoke(channels.processes.start, request),
    stop: (request) => ipcRenderer.invoke(channels.processes.stop, request),
    restart: (request) => ipcRenderer.invoke(channels.processes.restart, request),
    onState: eventSource(channels.processes.onState),
    resolveSurvivors: (request) => ipcRenderer.invoke(channels.processes.resolveSurvivors, request),
  },
  logs: {
    read: (request) => ipcRenderer.invoke(channels.logs.read, request),
    clear: (request) => ipcRenderer.invoke(channels.logs.clear, request),
    onBatch: eventSource(channels.logs.onBatch),
    ack: (request) => ipcRenderer.invoke(channels.logs.ack, request),
  },
  ports: {
    list: () => ipcRenderer.invoke(channels.ports.list),
  },
  settings: {
    get: () => ipcRenderer.invoke(channels.settings.get),
    setEditor: (request) => ipcRenderer.invoke(channels.settings.setEditor, request),
  },
}

// Optimization only: a request sent while the document unloads may never arrive. Correctness does
// not depend on it, because main drops this document's subscriptions as soon as the next document
// subscribes with a new token (or the webContents is destroyed).
globalThis.addEventListener('pagehide', () => {
  for (const topic of activeTopics) void setSubscription(internalChannels.unsubscribe, topic)
  activeTopics.clear()
})

contextBridge.exposeInMainWorld('veydr', api)
