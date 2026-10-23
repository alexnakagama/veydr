import { describe, expect, it, vi } from 'vitest'
import { connectNoticeStore, createNoticeStore } from '../../src/renderer/src/state/notices'
import { applySnapshot, applyStateEvent, connectProcessStore, createProcessStore, withCommands, type CommandStates } from '../../src/renderer/src/state/processes'
import { createProjectStore, loadProjects } from '../../src/renderer/src/state/projects'
import type { ApiResult, CommandProcessState, Notice, ProcessSnapshot, ProcessStateEvent, RunState } from '../../src/shared/api'

const cmd = '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01'
const other = '7a2e9b5d-4d2f-4f66-8b8c-1e7e2a3c0b12'
const run1 = '0b7c9f7e-2a64-4d1a-8f0e-5f7d8c9b1a22'
const run2 = '1c8d0a8f-3b75-4e2b-9a1f-6a8e9d0c2b33'

const runState = (status: RunState['status'], extra: Partial<RunState> = {}): RunState => ({
  status,
  pid: status === 'running' || status === 'stopping' ? 100 : null,
  startedAt: null,
  exit: null,
  error: null,
  survivors: [],
  ...extra,
})
const ev = (runId: string, seq: number, status: RunState['status'], extra: Partial<RunState> = {}, commandId = cmd): ProcessStateEvent => ({
  commandId,
  runId,
  seq,
  ...runState(status, extra),
})
const idle = (commandId: string, seq = 0): CommandProcessState => ({ commandId, runId: null, seq, ...runState('idle') })
const snapshot = (...commands: CommandProcessState[]): ProcessSnapshot => ({ commands })
const apply = (events: ProcessStateEvent[], start: CommandStates = applySnapshot(new Map(), snapshot(idle(cmd)))): CommandStates =>
  events.reduce(applyStateEvent, start)

describe('renderer process store: run and sequence rules', () => {
  it('[spec:process-supervision/late-events-ignored] ignores exit and state events of a previous run after a new run started', () => {
    const states = apply([
      ev(run1, 1, 'starting'),
      ev(run1, 2, 'running'),
      ev(run1, 3, 'stopping'),
      ev(run1, 4, 'exited', { exit: { code: 0, signal: 'SIGTERM', forced: false } }),
      ev(run2, 5, 'starting'),
      ev(run2, 6, 'running', { pid: 200 }),
      // Late events from run 1, even with a newer seq, must not be attributed to run 2.
      ev(run1, 7, 'exited', { exit: { code: 1, signal: null, forced: true } }),
      ev(run1, 8, 'failed', { error: 'late' }),
    ])
    expect(states.get(cmd)).toMatchObject({ runId: run2, seq: 6, status: 'running', pid: 200, exit: null })
  })

  it('[spec:process-supervision/late-events-ignored] treats only the newest run as current, so output of a previous run is not attributed to it', () => {
    const store = createProcessStore()
    store.loaded(snapshot(idle(cmd)))
    store.receive(ev(run1, 1, 'starting'))
    store.receive(ev(run1, 2, 'exited', { exit: { code: 0, signal: null, forced: false } }))
    store.receive(ev(run2, 3, 'starting'))
    expect(store.isCurrentRun(cmd, run2)).toBe(true)
    expect(store.isCurrentRun(cmd, run1)).toBe(false)
    expect(store.isCurrentRun(other, run2)).toBe(false)
  })

  it('ignores duplicates and events older than the known state', () => {
    const start = apply([ev(run1, 1, 'starting'), ev(run1, 2, 'running')])
    expect(applyStateEvent(start, ev(run1, 2, 'running', { pid: 999 }))).toBe(start)
    expect(applyStateEvent(start, ev(run1, 1, 'starting'))).toBe(start)
  })

  it('accepts a new run only from its starting event', () => {
    const start = apply([])
    expect(applyStateEvent(start, ev(run1, 1, 'running'))).toBe(start)
    expect(applyStateEvent(start, ev(run1, 1, 'starting')).get(cmd)).toMatchObject({ runId: run1, status: 'starting' })
  })

  it('ignores events of commands it does not know, and accepts them once the command is configured', () => {
    const start = apply([])
    expect(applyStateEvent(start, ev(run1, 1, 'starting', {}, other))).toBe(start)
    const added = withCommands(start, [cmd, other])
    expect(added.get(other)).toEqual(idle(other))
    expect(applyStateEvent(added, ev(run1, 1, 'starting', {}, other)).get(other)).toMatchObject({ runId: run1, status: 'starting' })
  })

  it('drops removed commands and keeps the map when nothing changed', () => {
    const start = apply([ev(run1, 1, 'starting')])
    expect(withCommands(start, [cmd])).toBe(start)
    const removed = withCommands(start, [])
    expect(removed.size).toBe(0)
    expect(applyStateEvent(removed, ev(run1, 2, 'running'))).toBe(removed)
  })

  it('keeps known states newer than a snapshot and drops commands the snapshot no longer has', () => {
    const known = apply([ev(run1, 1, 'starting'), ev(run1, 2, 'running')])
    const next = applySnapshot(known, snapshot({ commandId: cmd, runId: run1, seq: 1, ...runState('starting') }, idle(other)))
    expect(next.get(cmd)).toMatchObject({ seq: 2, status: 'running' })
    expect(next.get(other)).toEqual(idle(other))
    expect(applySnapshot(known, snapshot(idle(other))).has(cmd)).toBe(false)
  })
})

