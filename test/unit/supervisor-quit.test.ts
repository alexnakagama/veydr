import { describe, expect, it } from 'vitest'
import { ShuttingDownError } from '../../src/main/errors'
import type { LedgerEntry, ProcessIdentity } from '../../src/main/platform/types'
import type { RunLedger } from '../../src/main/supervisor/ledger'
import { createProcessStateRegistry } from '../../src/main/supervisor/state'
import { createSupervisor, type LaunchTarget } from '../../src/main/supervisor/supervisor'
import type { ProcessStateEvent } from '../../src/shared/api'
import type { CommandConfig } from '../../src/shared/config'
import { cooperative, FakeProcessTree } from './support/fake-process-tree'
import { command, project, quietLog } from './support/config'

// Tasks 5.1 and 5.4: the supervisor records runs in the ledger and stops everything on quit.

const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 5))

/** An in-memory ledger recording the calls the supervisor makes. */
class RecordingLedger implements Pick<RunLedger, 'add' | 'updateDescendants' | 'remove'> {
  readonly runs = new Map<string, LedgerEntry>()
  readonly calls: string[] = []
  /** Resolves the pending write of the next `add`; set to delay it. */
  writeDelay: Promise<void> = Promise.resolve()
  add(entry: LedgerEntry): Promise<void> {
    this.calls.push(`add ${entry.runId}`)
    this.runs.set(entry.runId, entry)
    return this.writeDelay
  }
  updateDescendants(runId: string, descendants: readonly ProcessIdentity[]): void {
    this.calls.push(`update ${runId}`)
    const entry = this.runs.get(runId)
    if (entry !== undefined) this.runs.set(runId, { ...entry, descendants })
  }
  remove(runId: string): void {
    this.calls.push(`remove ${runId}`)
    this.runs.delete(runId)
  }
}

function harness(commands: readonly Partial<CommandConfig>[] = [{}], options: { readonly plan?: () => Promise<void> } = {}) {
  const tree = new FakeProcessTree()
  const ledger = new RecordingLedger()
  const events: ProcessStateEvent[] = []
  const states = createProcessStateRegistry((event) => events.push(event))
  const configs = commands.map((c, i) => command({ name: `cmd${i}`, stopTimeoutMs: 1000 * (i + 1), ...c }))
  const proj = project({ commands: configs })
  const targets = new Map<string, LaunchTarget>(configs.map((c) => [c.id, { project: proj, command: c }]))
  const supervisor = createSupervisor({
    processTree: tree,
    states,
    lookup: (id) => targets.get(id) ?? null,
    plan: async (t) => {
      await options.plan?.()
      return { ok: true, plan: { file: t.command.name, args: [], cwd: t.project.path, env: {} } }
    },
    ledger,
    log: quietLog(),
  })
  return { tree, ledger, events, supervisor, ids: configs.map((c) => c.id) }
}

describe('supervisor and the run ledger', () => {
  it('records a started run with its leader identity and session, and forwards observed descendants', async () => {
    const h = harness()
    const [id = ''] = h.ids
    const state = await h.supervisor.start(id)
    const runId = state.runId ?? ''
    const leader = h.tree.last
    expect(h.ledger.runs.get(runId)).toEqual({ commandId: id, runId, leader: leader.identity, sessionId: leader.pid, descendants: [] })

    leader.observeDescendants([{ pid: 7, token: 'fake:7' }])
    expect(h.ledger.runs.get(runId)?.descendants).toEqual([{ pid: 7, token: 'fake:7' }])
  })

  it('records the run before it is reported running', async () => {
    const h = harness()
    const [id = ''] = h.ids
    let recordedWhenRunning = false
    h.events.push = (...events: ProcessStateEvent[]) => {
      for (const event of events) if (event.status === 'running') recordedWhenRunning = h.ledger.runs.has(event.runId)
      return Array.prototype.push.apply(h.events, events)
    }
    await h.supervisor.start(id)
    expect(recordedWhenRunning).toBe(true)
  })

  it('reports a run running only once its ledger write has completed', async () => {
    const h = harness()
    const [id = ''] = h.ids
    let written: () => void = () => undefined
    h.ledger.writeDelay = new Promise((done) => (written = done))
    const starting = h.supervisor.start(id)
    await settle()
    expect(h.tree.spawnCalls).toBe(1)
    expect(h.events.map((e) => e.status)).toEqual(['starting'])
    written()
    expect(await starting).toMatchObject({ status: 'running' })
  })

  it('removes a run once it ended with nothing left alive', async () => {
    const h = harness()
    const [id = ''] = h.ids
    const { runId } = await h.supervisor.start(id)
    await h.supervisor.stop(id)
    expect(h.ledger.calls).toEqual([`add ${runId}`, `remove ${runId}`])

    // Also after the leader exits on its own.
    const second = await h.supervisor.start(id)
    h.tree.last.exit(0)
    await settle()
    expect(h.ledger.runs.has(second.runId ?? '')).toBe(false)
  })

  it('keeps a run whose stop left survivors or could not be verified', async () => {
    const h = harness()
    const [id = ''] = h.ids
    h.tree.behavior = { ...cooperative, uncooperative: true, survivors: 1 }
    const first = await h.supervisor.start(id)
    expect(await h.supervisor.stop(id)).toMatchObject({ survivors: [expect.anything()] })
    expect(h.ledger.runs.has(first.runId ?? '')).toBe(true)

    h.tree.behavior = { ...cooperative, stopError: new Error('scan failed') }
    const second = await h.supervisor.start(id)
    expect(await h.supervisor.stop(id)).toMatchObject({ error: expect.stringContaining('scan failed') as unknown })
    expect(h.ledger.runs.has(second.runId ?? '')).toBe(true)
  })

  it('records nothing for a start that fails', async () => {
    const h = harness()
    h.tree.behavior = { ...cooperative, spawnError: new Error('nope') }
    await h.supervisor.start(h.ids[0] ?? '')
    expect(h.ledger.calls).toEqual([])
  })
})

