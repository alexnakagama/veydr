import { describe, expect, it } from 'vitest'
import { createDiagnosticLog } from '../../src/main/app/diagnostics'
import { createEventHub, type EventSubscriber } from '../../src/main/ipc/events'
import { createOperationHandlers } from '../../src/main/ipc/handlers'
import { registerEventSubscriptions, registerOperations } from '../../src/main/ipc/operations'
import { createIpcRegistry, type InvokeEvent, type SenderFrame } from '../../src/main/ipc/register'
import { createEnvironmentService } from '../../src/main/projects/environment'
import { findCommand } from '../../src/main/projects/lookup'
import { createProjectService } from '../../src/main/projects/service'
import { createProcessStateRegistry } from '../../src/main/supervisor/state'
import { createSupervisor } from '../../src/main/supervisor/supervisor'
import { channels, contractEntries, internalChannels, type AppInfo } from '../../src/shared/api'
import { command, config, project } from './support/config'
import { FakeProcessTree } from './support/fake-process-tree'

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
  let stored = config([project({ name: 'shop', path: '/home/dev/shop', commands: [secretCommand, plainCommand] })])
  const store = {
    current: () => stored,
    update: (change: (c: typeof stored) => typeof stored) => {
      stored = change(stored)
      return Promise.resolve(stored)
    },
  }

  const tree = new FakeProcessTree()
  const supervisor = createSupervisor({
    processTree: tree,
    states: processStates,
    lookup: (commandId) => findCommand(store.current(), commandId),
    plan: (target) => Promise.resolve({ ok: true, plan: { file: target.command.name, args: [], cwd: target.project.path, env: {} } }),
    log,
  })

  registerEventSubscriptions(registry, hub)
  const resolutions: string[] = []
  const recovery = {
    resolve: (action: 'terminate' | 'dismiss') => {
      resolutions.push(action)
      return Promise.resolve(action === 'terminate' ? [{ pid: 4321, name: 'node' }] : [])
    },
  }
  const environment = createEnvironmentService({
    provider: { base: () => Promise.resolve({ env: { PATH: '/usr/bin', PORT: '80' }, warnings: ['login shell failed'] }) },
  })
  const projects = createProjectService({ store, activeCommands: () => new Set(supervisor.active().map((run) => run.commandId)) })
  const opened: string[] = []
  const desktop = {
    pickDirectory: () => Promise.resolve('/home/dev/picked'),
    openFolder: (projectId: string) => {
      opened.push(projectId)
      return Promise.resolve()
    },
    openInEditor: () => Promise.reject(new Error('not used')),
  }
  registerOperations(registry, createOperationHandlers({ info, config: () => store.current(), processStates, supervisor, recovery, projects, environment, desktop }))

  const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
    const listener = listeners.get(channel)
    if (listener === undefined) throw new Error(`no handler for ${channel}`)
    return Promise.resolve(listener({ senderFrame: mainFrame, sender }, ...args))
  }
  return { registry, invoke, hub, processStates, sent, stored, secretCommand, plainCommand, log, tree, resolutions, supervisor, opened }
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
    // The folder does not exist on the test machine, so the project is listed as missing.
    expect(list).toMatchObject({ ok: true, value: [{ id: stored.projects[0]?.id, name: 'shop', path: '/home/dev/shop', missing: true }] })
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

  it('previews the environment with secrets masked, reveals a secret on request, and refuses invalid project changes', async () => {
    const { invoke, secretCommand, stored, opened } = setup()
    expect(await invoke(channels.commands.previewEnvironment, { commandId: secretCommand.id, refresh: false })).toEqual({
      ok: true,
      value: {
        entries: [
          { key: 'API_TOKEN', secret: true, value: null, source: 'override' },
          { key: 'PATH', secret: false, value: '/usr/bin', source: 'base' },
          { key: 'PORT', secret: false, value: '3000', source: 'override' },
        ],
        warnings: ['login shell failed'],
      },
    })
    expect(await invoke(channels.commands.revealSecret, { commandId: secretCommand.id, key: 'API_TOKEN' })).toEqual({ ok: true, value: { value: 'hunter2-very-secret' } })
    expect(await invoke(channels.commands.revealSecret, { commandId: secretCommand.id, key: 'PORT' })).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(await invoke(channels.projects.add, { path: '/veydr/no/such/dir', name: 'x' })).toEqual({
      ok: false,
      error: { code: 'rejected', message: '/veydr/no/such/dir does not exist.' },
    })
    expect(await invoke(channels.projects.pickDirectory)).toEqual({ ok: true, value: '/home/dev/picked' })
    const projectId = stored.projects[0]?.id ?? ''
    expect(await invoke(channels.projects.openFolder, { projectId })).toEqual({ ok: true, value: null })
    expect(opened).toEqual([projectId])
  })

  it('answers operations of later task groups with not_implemented, after validating the request', async () => {
    const { invoke } = setup()
    const requests: Record<string, unknown> = {
      [channels.ports.list]: undefined,
      [channels.logs.ack]: { batchId: 1 },
    }
    for (const [channel, request] of Object.entries(requests)) {
      const result = await (request === undefined ? invoke(channel) : invoke(channel, request))
      expect(result, channel).toMatchObject({ ok: false, error: { code: 'not_implemented' } })
    }
    expect(await invoke(channels.processes.start, { commandId: 'nope' })).toMatchObject({ ok: false, error: { code: 'validation' } })
  })

  it('resolves crash survivors through the recovery service', async () => {
    const { invoke, resolutions } = setup()
    expect(await invoke(channels.processes.resolveSurvivors, { action: 'terminate' })).toEqual({ ok: true, value: { remaining: [{ pid: 4321, name: 'node' }] } })
    expect(await invoke(channels.processes.resolveSurvivors, { action: 'dismiss' })).toEqual({ ok: true, value: { remaining: [] } })
    expect(await invoke(channels.processes.resolveSurvivors, { action: 'kill' })).toMatchObject({ ok: false, error: { code: 'validation' } })
    expect(resolutions).toEqual(['terminate', 'dismiss'])
  })

  it('answers starts and restarts during quit with shutting_down', async () => {
    const { invoke, secretCommand, tree, supervisor } = setup()
    await supervisor.stopAll()
    for (const channel of [channels.processes.start, channels.processes.restart]) {
      expect(await invoke(channel, { commandId: secretCommand.id }), channel).toMatchObject({ ok: false, error: { code: 'shutting_down' } })
    }
    expect(tree.spawnCalls).toBe(0)
  })

  it('starts, restarts, and stops commands, publishing every state to subscribers', async () => {
    const { invoke, sent, secretCommand, tree } = setup()
    expect(await invoke(internalChannels.subscribe, { topic: channels.processes.onState, token })).toEqual({ ok: true, value: null })

    const started = await invoke(channels.processes.start, { commandId: secretCommand.id })
    expect(started).toMatchObject({ ok: true, value: { commandId: secretCommand.id, status: 'running', pid: tree.last.pid } })
    expect(await invoke(channels.processes.restart, { commandId: secretCommand.id })).toMatchObject({ ok: true, value: { status: 'running', pid: tree.last.pid } })
    expect(await invoke(channels.processes.stop, { commandId: secretCommand.id })).toMatchObject({ ok: true, value: { status: 'exited' } })
    expect(sent.map((m) => (m.payload as { status: string }).status)).toEqual(['starting', 'running', 'stopping', 'exited', 'starting', 'running', 'stopping', 'exited'])
    expect(await invoke(channels.processes.snapshot)).toMatchObject({ ok: true, value: { commands: [{ status: 'exited', seq: 8 }, { status: 'idle' }] } })
  })

  it('answers lifecycle requests for unknown commands with not_found', async () => {
    const { invoke, sent } = setup()
    for (const channel of [channels.processes.start, channels.processes.stop, channels.processes.restart]) {
      expect(await invoke(channel, { commandId: '9b0f2a1e-0000-4000-8000-000000000000' }), channel).toMatchObject({
        ok: false,
        error: { code: 'not_found', message: 'Command 9b0f2a1e-0000-4000-8000-000000000000 does not exist' },
      })
    }
    expect(sent).toEqual([])
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
