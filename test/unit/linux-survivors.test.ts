import { describe, expect, it } from 'vitest'
import type { ProcReader } from '../../src/main/platform/linux/proc-reader'
import { linuxIdentity, parseLinuxIdentity } from '../../src/main/platform/linux/procfs'
import type { ProcStat } from '../../src/main/platform/linux/procfs'
import { createLinuxSurvivors } from '../../src/main/platform/linux/survivors'
import type { LedgerEntry, Survivor } from '../../src/main/platform/types'
import { quietLog } from './support/config'

// Task 5.2: finding and terminating survivors of a crashed session against a simulated /proc.
// Real processes are covered by test/integration/crash-recovery.test.ts.

const BOOT = 'fe842736-befd-4703-a9f6-ed979b5b00d3'
const OTHER_BOOT = '0a1b2c3d-0000-4000-8000-000000000000'
const SELF = 99

interface SimProcess extends ProcStat {
  ignores: Set<string>
  eperm?: boolean
}

class SimulatedSystem {
  readonly processes = new Map<number, SimProcess>()
  readonly signals: [number, string][] = []
  /** Runs when a process receives a signal it does not ignore, before it dies (e.g. to fork). */
  onSignal: (pid: number, signal: string) => void = () => undefined

  add(pid: number, fields: Partial<SimProcess> = {}): SimProcess {
    const p: SimProcess = { pid, comm: `p${pid}`, state: 'S', ppid: 1, pgrp: pid, session: pid, starttime: 1000 + pid, ignores: new Set(), ...fields }
    this.processes.set(pid, p)
    return p
  }

  readonly proc: ProcReader = {
    bootId: () => BOOT,
    stat: (pid) => {
      const p = this.processes.get(pid)
      return p === undefined ? null : { ...p }
    },
    commandLine: (pid) => (this.processes.has(pid) ? [`/usr/bin/p${pid}`, '--serve'] : []),
    scan: () => Promise.resolve([...this.processes.values()].map((p) => ({ ...p }))),
  }

  kill = (target: number, signal: NodeJS.Signals): void => {
    if (target <= 0) throw new Error(`group signal ${target}`)
    this.signals.push([target, signal])
    const p = this.processes.get(target)
    if (p === undefined) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    if (p.eperm === true) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    if (p.ignores.has(signal)) return
    this.onSignal(target, signal)
    this.processes.delete(target)
  }

  survivors(options: { graceMs?: number } = {}) {
    return createLinuxSurvivors({ proc: this.proc, kill: this.kill, graceMs: options.graceMs ?? 50, pollIntervalMs: 5, killWaitMs: 30, selfPid: SELF, log: quietLog() })
  }
}

const id = (pid: number, starttime: number, boot = BOOT) => linuxIdentity(boot, { pid, starttime })

function entry(fields: Partial<LedgerEntry> = {}): LedgerEntry {
  return { commandId: 'cmd', runId: 'run', leader: id(500, 1500), sessionId: 500, descendants: [], ...fields }
}

const pids = (survivors: readonly Survivor[]): number[] => survivors.map((s) => s.identity.pid).sort((a, b) => a - b)

describe.skipIf(process.platform !== 'linux')('[linux-only: /proc boot ID] Linux identity tokens', () => {
  it('round-trips boot ID and start time', () => {
    expect(parseLinuxIdentity(id(12, 345))).toEqual({ bootId: BOOT, starttime: 345 })
    expect(parseLinuxIdentity({ pid: 12, token: 'fake:12' })).toBeNull()
    expect(parseLinuxIdentity({ pid: 12, token: `${BOOT}:x` })).toBeNull()
  })
})

