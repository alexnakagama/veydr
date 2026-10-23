import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SpawnError } from '../../src/main/platform/errors'
import { createProcessStateRegistry } from '../../src/main/supervisor/state'
import { createSupervisor, type LaunchTarget } from '../../src/main/supervisor/supervisor'
import type { CommandProcessState, ProcessStateEvent } from '../../src/shared/api'
import { cooperative, FakeProcessTree, type FakeBehavior } from './support/fake-process-tree'
import { command, project, quietLog } from './support/config'

// Seeded random-action hammer (task 4.3): 500 random lifecycle actions, exits, behavior changes,
// and clock advances against the supervisor with a fake process tree, checking the D7 invariants
// after every step and once everything has settled.

const ACTIONS = 500
const SEEDS = [1, 0xc0ffee, 20261023]

/** mulberry32: small, fast, and deterministic for a given seed. */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Allowed state transitions within one run (design D7). */
const next: Readonly<Record<string, readonly string[]>> = {
  starting: ['running', 'failed'],
  running: ['stopping', 'exited'],
  stopping: ['exited'],
  exited: [],
  failed: [],
}

/** Checks the event stream of one command: run-local transitions, non-overlapping runs, seq. */
function checkEvents(events: readonly ProcessStateEvent[]): void {
  const seenRuns = new Set<string>()
  let current: ProcessStateEvent | undefined
  events.forEach((event, i) => {
    expect(event.seq, `seq of event ${i}`).toBe(i + 1)
    if (event.status === 'starting') {
      // A new run starts only after the previous one ended, and a runId is never reused.
      if (current !== undefined) expect(['exited', 'failed'], `run before event ${i}`).toContain(current.status)
      expect(seenRuns.has(event.runId), `runId reused at event ${i}`).toBe(false)
      seenRuns.add(event.runId)
    } else {
      expect(current?.runId, `event ${i} belongs to the current run`).toBe(event.runId)
      expect(next[current?.status ?? ''], `transition ${current?.status} → ${event.status} at ${i}`).toContain(event.status)
    }
    if (event.status === 'running') expect(event.pid).not.toBeNull()
    if (event.status === 'exited') expect(event.exit).not.toBeNull()
    if (event.status === 'failed') expect(event.error).not.toBeNull()
    current = event
  })
}

interface CommandUnderTest {
  readonly id: string
  readonly tree: FakeProcessTree
  readonly events: ProcessStateEvent[]
}

async function hammer(seed: number): Promise<{ actions: Record<string, number>; runs: number }> {
  const rand = random(seed)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T
  const states = createProcessStateRegistry((event) => commands.find((c) => c.id === event.commandId)?.events.push(event))
  const commands: CommandUnderTest[] = [0, 1].map(() => ({ id: command().id, tree: new FakeProcessTree(), events: [] }))
  const targets = new Map<string, LaunchTarget>(commands.map((c) => [c.id, { project: project(), command: command({ id: c.id, stopTimeoutMs: 100 }) }]))
  const supervisors = new Map(
    commands.map((c) => [
      c.id,
      createSupervisor({
        processTree: c.tree,
        states,
        lookup: (id) => targets.get(id) ?? null,
        plan: () => Promise.resolve({ ok: true, plan: { file: 'x', args: [], cwd: '/', env: {} } }),
        log: quietLog(),
      }),
    ]),
  )
  const supervisorOf = (c: CommandUnderTest) => supervisors.get(c.id) as ReturnType<typeof createSupervisor>

  const pending: Promise<CommandProcessState>[] = []
  const counts: Record<string, number> = {}

  const checkStep = (): void => {
    for (const c of commands) expect(c.tree.liveLeaders().length, 'live leaders of one command').toBeLessThanOrEqual(1)
  }

  for (let step = 0; step < ACTIONS; step++) {
    const c = pick(commands)
    const roll = rand()
    let action: string
    if (roll < 0.3) {
      action = 'start'
      pending.push(supervisorOf(c).start(c.id))
    } else if (roll < 0.55) {
      action = 'stop'
      pending.push(supervisorOf(c).stop(c.id))
    } else if (roll < 0.7) {
      action = 'restart'
      pending.push(supervisorOf(c).restart(c.id))
    } else if (roll < 0.82) {
      action = 'exit'
      const live = c.tree.liveLeaders()[0]
      live?.exit(rand() < 0.5 ? 0 : 1, rand() < 0.3 ? 'SIGSEGV' : null)
    } else if (roll < 0.92) {
      action = 'behavior'
      const behavior: FakeBehavior = {
        spawnError: rand() < 0.15 ? new SpawnError('executable-not-found', 'Executable not found: x') : null,
        spawnDelayMs: Math.floor(rand() * 30),
        stopDelayMs: Math.floor(rand() * 60),
        uncooperative: rand() < 0.3,
        survivors: rand() < 0.1 ? 1 : 0,
        leftovers: rand() < 0.3 ? 2 : 0,
      }
      c.tree.behavior = behavior
    } else {
      action = 'wait'
    }
    counts[action] = (counts[action] ?? 0) + 1
    await vi.advanceTimersByTimeAsync(Math.floor(rand() * 25))
    checkStep()
  }

  // Let everything settle, then stop both commands for good.
  for (const c of commands) c.tree.behavior = cooperative
  await vi.advanceTimersByTimeAsync(10_000)
  const settled = await Promise.allSettled(pending)
  expect(settled.filter((r) => r.status === 'rejected')).toEqual([])

  for (const c of commands) {
    const last = c.events.at(-1)
    const live = c.tree.liveLeaders()
    // Between actions a command rests in idle, running, exited, or failed; running ⇔ a live leader.
    expect(['running', 'exited', 'failed', undefined]).toContain(last?.status)
    if (last?.status === 'running') {
      expect(live.map((p) => p.pid)).toEqual([last.pid])
    } else {
      expect(live).toEqual([])
    }
    checkEvents(c.events)
  }

  const stops = commands.map((c) => supervisorOf(c).stop(c.id))
  await vi.advanceTimersByTimeAsync(10_000)
  for (const state of await Promise.all(stops)) expect(['idle', 'exited', 'failed']).toContain(state.status)
  for (const c of commands) {
    expect(c.tree.liveLeaders()).toEqual([])
    checkEvents(c.events)
  }
  return { actions: counts, runs: commands.reduce((n, c) => n + c.events.filter((e) => e.status === 'starting').length, 0) }
}

describe('supervisor hammer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  for (const seed of SEEDS) {
    it(`keeps the state machine invariants over ${ACTIONS} random actions (seed ${seed})`, async () => {
      const { actions, runs } = await hammer(seed)
      // The seed must exercise every kind of action and many runs, or the test proves little.
      for (const kind of ['start', 'stop', 'restart', 'exit', 'behavior', 'wait']) expect(actions[kind], kind).toBeGreaterThan(10)
      expect(runs).toBeGreaterThan(30)
    })
  }
})
