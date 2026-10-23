import { describe, expect, it } from 'vitest'
import { createDiagnosticLog } from '../../src/main/app/diagnostics'
import { createEventHub, type EventSubscriber } from '../../src/main/ipc/events'
import { createOperationHandlers } from '../../src/main/ipc/handlers'
import { registerEventSubscriptions, registerOperations } from '../../src/main/ipc/operations'
import { createIpcRegistry, type InvokeEvent, type SenderFrame } from '../../src/main/ipc/register'
import { createProcessStateRegistry } from '../../src/main/supervisor/state'
import { channels, contractEntries, internalChannels, type AppInfo } from '../../src/shared/api'
import { command, config, project } from './support/config'

type Listener = (event: InvokeEvent, ...args: unknown[]) => unknown

const info: AppInfo = {
  name: 'Veydr',
  version: '0.0.0',
  platform: 'linux',
  platformSupported: true,
  versions: { electron: '44.9.3', chrome: '1', node: '24' },
}
const token = '11111111-1111-4111-8111-111111111111'

function setup() {
  const listeners = new Map<string, Listener>()
  const mainFrame: SenderFrame = { url: 'app://veydr/index.html' }
  const sent: { channel: string; payload: unknown }[] = []
  const sender: EventSubscriber = { id: 1, isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) }
  const log = createDiagnosticLog(() => undefined)
  const registry = createIpcRegistry({
    ipcMain: { handle: (channel, listener) => listeners.set(channel, listener) },
    mainFrame: () => mainFrame,
    trustedOrigin: 'app://veydr',
    log,
  })
  const hub = createEventHub(log)
  const processStates = createProcessStateRegistry((event) => hub.publish(channels.processes.onState, event))

  const secretCommand = command({
    name: 'api',
    env: [
      { key: 'PORT', value: '3000', secret: false },
      { key: 'API_TOKEN', value: 'hunter2-very-secret', secret: true },
    ],
  })
  const plainCommand = command({ name: 'web', execution: { mode: 'shell', shell: '/bin/bash', script: 'npm run dev' } })
  const stored = config([project({ name: 'shop', path: '/home/dev/shop', commands: [secretCommand, plainCommand] })])

  registerEventSubscriptions(registry, hub)
  registerOperations(registry, createOperationHandlers({ info, config: () => stored, processStates }))

  const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
    const listener = listeners.get(channel)
    if (listener === undefined) throw new Error(`no handler for ${channel}`)
    return Promise.resolve(listener({ senderFrame: mainFrame, sender }, ...args))
  }
  return { registry, invoke, hub, processStates, sent, stored, secretCommand, plainCommand, log }
}

const invokeChannels = contractEntries.filter(({ spec }) => spec.kind === 'invoke').map(({ spec }) => spec.channel)

describe('registered operations', () => {
  it('registers a handler for every request/response operation plus the internal subscription channels', () => {
    const { registry } = setup()
    expect([...registry.channels].sort()).toEqual([...invokeChannels, ...Object.values(internalChannels)].sort())
  })

  it('answers app.getInfo, projects.list, processes.snapshot, and settings.get', async () => {
    const { invoke, stored, secretCommand, plainCommand } = setup()
    expect(await invoke(channels.app.getInfo)).toEqual({ ok: true, value: info })
    expect(await invoke(channels.settings.get)).toEqual({ ok: true, value: { editor: null } })
    expect(await invoke(channels.processes.snapshot)).toEqual({
      ok: true,
      value: {
        commands: [secretCommand, plainCommand].map((c) => ({
          commandId: c.id,
          runId: null,
          seq: 0,
          status: 'idle',
          pid: null,
          startedAt: null,
          exit: null,
          error: null,
          survivors: [],
        })),
      },
    })

    const list = await invoke(channels.projects.list)
    expect(list).toMatchObject({ ok: true, value: [{ id: stored.projects[0]?.id, name: 'shop', path: '/home/dev/shop' }] })
    expect(JSON.stringify(list)).not.toContain('hunter2-very-secret')
    expect(list).toMatchObject({
      value: [
        {
          commands: [
            {
              name: 'api',
              env: [
                { key: 'PORT', secret: false, value: '3000' },
                { key: 'API_TOKEN', secret: true, value: null },
              ],
            },
            { name: 'web', execution: { mode: 'shell', shell: '/bin/bash', script: 'npm run dev' } },
          ],
        },
      ],
    })
  })

  it('answers operations of later task groups with not_implemented, after validating the request', async () => {
    const { invoke } = setup()
    const requests: Record<string, unknown> = {
      [channels.projects.pickDirectory]: undefined,
      [channels.projects.add]: { path: '/home/dev/x', name: 'x' },
      [channels.processes.start]: { commandId: '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01' },
      [channels.ports.list]: undefined,
      [channels.logs.ack]: { batchId: 1 },
    }
    for (const [channel, request] of Object.entries(requests)) {
      const result = await (request === undefined ? invoke(channel) : invoke(channel, request))
      expect(result, channel).toMatchObject({ ok: false, error: { code: 'not_implemented' } })
    }
    expect(await invoke(channels.processes.start, { commandId: 'nope' })).toMatchObject({ ok: false, error: { code: 'validation' } })
  })

  it('subscribes the sending webContents through the gated internal channel', async () => {
    const { invoke, hub, processStates, sent, secretCommand } = setup()
    expect(await invoke(internalChannels.subscribe, { topic: channels.processes.onState, token })).toEqual({ ok: true, value: null })
    expect(hub.subscriberCount(channels.processes.onState)).toBe(1)

    const event = processStates.record(secretCommand.id, '0b7c9f7e-2a64-4d1a-8f0e-5f7d8c9b1a22', {
      status: 'starting',
      pid: null,
      startedAt: null,
      exit: null,
      error: null,
      survivors: [],
    })
    expect(sent).toEqual([{ channel: channels.processes.onState, payload: event }])

    expect(await invoke(internalChannels.unsubscribe, { topic: channels.processes.onState, token })).toEqual({ ok: true, value: null })
    expect(hub.subscriberCount(channels.processes.onState)).toBe(0)
    expect(await invoke(internalChannels.subscribe, { topic: 'app:getInfo', token })).toMatchObject({
      ok: false,
      error: { code: 'validation' },
    })
    expect(await invoke(internalChannels.subscribe, { topic: channels.app.onNotice, token: 'not-a-uuid' })).toMatchObject({
      ok: false,
      error: { code: 'validation' },
    })
  })

  it('handles a subscribe sent before a snapshot first, so the snapshot never misses a transition', async () => {
    const { invoke, hub, processStates } = setup()
    let subscribedWhenSnapshotRan = -1
    const snapshot = processStates.snapshot.bind(processStates)
    processStates.snapshot = (ids) => {
      subscribedWhenSnapshotRan = hub.subscriberCount(channels.processes.onState)
      return snapshot(ids)
    }
    // Sent back to back without awaiting, as the renderer store does.
    const results = await Promise.all([
      invoke(internalChannels.subscribe, { topic: channels.processes.onState, token }),
      invoke(channels.processes.snapshot),
    ])
    expect(results.map((r) => (r as { ok: boolean }).ok)).toEqual([true, true])
    expect(subscribedWhenSnapshotRan).toBe(1)
  })
})
