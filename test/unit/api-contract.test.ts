import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  channels,
  commandInputSchema,
  commandViewSchema,
  contract,
  contractEntries,
  declaredOperations,
  eventPayloads,
  eventTopics,
  internalChannels,
  logBatchSchema,
  MAX_BATCH_LINES,
  MAX_LINE_TEXT_LENGTH,
  processStateEventSchema,
  readLogsRequestSchema,
  type ApiResult,
  type AppInfo,
  type CommandProcessState,
  type CommandView,
  type LogBatch,
  type Notice,
  type ProcessSnapshot,
  type ProcessStateEvent,
  type ProjectView,
  type SubscriptionErrorListener,
  type Unsubscribe,
  type VeydrApi,
} from '../../src/shared/api'
import type { Settings } from '../../src/shared/config'

const ids = {
  command: '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01',
  run: '0b7c9f7e-2a64-4d1a-8f0e-5f7d8c9b1a22',
}

describe('API contract (design D3)', () => {
  it('declares exactly the operations of every channel table entry, on the same channel', () => {
    for (const [group, operations] of Object.entries(channels)) {
      const specs = (contract as Record<string, Record<string, { channel: string }>>)[group]
      expect(Object.keys(specs ?? {}).sort()).toEqual(Object.keys(operations).sort())
      for (const [name, channel] of Object.entries(operations)) expect(specs?.[name]?.channel).toBe(channel)
    }
    expect(Object.keys(contract).sort()).toEqual(Object.keys(channels).sort())
  })

  it('uses a unique channel for every operation, distinct from the internal channels', () => {
    const all = [...Object.values(channels).flatMap((ops) => Object.values(ops)), ...Object.values(internalChannels)]
    expect(new Set(all).size).toBe(all.length)
  })

  it('lists the documented groups and operations', () => {
    expect(declaredOperations).toEqual({
      app: ['getInfo', 'onNotice'],
      projects: ['list', 'pickDirectory', 'add', 'update', 'remove', 'relocate', 'openFolder', 'openInEditor'],
      commands: ['upsert', 'remove', 'previewEnvironment', 'revealSecret'],
      processes: ['snapshot', 'start', 'stop', 'restart', 'onState', 'resolveSurvivors'],
      logs: ['read', 'clear', 'onBatch', 'ack'],
      ports: ['list'],
      settings: ['get', 'setEditor'],
    })
  })

  it('treats exactly the on… operations as events, each with a payload schema', () => {
    const events = contractEntries.filter(({ spec }) => spec.kind === 'event')
    expect(events.every(({ name }) => /^on[A-Z]/.test(name))).toBe(true)
    expect(events.map(({ spec }) => spec.channel).sort()).toEqual([...eventTopics].sort())
    expect(Object.keys(eventPayloads).sort()).toEqual([...eventTopics].sort())
    const invokes = contractEntries.filter(({ spec }) => spec.kind === 'invoke')
    expect(invokes.some(({ name }) => /^on[A-Z]/.test(name))).toBe(false)
    expect(contractEntries).toHaveLength(Object.values(channels).flatMap((ops) => Object.keys(ops)).length)
  })
})

describe('API payload schemas', () => {
  const state = { status: 'running', pid: 42, startedAt: 1_700_000_000_000, exit: null, error: null, survivors: [] }

  it('carries the event envelope {commandId, runId, seq} on state events and log batches, strictly', () => {
    const event = { commandId: ids.command, runId: ids.run, seq: 1, ...state }
    expect(processStateEventSchema.safeParse(event).success).toBe(true)
    expect(processStateEventSchema.safeParse({ ...event, extra: 1 }).success).toBe(false)
    expect(processStateEventSchema.safeParse({ ...event, seq: 0 }).success).toBe(false)
    expect(processStateEventSchema.safeParse({ ...event, runId: null }).success).toBe(false)

    const batch = { commandId: ids.command, runId: ids.run, seq: 3, batchId: 1, lines: [], skipped: { fromSeq: 1, toSeq: 3 } }
    expect(logBatchSchema.safeParse(batch).success).toBe(true)
    expect(logBatchSchema.safeParse({ ...batch, extra: 1 }).success).toBe(false)
    expect(logBatchSchema.safeParse({ ...batch, skipped: { fromSeq: 4, toSeq: 3 } }).success).toBe(false)
  })

  it('never lets a secret value into a command view', () => {
    const view = {
      id: ids.command,
      name: 'api',
      execution: { mode: 'direct', file: 'node', args: [] },
      cwd: '.',
      env: [{ key: 'TOKEN', secret: true, value: null }],
      stopTimeoutMs: 5000,
    }
    expect(commandViewSchema.safeParse(view).success).toBe(true)
    expect(commandViewSchema.safeParse({ ...view, env: [{ key: 'TOKEN', secret: true, value: 'hunter2' }] }).success).toBe(false)
  })

  it('allows keeping a stored value only for secret overrides', () => {
    const input = {
      id: null,
      name: 'api',
      execution: { mode: 'shell', shell: '/bin/sh', script: 'npm run dev' },
      cwd: '.',
      env: [{ key: 'TOKEN', secret: true, value: null }],
      stopTimeoutMs: 5000,
    }
    expect(commandInputSchema.safeParse(input).success).toBe(true)
    expect(commandInputSchema.safeParse({ ...input, env: [{ key: 'PORT', secret: false, value: null }] }).success).toBe(false)
    expect(
      commandInputSchema.safeParse({
        ...input,
        env: [
          { key: 'A', secret: false, value: '1' },
          { key: 'A', secret: false, value: '2' },
        ],
      }).success,
    ).toBe(false)
    expect(commandInputSchema.safeParse({ ...input, cwd: '/etc' }).success).toBe(false)
    expect(commandInputSchema.safeParse({ ...input, execution: { mode: 'shell', shell: 'sh', script: 'x' } }).success).toBe(false)
  })

  it('bounds log batches and lines with cheap checks', () => {
    const line = { seq: 1, stream: 'stdout', at: 1, text: 'x'.repeat(MAX_LINE_TEXT_LENGTH), truncated: true }
    const batch = { commandId: ids.command, runId: ids.run, seq: 1, batchId: 1, lines: [line], skipped: null }
    expect(logBatchSchema.safeParse(batch).success).toBe(true)
    expect(logBatchSchema.safeParse({ ...batch, lines: [{ ...line, text: `${line.text}x` }] }).success).toBe(false)
    expect(logBatchSchema.safeParse({ ...batch, lines: Array.from({ length: MAX_BATCH_LINES + 1 }, () => line) }).success).toBe(false)
  })

  it('bounds log reads', () => {
    expect(readLogsRequestSchema.safeParse({ runId: ids.run, fromSeq: 1, limit: 5000 }).success).toBe(true)
    expect(readLogsRequestSchema.safeParse({ runId: ids.run, fromSeq: 1, limit: 5001 }).success).toBe(false)
    expect(readLogsRequestSchema.safeParse({ runId: ids.run, fromSeq: 0, limit: 1 }).success).toBe(false)
    expect(readLogsRequestSchema.safeParse({ runId: 'x', fromSeq: 1, limit: 1 }).success).toBe(false)
  })
})