describe.skipIf(process.platform !== 'linux')('[linux-only: /proc] findSurvivors', () => {
  it('finds the recorded leader, recorded descendants, and live members of the recorded session', async () => {
    const sim = new SimulatedSystem()
    sim.add(500, { starttime: 1500 })
    sim.add(501, { ppid: 500, pgrp: 500, session: 500, starttime: 1501 })
    sim.add(502, { ppid: 501, pgrp: 502, session: 500, starttime: 1502 }) // changed group only
    sim.add(600, { ppid: 1, pgrp: 600, session: 600, starttime: 1600 }) // escaped (setsid), recorded
    sim.add(700) // unrelated
    const found = await sim.survivors().findSurvivors([entry({ descendants: [id(501, 1501), id(600, 1600)] })])
    expect(pids(found)).toEqual([500, 501, 502, 600])
    expect(found.find((s) => s.identity.pid === 600)).toEqual({
      commandId: 'cmd',
      runId: 'run',
      identity: id(600, 1600),
      info: { pid: 600, name: 'p600', commandLine: '/usr/bin/p600 --serve' },
    })
    expect(sim.signals).toEqual([])
  })

  it('[spec:process-supervision/stale-record-ignored] ignores a recorded PID that now belongs to a different process', async () => {
    const sim = new SimulatedSystem()
    sim.add(500, { starttime: 9999 }) // the leader's PID, reused
    sim.add(600, { starttime: 8888 }) // a descendant's PID, reused
    const found = await sim.survivors().findSurvivors([entry({ descendants: [id(600, 1600)] })])
    expect(found).toEqual([])
  })

  it('ignores the session when the leader PID was reused, since its session ID may have been reused too', async () => {
    const sim = new SimulatedSystem()
    sim.add(500, { starttime: 9999, session: 500 })
    sim.add(510, { ppid: 500, session: 500, starttime: 10_000 })
    expect(await sim.survivors().findSurvivors([entry()])).toEqual([])
  })

  it('keeps finding session members after the leader exited (the session ID cannot be reused while they live)', async () => {
    const sim = new SimulatedSystem()
    sim.add(510, { ppid: 1, pgrp: 500, session: 500, starttime: 1510 })
    sim.add(511, { ppid: 1, pgrp: 500, session: 500, starttime: 1400 }) // older than the leader: not ours
    expect(pids(await sim.survivors().findSurvivors([entry()]))).toEqual([510])
  })

  it('finds nothing of runs recorded during another boot', async () => {
    const sim = new SimulatedSystem()
    sim.add(500, { starttime: 1500 })
    sim.add(501, { session: 500, starttime: 1501 })
    expect(await sim.survivors().findSurvivors([entry({ leader: id(500, 1500, OTHER_BOOT), descendants: [id(501, 1501, OTHER_BOOT)] })])).toEqual([])
  })

  it('ignores zombies, itself, and identities of another boot inside a current entry', async () => {
    const sim = new SimulatedSystem()
    sim.add(500, { starttime: 1500, state: 'Z' })
    sim.add(501, { session: 500, starttime: 1501, state: 'Z' })
    sim.add(SELF, { session: 500, starttime: 1600 })
    sim.add(601, { starttime: 1601 })
    expect(await sim.survivors().findSurvivors([entry({ descendants: [id(601, 1601, OTHER_BOOT)] })])).toEqual([])
  })

  it('reports a process once even if several entries name it', async () => {
    const sim = new SimulatedSystem()
    sim.add(500, { starttime: 1500 })
    const found = await sim.survivors().findSurvivors([entry(), entry({ runId: 'run2', descendants: [id(500, 1500)] })])
    expect(found.map((s) => [s.identity.pid, s.runId])).toEqual([[500, 'run']])
  })

  it('does not read /proc for an empty ledger', async () => {
    const sim = new SimulatedSystem()
    sim.proc.scan = () => Promise.reject(new Error('must not scan'))
    expect(await sim.survivors().findSurvivors([])).toEqual([])
  })
})

