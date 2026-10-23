import { describe, expect, it } from 'vitest'
import { createProcessStateRegistry } from '../../src/main/supervisor/state'
import { processSnapshotSchema, processStateEventSchema, type ProcessStateEvent, type RunState } from '../../src/shared/api'

const commandA = '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01'
const commandB = '7a2e9b5d-4d2f-4f66-8b8c-1e7e2a3c0b12'
const run1 = '0b7c9f7e-2a64-4d1a-8f0e-5f7d8c9b1a22'
const run2 = '1c8d0a8f-3b75-4e2b-9a1f-6a8e9d0c2b33'

const state = (status: RunState['status'], extra: Partial<RunState> = {}): RunState => ({
  status,
  pid: null,
  startedAt: null,
  exit: null,
  error: null,
  survivors: [],
  ...extra,
})

describe('process state registry (event envelope)', () => {
  it('stamps every state with {commandId, runId, seq}, seq increasing per command across runs', () => {
    const emitted: ProcessStateEvent[] = []
    const registry = createProcessStateRegistry((event) => emitted.push(event))

    registry.record(commandA, run1, state('starting'))
    registry.record(commandA, run1, state('running', { pid: 10, startedAt: 1 }))
    registry.record(commandB, run2, state('starting'))
    registry.record(commandA, run1, state('exited', { exit: { code: 0, signal: null, forced: false } }))
    registry.record(commandA, run2, state('starting'))

    expect(emitted.map((e) => [e.commandId === commandA ? 'A' : 'B', e.runId === run1 ? 1 : 2, e.seq, e.status])).toEqual([
      ['A', 1, 1, 'starting'],
      ['A', 1, 2, 'running'],
      ['B', 2, 1, 'starting'],
      ['A', 1, 3, 'exited'],
      ['A', 2, 4, 'starting'],
    ])
    for (const event of emitted) expect(processStateEventSchema.safeParse(event).success).toBe(true)
  })

  it('snapshots requested commands in order; never-run commands are idle with seq 0', () => {
    const registry = createProcessStateRegistry(() => undefined)
    registry.record(commandA, run1, state('starting'))
    registry.record(commandA, run1, state('running', { pid: 10, startedAt: 1 }))
    const snapshot = registry.snapshot([commandB, commandA])
    expect(processSnapshotSchema.safeParse(snapshot).success).toBe(true)
    expect(snapshot.commands).toEqual([
      { commandId: commandB, runId: null, seq: 0, ...state('idle') },
      { commandId: commandA, runId: run1, seq: 2, ...state('running', { pid: 10, startedAt: 1 }) },
    ])
  })

  it('returns copies: changing a snapshot or emitted event does not change the registry', () => {
    const emitted: ProcessStateEvent[] = []
    const registry = createProcessStateRegistry((event) => emitted.push(event))
    const survivors = [{ pid: 5, name: 'node' }]
    registry.record(commandA, run1, state('starting'))
    registry.record(commandA, run1, state('exited', { survivors }))
    survivors.push({ pid: 6, name: 'x' })
    const snapshot = registry.snapshot([commandA])
    ;(snapshot.commands[0]?.survivors as { pid: number; name: string }[]).push({ pid: 7, name: 'y' })
    expect(registry.snapshot([commandA]).commands[0]?.survivors).toEqual([{ pid: 5, name: 'node' }])
  })

  it('forgets a removed command but never reuses its seq', () => {
    const registry = createProcessStateRegistry(() => undefined)
    registry.record(commandA, run1, state('starting'))
    registry.record(commandA, run1, state('running', { pid: 10, startedAt: 1 }))
    registry.forget(commandA)
    expect(registry.snapshot([commandA]).commands[0]).toMatchObject({ runId: null, seq: 2, status: 'idle' })
    expect(registry.record(commandA, run2, state('starting'))?.seq).toBe(3)
  })

  it('[spec:process-supervision/late-events-ignored] does not record or emit a late state of a previous run', () => {
    const emitted: ProcessStateEvent[] = []
    const registry = createProcessStateRegistry((event) => emitted.push(event))
    registry.record(commandA, run1, state('starting'))
    registry.record(commandA, run2, state('starting'))
    expect(registry.record(commandA, run1, state('exited', { exit: { code: 0, signal: null, forced: false } }))).toBeNull()
    expect(registry.record(commandA, run1, state('running', { pid: 9, startedAt: 1 }))).toBeNull()

    expect(emitted.map((e) => [e.runId === run1 ? 1 : 2, e.status])).toEqual([
      [1, 'starting'],
      [2, 'starting'],
    ])
    expect(registry.snapshot([commandA]).commands[0]).toMatchObject({ runId: run2, seq: 2, status: 'starting' })
  })

  it('accepts only a starting state as the first state of a command', () => {
    const registry = createProcessStateRegistry(() => undefined)
    expect(registry.record(commandA, run1, state('running', { pid: 1, startedAt: 1 }))).toBeNull()
    expect(registry.record(commandA, run1, state('starting'))?.seq).toBe(1)
  })
})