describe('supervisor stop-all on quit', () => {
  it('stops every running command in parallel, each with its own stop timeout', async () => {
    const h = harness([{}, {}, {}])
    const [a = '', b = '', idle = ''] = h.ids
    await h.supervisor.start(a)
    await h.supervisor.start(b)
    h.tree.behavior = { ...cooperative, stopDelayMs: 50 }
    for (const p of h.tree.spawned) Object.assign(p, { behavior: { ...cooperative, stopDelayMs: 50 } })
    expect(h.supervisor.active()).toEqual([
      { commandId: a, graceMs: 1000 },
      { commandId: b, graceMs: 2000 },
    ])

    const started = Date.now()
    await h.supervisor.stopAll()
    // Parallel: two 50 ms stops take about 50 ms, not 100 ms.
    expect(Date.now() - started).toBeLessThan(95)
    expect(h.tree.spawned.map((p) => p.stopGraceMs)).toEqual([[1000], [2000]])
    expect(h.tree.liveLeaders()).toEqual([])
    expect(h.supervisor.active()).toEqual([])
    expect(h.ledger.runs.size).toBe(0)
    expect(h.events.filter((e) => e.commandId === idle)).toEqual([])
  })

  it('refuses starts and restarts once quitting has begun; stops still work', async () => {
    const h = harness()
    const [id = ''] = h.ids
    await h.supervisor.stopAll()
    await expect(h.supervisor.start(id)).rejects.toBeInstanceOf(ShuttingDownError)
    await expect(h.supervisor.restart(id)).rejects.toBeInstanceOf(ShuttingDownError)
    expect(await h.supervisor.stop(id)).toMatchObject({ status: 'idle' })
    expect(h.tree.spawnCalls).toBe(0)
  })

  it('counts a run that is still being planned as active, with its stop timeout', async () => {
    let release: () => void = () => undefined
    const h = harness([{}], { plan: () => new Promise((done) => (release = done)) })
    const [id = ''] = h.ids
    const starting = h.supervisor.start(id)
    await settle()
    expect(h.supervisor.active()).toEqual([{ commandId: id, graceMs: 1000 }])
    const stopping = h.supervisor.stopAll()
    // A start requested after quitting began is refused.
    await expect(h.supervisor.start(id)).rejects.toBeInstanceOf(ShuttingDownError)
    release()
    await starting
    await stopping
    expect(h.tree.spawnCalls).toBe(1)
    expect(h.tree.liveLeaders()).toEqual([])
    expect(h.supervisor.active()).toEqual([])
    expect(h.ledger.runs.size).toBe(0)
  })

  it('also stops a run whose start was requested just before quitting', async () => {
    const h = harness()
    const [id = ''] = h.ids
    h.tree.behavior = { ...cooperative, spawnDelayMs: 20 }
    const starting = h.supervisor.start(id)
    await h.supervisor.stopAll()
    await starting
    expect(h.tree.spawnCalls).toBe(1)
    expect(h.tree.liveLeaders()).toEqual([])
    expect(h.events.map((e) => e.status)).toEqual(['starting', 'running', 'stopping', 'exited'])
  })

  it('reports a run that could not be stopped as still active in the ledger', async () => {
    const h = harness()
    const [id = ''] = h.ids
    h.tree.behavior = { ...cooperative, uncooperative: true, survivors: 2 }
    await h.supervisor.start(id)
    await h.supervisor.stopAll()
    expect(h.events.at(-1)).toMatchObject({ status: 'exited', survivors: [expect.anything(), expect.anything()] })
    expect(h.ledger.runs.size).toBe(1)
  })
})