describe('renderer process store: loading from the snapshot', () => {
  it('subscribes before requesting the snapshot and applies events held meanwhile by seq', async () => {
    const order: string[] = []
    let deliver: (event: ProcessStateEvent) => void = () => undefined
    let resolveSnapshot: (result: ApiResult<ProcessSnapshot>) => void = () => undefined
    const api = {
      onState: vi.fn((listener: (event: ProcessStateEvent) => void) => {
        order.push('onState')
        deliver = listener
        return () => undefined
      }),
      snapshot: vi.fn(() => {
        order.push('snapshot')
        return new Promise<ApiResult<ProcessSnapshot>>((resolve) => (resolveSnapshot = resolve))
      }),
    }
    const store = createProcessStore()
    connectProcessStore(store, api)
    expect(order).toEqual(['onState', 'snapshot'])
    expect(store.getState().status).toBe('loading')

    // Emitted between subscription and snapshot: seq 1 is already in the snapshot, seq 2 is newer.
    deliver(ev(run1, 1, 'starting'))
    deliver(ev(run1, 2, 'running'))
    expect(store.getState().commands.size).toBe(0)

    resolveSnapshot({ ok: true, value: snapshot({ commandId: cmd, runId: run1, seq: 1, ...runState('starting') }) })
    await vi.waitFor(() => expect(store.getState().status).toBe('ready'))
    expect(store.getState().commands.get(cmd)).toMatchObject({ seq: 2, status: 'running' })

    deliver(ev(run1, 3, 'stopping'))
    expect(store.getState().commands.get(cmd)).toMatchObject({ seq: 3, status: 'stopping' })
  })

  it('reports a failed snapshot and still applies live events of configured commands', async () => {
    const store = createProcessStore()
    let deliver: (event: ProcessStateEvent) => void = () => undefined
    connectProcessStore(store, {
      onState: (listener) => {
        deliver = listener
        return () => undefined
      },
      snapshot: () => Promise.resolve({ ok: false, error: { code: 'internal', message: 'Internal error' } }),
    })
    await vi.waitFor(() => expect(store.getState().status).toBe('error'))
    expect(store.getState().error).toBe('Internal error')
    deliver(ev(run1, 1, 'starting'))
    expect(store.getState().commands.size).toBe(0)
    store.setCommands([cmd])
    deliver(ev(run1, 1, 'starting'))
    expect(store.getState().commands.get(cmd)?.status).toBe('starting')
  })

  it('reports an unreachable main process', async () => {
    const store = createProcessStore()
    connectProcessStore(store, { onState: () => () => undefined, snapshot: () => Promise.reject(new Error('gone')) })
    await vi.waitFor(() => expect(store.getState().status).toBe('error'))
    expect(store.getState().error).toBe('Could not reach the application.')
  })

  it('reports a failed live subscription without discarding known states', () => {
    const store = createProcessStore()
    let reportError: (error: { code: 'internal'; message: string }) => void = () => undefined
    connectProcessStore(store, {
      onState: (_listener, onError) => {
        reportError = (error) => onError?.(error)
        return () => undefined
      },
      snapshot: () => Promise.resolve({ ok: true, value: snapshot(idle(cmd)) }),
    })
    reportError({ code: 'internal', message: 'Could not reach the application.' })
    expect(store.getState().liveError).toBe('Could not reach the application.')
  })

  it('ignores command list updates while the snapshot is loading', () => {
    const store = createProcessStore()
    store.setCommands([cmd])
    expect(store.getState().commands.size).toBe(0)
    store.loaded(snapshot(idle(cmd)))
    store.setCommands([cmd, other])
    expect([...store.getState().commands.keys()]).toEqual([cmd, other])
  })

  it('notifies subscribers only when the state changes', () => {
    const store = createProcessStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.loaded(snapshot(idle(cmd)))
    expect(listener).toHaveBeenCalledTimes(1)
    store.receive(ev(run1, 1, 'running'))
    expect(listener).toHaveBeenCalledTimes(1)
    store.receive(ev(run1, 1, 'starting'))
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('renderer notice store', () => {
  const notice = (id: string): Notice => ({ id, kind: 'recovered-from-backup', severity: 'warning', message: id, files: [] })

  it('shows each notice once although main replays them on every subscription', () => {
    const store = createNoticeStore()
    let deliver: (n: Notice) => void = () => undefined
    connectNoticeStore(store, {
      onNotice: (listener) => {
        deliver = listener
        return () => undefined
      },
    })
    deliver(notice('notice-1'))
    deliver(notice('notice-2'))
    deliver(notice('notice-1'))
    expect(store.getState().visible.map((n) => n.id)).toEqual(['notice-1', 'notice-2'])
  })

  it('reports a failed notice subscription', () => {
    const store = createNoticeStore()
    connectNoticeStore(store, {
      onNotice: (_listener, onError) => {
        onError?.({ code: 'validation', message: 'Invalid request' })
        return () => undefined
      },
    })
    expect(store.getState().error).toBe('Invalid request')
  })

  it('dismisses a notice in this document; a replay does not bring it back', () => {
    const store = createNoticeStore()
    store.receive(notice('notice-1'))
    store.dismiss('notice-1')
    store.dismiss('notice-1')
    store.receive(notice('notice-1'))
    expect(store.getState().visible).toEqual([])
  })
})

describe('renderer project store', () => {
  it('loads projects and reports errors', async () => {
    const store = createProjectStore()
    await loadProjects(store, { list: () => Promise.resolve({ ok: true, value: [] }) })
    expect(store.getState()).toEqual({ status: 'ready', projects: [] })
    await loadProjects(store, { list: () => Promise.resolve({ ok: false, error: { code: 'internal', message: 'Internal error' } }) })
    expect(store.getState()).toEqual({ status: 'error', message: 'Internal error' })
    await loadProjects(store, { list: () => Promise.reject(new Error('gone')) })
    expect(store.getState()).toEqual({ status: 'error', message: 'Could not reach the application.' })
  })
})