describe.skipIf(process.platform !== 'linux')('[linux-only: /proc, POSIX signals] terminateSurvivors', () => {
  const survivor = (pid: number, starttime: number): Survivor => ({
    commandId: 'cmd',
    runId: 'run',
    identity: id(pid, starttime),
    info: { pid, name: `p${pid}`, commandLine: '' },
  })

  it('ends cooperative survivors with SIGTERM, signalling each process individually', async () => {
    const sim = new SimulatedSystem()
    sim.add(500, { starttime: 1500 })
    sim.add(501, { starttime: 1501 })
    expect(await sim.survivors().terminateSurvivors([survivor(500, 1500), survivor(501, 1501)])).toEqual({ graceful: 'yes', forced: false, survivors: [] })
    expect(sim.signals).toEqual([
      [500, 'SIGTERM'],
      [501, 'SIGTERM'],
    ])
  })

  it('forces survivors that ignore SIGTERM and reports what is still alive with name and command line', async () => {
    const sim = new SimulatedSystem()
    sim.add(500, { starttime: 1500, ignores: new Set(['SIGTERM']) })
    sim.add(501, { starttime: 1501, ignores: new Set(['SIGTERM', 'SIGKILL']) })
    const result = await sim.survivors().terminateSurvivors([survivor(500, 1500), survivor(501, 1501)])
    expect(result).toEqual({ graceful: 'no', forced: true, survivors: [{ pid: 501, name: 'p501', commandLine: '/usr/bin/p501 --serve' }] })
    expect(sim.signals.filter(([, s]) => s === 'SIGKILL').map(([pid]) => pid)).toEqual([500, 501])
  })

  it('never signals a survivor whose PID now belongs to another process', async () => {
    const sim = new SimulatedSystem()
    sim.add(500, { starttime: 7777 })
    expect(await sim.survivors().terminateSurvivors([survivor(500, 1500)])).toEqual({ graceful: 'yes', forced: false, survivors: [] })
    expect(sim.signals).toEqual([])
  })

  it('also ends children a survivor starts while it is being terminated', async () => {
    const sim = new SimulatedSystem()
    sim.add(500, { starttime: 1500, ignores: new Set(['SIGTERM']) })
    sim.add(510, { ppid: 500, starttime: 1510, ignores: new Set(['SIGTERM']) })
    sim.add(800, { ppid: 1, starttime: 1800 }) // unrelated
    const result = await sim.survivors().terminateSurvivors([survivor(500, 1500)])
    expect(result).toMatchObject({ forced: true, survivors: [] })
    expect(sim.signals.map(([pid]) => pid)).not.toContain(800)
    expect(sim.signals).toContainEqual([510, 'SIGKILL'])
  })

  it('does not adopt children of a process that reused a survivor’s PID', async () => {
    const sim = new SimulatedSystem()
    sim.add(500, { starttime: 1500 })
    sim.onSignal = (pid) => {
      if (pid !== 500) return
      // The survivor ends; its PID is reused at once by an unrelated process with a child.
      queueMicrotask(() => {
        sim.add(500, { starttime: 5000 })
        sim.add(520, { ppid: 500, starttime: 5001 })
      })
    }
    await sim.survivors({ graceMs: 20 }).terminateSurvivors([survivor(500, 1500)])
    expect(sim.signals).toEqual([[500, 'SIGTERM']])
  })

  it('reports a survivor it may not signal (EPERM)', async () => {
    const sim = new SimulatedSystem()
    sim.add(500, { starttime: 1500, eperm: true })
    expect(await sim.survivors().terminateSurvivors([survivor(500, 1500)])).toMatchObject({ forced: true, survivors: [{ pid: 500 }] })
  })

  it('ignores survivors of another boot and never signals itself', async () => {
    const sim = new SimulatedSystem()
    sim.add(SELF, { starttime: 1099 })
    sim.add(500, { starttime: 1500 })
    const other: Survivor = { ...survivor(500, 1500), identity: id(500, 1500, OTHER_BOOT) }
    expect(await sim.survivors().terminateSurvivors([survivor(SELF, 1099), other])).toEqual({ graceful: 'yes', forced: false, survivors: [] })
    expect(sim.signals).toEqual([])
  })
})