describe('VeydrApi types (checked by `npm run typecheck`)', () => {
  it('derives every function from the contract', () => {
    expectTypeOf<VeydrApi['app']['getInfo']>().toEqualTypeOf<() => Promise<ApiResult<AppInfo>>>()
    expectTypeOf<VeydrApi['app']['onNotice']>().toEqualTypeOf<(listener: (payload: Notice) => void, onError?: SubscriptionErrorListener) => Unsubscribe>()
    expectTypeOf<VeydrApi['projects']['list']>().toEqualTypeOf<() => Promise<ApiResult<ProjectView[]>>>()
    expectTypeOf<VeydrApi['projects']['pickDirectory']>().returns.resolves.toEqualTypeOf<ApiResult<string | null>>()
    expectTypeOf<VeydrApi['projects']['add']>().parameter(0).toEqualTypeOf<{ path: string; name: string }>()
    expectTypeOf<VeydrApi['commands']['upsert']>().returns.resolves.toEqualTypeOf<ApiResult<CommandView>>()
    expectTypeOf<VeydrApi['processes']['snapshot']>().returns.resolves.toEqualTypeOf<ApiResult<ProcessSnapshot>>()
    expectTypeOf<VeydrApi['processes']['start']>().toEqualTypeOf<
      (request: { commandId: string }) => Promise<ApiResult<CommandProcessState>>
    >()
    expectTypeOf<VeydrApi['processes']['onState']>().toEqualTypeOf<(listener: (payload: ProcessStateEvent) => void, onError?: SubscriptionErrorListener) => Unsubscribe>()
    expectTypeOf<VeydrApi['logs']['onBatch']>().toEqualTypeOf<(listener: (payload: LogBatch) => void, onError?: SubscriptionErrorListener) => Unsubscribe>()
    expectTypeOf<VeydrApi['logs']['read']>()
      .parameter(0)
      .toEqualTypeOf<{ runId: string; fromSeq: number; limit: number }>()
    expectTypeOf<VeydrApi['logs']['ack']>().returns.resolves.toEqualTypeOf<ApiResult<null>>()
    expectTypeOf<VeydrApi['settings']['get']>().returns.resolves.toEqualTypeOf<ApiResult<Settings>>()
  })

  it('types secrets in views as null and the envelope fields as required', () => {
    type SecretEntry = Extract<CommandView['env'][number], { secret: true }>
    expectTypeOf<SecretEntry['value']>().toEqualTypeOf<null>()
    expectTypeOf<ProcessStateEvent>().toHaveProperty('commandId').toEqualTypeOf<string>()
    expectTypeOf<ProcessStateEvent>().toHaveProperty('runId').toEqualTypeOf<string>()
    expectTypeOf<ProcessStateEvent>().toHaveProperty('seq').toEqualTypeOf<number>()
    expectTypeOf<LogBatch>().toHaveProperty('runId').toEqualTypeOf<string>()
    expectTypeOf<CommandProcessState['runId']>().toEqualTypeOf<string | null>()
  })

  it('rejects calls that do not match the contract', () => {
    const api = {} as VeydrApi
    const typeErrors = (): void => {
      // @ts-expect-error a request payload is required
      void api.processes.start()
      // @ts-expect-error commandId must be a string
      void api.processes.stop({ commandId: 1 })
      // @ts-expect-error operations without a payload take none
      void api.projects.list({})
      // @ts-expect-error there is no generic invoke
      const generic: unknown = api.app.invoke
      void generic
    }
    expect(typeof typeErrors).toBe('function')
  })
})
