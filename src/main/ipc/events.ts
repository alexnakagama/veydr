import { eventPayloads, type EventPayload, type EventTopic } from '../../shared/api'
import type { DiagnosticLog } from '../app/diagnostics'

/** The subset of Electron's `WebContents` that receives events. */
export interface EventSubscriber {
  readonly id: number
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

export interface EventHub {
  /**
   * Subscribes the document identified by `token` in `subscriber` to `topic`. A different token
   * from the same `webContents` means its document was replaced (reload): every subscription of
   * the previous document is dropped first, so nothing is sent on its behalf any more.
   */
  subscribe(subscriber: EventSubscriber, topic: EventTopic, token: string): void
  /** Ignored unless `token` is the subscriber's current document. */
  unsubscribe(subscriber: EventSubscriber, topic: EventTopic, token: string): void
  /** Forgets every subscription of a `webContents` (destroyed, or its renderer process is gone). */
  drop(contentsId: number): void
  /** Validates `payload` and sends it to every current subscriber of `topic`. */
  publish<T extends EventTopic>(topic: T, payload: EventPayload<T>): void
  /** Sends `payload` to one subscriber only, if it is subscribed to `topic`; e.g. to replay state. */
  sendTo<T extends EventTopic>(subscriber: EventSubscriber, topic: T, payload: EventPayload<T>): void
  /** Runs `hook` after every successful subscription to `topic`. */
  onSubscribe(topic: EventTopic, hook: (subscriber: EventSubscriber) => void): void
  subscriberCount(topic: EventTopic): number
}

interface Entry {
  subscriber: EventSubscriber
  readonly token: string
  readonly topics: Set<EventTopic>
}

/**
 * Tracks event subscribers per `webContents` and document (design D3). Sends to a destroyed
 * `webContents`, or one whose `send` throws, are dropped together with its subscriptions.
 */
export function createEventHub(log: Pick<DiagnosticLog, 'record'>): EventHub {
  const entries = new Map<number, Entry>()
  const hooks = new Map<EventTopic, ((subscriber: EventSubscriber) => void)[]>()

  function deliver(entry: Entry, topic: EventTopic, payload: unknown): void {
    const { subscriber } = entry
    if (subscriber.isDestroyed()) {
      entries.delete(subscriber.id)
      log.record('info', 'events.dropped-destroyed', { contentsId: subscriber.id, topic })
      return
    }
    try {
      subscriber.send(topic, payload)
    } catch (error) {
      entries.delete(subscriber.id)
      log.record('warn', 'events.send-failed', {
        contentsId: subscriber.id,
        topic,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** The payload as declared by the contract, or `undefined` (logged) if it does not match. */
  function validated(topic: EventTopic, payload: unknown): unknown {
    const parsed = eventPayloads[topic].safeParse(payload)
    if (parsed.success) return parsed.data
    log.record('error', 'events.invalid-payload', {
      topic,
      paths: parsed.error.issues.slice(0, 5).map((i) => i.path.join('.')),
    })
    return undefined
  }

  return {
    subscribe(subscriber, topic, token) {
      let entry = entries.get(subscriber.id)
      if (entry !== undefined && entry.token !== token) {
        log.record('info', 'events.document-replaced', { contentsId: subscriber.id, dropped: [...entry.topics] })
        entry = undefined
      }
      if (entry === undefined) {
        entry = { subscriber, token, topics: new Set() }
        entries.set(subscriber.id, entry)
      }
      entry.subscriber = subscriber
      entry.topics.add(topic)
      for (const hook of hooks.get(topic) ?? []) hook(subscriber)
    },

    unsubscribe(subscriber, topic, token) {
      const entry = entries.get(subscriber.id)
      if (entry === undefined || entry.token !== token) return
      entry.topics.delete(topic)
    },

    drop(contentsId) {
      entries.delete(contentsId)
    },

    publish(topic, payload) {
      const targets = [...entries.values()].filter((entry) => entry.topics.has(topic))
      if (targets.length === 0) return
      const checked = validated(topic, payload)
      if (checked === undefined) return
      for (const entry of targets) deliver(entry, topic, checked)
    },

    sendTo(subscriber, topic, payload) {
      const entry = entries.get(subscriber.id)
      if (entry === undefined || !entry.topics.has(topic)) return
      const checked = validated(topic, payload)
      if (checked === undefined) return
      deliver(entry, topic, checked)
    },

    onSubscribe(topic, hook) {
      hooks.set(topic, [...(hooks.get(topic) ?? []), hook])
    },

    subscriberCount(topic) {
      let count = 0
      for (const entry of entries.values()) if (entry.topics.has(topic)) count += 1
      return count
    },
  }
}
