/**
 * IPC channel per exposed operation (design D3). Preload and main both use this table; it has no
 * dependencies so the sandboxed preload bundle stays small. The schemas for every entry live in
 * `contract.ts`, which must cover exactly these operations (checked at compile time and by tests).
 *
 * Operations named `on…` are event subscriptions: main sends their payloads on the listed channel to
 * renderers that subscribed through `internalChannels`. Everything else is a request/response call.
 */
export const channels = {
  app: {
    getInfo: 'app:getInfo',
    onNotice: 'app:onNotice',
  },
  projects: {
    list: 'projects:list',
    pickDirectory: 'projects:pickDirectory',
    add: 'projects:add',
    update: 'projects:update',
    remove: 'projects:remove',
    relocate: 'projects:relocate',
    openFolder: 'projects:openFolder',
    openInEditor: 'projects:openInEditor',
  },
  commands: {
    upsert: 'commands:upsert',
    remove: 'commands:remove',
    previewEnvironment: 'commands:previewEnvironment',
    revealSecret: 'commands:revealSecret',
  },
  processes: {
    snapshot: 'processes:snapshot',
    start: 'processes:start',
    stop: 'processes:stop',
    restart: 'processes:restart',
    onState: 'processes:onState',
    resolveSurvivors: 'processes:resolveSurvivors',
  },
  logs: {
    read: 'logs:read',
    clear: 'logs:clear',
    onBatch: 'logs:onBatch',
    ack: 'logs:ack',
  },
  ports: {
    list: 'ports:list',
  },
  settings: {
    get: 'settings:get',
    setEditor: 'settings:setEditor',
  },
} as const

/** Event channels; each is also the subscription topic. */
export const eventTopics = [channels.app.onNotice, channels.processes.onState, channels.logs.onBatch] as const
export type EventTopic = (typeof eventTopics)[number]

/** Used only inside the preload bridge to (un)subscribe a document to an event topic; never exposed. */
export const internalChannels = {
  subscribe: 'events:subscribe',
  unsubscribe: 'events:unsubscribe',
} as const

export type ApiGroup = keyof typeof channels

/**
 * Operation groups and names the preload bridge exposes. The E2E API
 * enumeration test compares `window.veydr` against this table.
 */
export const declaredOperations: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(channels).map(([group, ops]) => [group, Object.keys(ops)]),
)
