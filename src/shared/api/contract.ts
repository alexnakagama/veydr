import { z, type ZodType } from 'zod'
import { settingsSchema } from '../config/schema'
import { appInfoSchema, getInfoRequestSchema, noticeSchema } from './app'
import { channels, eventTopics, internalChannels, type EventTopic } from './channels'
import {
  commandRefSchema,
  environmentPreviewSchema,
  previewEnvironmentRequestSchema,
  revealedSecretSchema,
  revealSecretRequestSchema,
  upsertCommandRequestSchema,
} from './commands'
import { ackRequestSchema, logBatchSchema, readLogsRequestSchema, readLogsResponseSchema, runRefSchema } from './logs'
import { portSnapshotSchema } from './ports'
import {
  commandProcessStateSchema,
  processSnapshotSchema,
  processStateEventSchema,
  resolveSurvivorsRequestSchema,
  resolveSurvivorsResponseSchema,
} from './processes'
import {
  addProjectRequestSchema,
  commandViewSchema,
  pickDirectoryResponseSchema,
  projectListSchema,
  projectRefSchema,
  projectViewSchema,
  relocateProjectRequestSchema,
  updateProjectRequestSchema,
} from './projects'
import { setEditorRequestSchema } from './settings'

/** A request/response operation: main parses `request` before the handler and `response` after it. */
export interface InvokeSpec<Req extends ZodType = ZodType, Res extends ZodType = ZodType> {
  readonly kind: 'invoke'
  readonly channel: string
  readonly request: Req
  readonly response: Res
}

/** An event subscription: main validates `payload` before sending it on `channel`. */
export interface EventSpec<P extends ZodType = ZodType> {
  readonly kind: 'event'
  readonly channel: EventTopic
  readonly payload: P
}

export type OperationSpec = InvokeSpec | EventSpec

const invoke = <Req extends ZodType, Res extends ZodType>(channel: string, request: Req, response: Res): InvokeSpec<Req, Res> => ({
  kind: 'invoke',
  channel,
  request,
  response,
})

const event = <P extends ZodType>(channel: EventTopic, payload: P): EventSpec<P> => ({ kind: 'event', channel, payload })

/** Responses of operations that only report success. */
const done = z.null()
const none = getInfoRequestSchema

/**
 * The complete preload API contract (design D3): every exposed operation with its channel and
 * schemas. `satisfies` makes the compiler reject a missing or extra operation relative to `channels`.
 */
export const contract = {
  app: {
    getInfo: invoke(channels.app.getInfo, none, appInfoSchema),
    onNotice: event(channels.app.onNotice, noticeSchema),
  },
  projects: {
    list: invoke(channels.projects.list, none, projectListSchema),
    pickDirectory: invoke(channels.projects.pickDirectory, none, pickDirectoryResponseSchema),
    add: invoke(channels.projects.add, addProjectRequestSchema, projectViewSchema),
    update: invoke(channels.projects.update, updateProjectRequestSchema, projectViewSchema),
    remove: invoke(channels.projects.remove, projectRefSchema, done),
    relocate: invoke(channels.projects.relocate, relocateProjectRequestSchema, projectViewSchema),
    openFolder: invoke(channels.projects.openFolder, projectRefSchema, done),
    openInEditor: invoke(channels.projects.openInEditor, projectRefSchema, done),
  },
  commands: {
    upsert: invoke(channels.commands.upsert, upsertCommandRequestSchema, commandViewSchema),
    remove: invoke(channels.commands.remove, commandRefSchema, done),
    previewEnvironment: invoke(channels.commands.previewEnvironment, previewEnvironmentRequestSchema, environmentPreviewSchema),
    revealSecret: invoke(channels.commands.revealSecret, revealSecretRequestSchema, revealedSecretSchema),
  },
  processes: {
    snapshot: invoke(channels.processes.snapshot, none, processSnapshotSchema),
    start: invoke(channels.processes.start, commandRefSchema, commandProcessStateSchema),
    stop: invoke(channels.processes.stop, commandRefSchema, commandProcessStateSchema),
    restart: invoke(channels.processes.restart, commandRefSchema, commandProcessStateSchema),
    onState: event(channels.processes.onState, processStateEventSchema),
    resolveSurvivors: invoke(channels.processes.resolveSurvivors, resolveSurvivorsRequestSchema, resolveSurvivorsResponseSchema),
  },
  logs: {
    read: invoke(channels.logs.read, readLogsRequestSchema, readLogsResponseSchema),
    clear: invoke(channels.logs.clear, runRefSchema, done),
    onBatch: event(channels.logs.onBatch, logBatchSchema),
    ack: invoke(channels.logs.ack, ackRequestSchema, done),
  },
  ports: {
    list: invoke(channels.ports.list, none, portSnapshotSchema),
  },
  settings: {
    get: invoke(channels.settings.get, none, settingsSchema),
    setEditor: invoke(channels.settings.setEditor, setEditorRequestSchema, settingsSchema),
  },
} as const satisfies { readonly [G in keyof typeof channels]: { readonly [K in keyof (typeof channels)[G]]: OperationSpec } }

export type Contract = typeof contract

/** One contract entry with its group and operation name. */
export interface ContractEntry {
  readonly group: string
  readonly name: string
  readonly spec: OperationSpec
}

/** Every contract entry, in declaration order. */
export const contractEntries: readonly ContractEntry[] = Object.entries(contract as Readonly<Record<string, Readonly<Record<string, OperationSpec>>>>).flatMap(
  ([group, operations]) => Object.entries(operations).map(([name, spec]) => ({ group, name, spec })),
)

/** Payload of the internal subscribe/unsubscribe requests. `token` identifies the sending document. */
export const eventSubscriptionSchema = z.strictObject({
  topic: z.enum(eventTopics),
  token: z.uuid(),
})
export type EventSubscription = z.infer<typeof eventSubscriptionSchema>

/** Internal operations used by the preload bridge itself; not part of `window.veydr`. */
export const internalContract = {
  subscribe: invoke(internalChannels.subscribe, eventSubscriptionSchema, done),
  unsubscribe: invoke(internalChannels.unsubscribe, eventSubscriptionSchema, done),
} as const

/** Event payload schemas by topic. */
export const eventPayloads = {
  [channels.app.onNotice]: contract.app.onNotice.payload,
  [channels.processes.onState]: contract.processes.onState.payload,
  [channels.logs.onBatch]: contract.logs.onBatch.payload,
} as const satisfies { readonly [T in EventTopic]: ZodType }

export type EventPayload<T extends EventTopic> = z.output<(typeof eventPayloads)[T]>
