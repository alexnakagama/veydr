import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createLinuxProcessTree } from '../../src/main/platform/linux/process-tree'
import type { ProcReader } from '../../src/main/platform/linux/proc-reader'
import type { ProcStat } from '../../src/main/platform/linux/procfs'
import type { ManagedProcess } from '../../src/main/platform/types'
import { quietLog } from './support/config'

// The Linux stop logic against a simulated /proc and `kill`: cases that real processes cannot
// produce on demand (unkillable processes, PID reuse between scan and signal, EPERM).

const LEADER = 500
const BOOT = 'fe842736-befd-4703-a9f6-ed979b5b00d3'

interface SimProcess extends ProcStat {
  /** Signals the process ignores (an unkillable process ignores SIGKILL too, e.g. state D). */
  ignores: Set<string>
  eperm?: boolean
}

class SimulatedSystem {
  readonly processes = new Map<number, SimProcess>()
  readonly signals: [number, string][] = []
  spawnCalls = 0
  /** Called right before `stat(pid)` returns, to model changes between scan and signal. */
  beforeStat: (pid: number) => void = () => undefined
  private readonly leaderPid: number | undefined = LEADER
  readonly child = Object.assign(new EventEmitter(), {
    pid: this.leaderPid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as string | null,
  })

  add(pid: number, fields: Partial<SimProcess> = {}): SimProcess {
    const process: SimProcess = {
      pid,
      comm: `p${pid}`,
      state: 'S',
      ppid: LEADER,
      pgrp: LEADER,
      session: LEADER,
      starttime: 1000 + pid,
      ignores: new Set(),
      ...fields,
    }
    this.processes.set(pid, process)
    return process
  }

  readonly proc: ProcReader = {
    bootId: () => BOOT,
    stat: (pid) => {
      this.beforeStat(pid)
      const p = this.processes.get(pid)
      return p === undefined ? null : { ...p }
    },
    commandLine: (pid) => (this.processes.has(pid) ? [`/usr/bin/p${pid}`, '--flag'] : []),
    scan: () => Promise.resolve([...this.processes.values()].map((p) => ({ ...p }))),
  }

  kill = (target: number, signal: NodeJS.Signals): void => {
    this.signals.push([target, signal])
    const targets = target < 0 ? [...this.processes.values()].filter((p) => p.pgrp === -target) : [this.processes.get(target)]
    if (targets.length === 0 || targets[0] === undefined) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    for (const p of targets) {
      if (p === undefined) continue
      if (p.eperm === true) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      if (p.ignores.has(signal)) continue
      this.die(p.pid, signal)
    }
  }

  die(pid: number, signal: string | null = null, code: number | null = null): void {
    this.processes.delete(pid)
    if (pid === LEADER) {
      // libuv reaps the leader on the event loop.
      setTimeout(() => {
        this.child.exitCode = code
        this.child.signalCode = signal
        this.child.emit('exit', code, signal)
      }, 0)
    }
  }

  async spawn(): Promise<ManagedProcess> {
    const tree = createLinuxProcessTree({
      proc: this.proc,
      kill: this.kill,
      spawnChild: () => {
        this.spawnCalls++
        return this.child as unknown as ChildProcess
      },
      pollIntervalMs: 1,
      killWaitMs: 20,
      scanIntervalMs: 60_000,
      log: quietLog(),
    })
    // The executable and directory are checked on the real file system before the (simulated) spawn.
    return tree.spawn({ file: process.execPath, args: [], cwd: '/', env: {} })
  }

  signalled(pid: number): string[] {
    return this.signals.filter(([target]) => target === pid).map(([, signal]) => signal)
  }
}

function system(): SimulatedSystem {
  const sim = new SimulatedSystem()
  sim.add(LEADER, { ppid: 1 })
  return sim
}

describe('Linux process tree stop logic (simulated /proc)', () => {
  it('[spec:process-supervision/process-could-not-be-terminated] lists processes alive after the forced stop with PID and command name', async () => {
    const sim = system()
    sim.add(501, { ignores: new Set(['SIGTERM', 'SIGKILL']) })
    const run = await sim.spawn()
    const result = await run.stop({ graceMs: 5 })
    expect(result).toEqual({ graceful: 'no', forced: true, survivors: [{ pid: 501, name: 'p501', commandLine: '/usr/bin/p501 --flag' }] })
  })

  it('identifies the leader by PID, start time, and boot ID', async () => {
    const sim = system()
    const run = await sim.spawn()
    expect(run.pid).toBe(LEADER)
    expect(run.identity).toEqual({ pid: LEADER, token: `${BOOT}:${1000 + LEADER}` })
  })

  it('reports observed descendants (not the leader) for the crash ledger whenever the set changes', async () => {
    const sim = system()
    sim.add(501)
    sim.add(600, { session: 600, pgrp: 600, ppid: 501 }) // left the session, linked by parent
    const run = await sim.spawn()
    expect(run.sessionId).toBe(LEADER)
    const reports: string[][] = []
    run.onDescendantsChange((descendants) => reports.push(descendants.map((d) => `${d.pid}=${d.token}`)))
    await run.remaining()
    expect(reports).toEqual([[`501=${BOOT}:1501`, `600=${BOOT}:1600`]])
    await run.remaining()
    expect(reports).toHaveLength(1)
    // A listener registered after the descendants were observed receives them too.
    const late: number[][] = []
    run.onDescendantsChange((descendants) => late.push(descendants.map((d) => d.pid)))
    await Promise.resolve()
    expect(late).toEqual([[501, 600]])
    sim.processes.delete(600)
    await run.remaining()
    expect(reports.at(-1)).toEqual([`501=${BOOT}:1501`])
  })

  it('reports the attribution set from a read made after the call, sharing one read between concurrent calls (ports, task 8.2)', async () => {
    const sim = system()
    sim.add(501)
    const run = await sim.spawn()
    await run.remaining()
    let scans = 0
    const scan = sim.proc.scan.bind(sim.proc)
    sim.proc.scan = () => {
      scans++
      return scan()
    }
    // Appears after the last observation: still attributed, because `attributed` reads /proc again.
    sim.add(700, { ppid: 501, session: 700, pgrp: 700 })
    const [first, second] = await Promise.all([run.attributed(), run.attributed()])
    expect(scans).toBe(1)
    expect(first).toEqual(second)
    expect(first?.map((identity) => `${identity.pid}=${identity.token}`).sort()).toEqual([`500=${BOOT}:1500`, `501=${BOOT}:1501`, `700=${BOOT}:1700`])

    // Gone or replaced processes are not attributed; the leader stays until it has exited.
    sim.processes.delete(501)
    sim.add(700, { ppid: 1, session: 700, pgrp: 700, starttime: 99_999 })
    expect((await run.attributed()).map((identity) => identity.pid)).toEqual([LEADER])
    sim.die(LEADER, null, 0)
    await new Promise((done) => setTimeout(done, 5))
    expect(await run.attributed()).toEqual([])
  })

  it('[spec:process-supervision/pid-reused-by-unrelated-process] never signals a tracked PID that now belongs to another process', async () => {
    const sim = system()
    sim.add(600, { session: 600, pgrp: 600 }) // a descendant that left the session; tracked through its parent link
    const run = await sim.spawn()
    await run.remaining()
    // It exits and an unrelated process gets its PID (different start time, unrelated parent).
    sim.processes.delete(600)
    sim.add(600, { session: 9, pgrp: 9, ppid: 1, starttime: 99_999 })
    await run.stop({ graceMs: 5 })
    expect(sim.signalled(600)).toEqual([])
    expect(sim.processes.has(600)).toBe(true)
  })

  it('re-verifies the start time immediately before each signal', async () => {
    const sim = system()
    sim.add(700, { pgrp: 700, ignores: new Set(['SIGTERM']) })
    const run = await sim.spawn()
    // Between the scan at stop start and the signal, the process exits and its PID is reused.
    sim.beforeStat = (pid) => {
      if (pid === 700 && sim.processes.get(700)?.starttime === 1700) {
        sim.processes.delete(700)
        sim.add(700, { session: 9, pgrp: 9, ppid: 1, starttime: 50_000 })
      }
    }
    await run.stop({ graceMs: 5 })
    expect(sim.signalled(700)).toEqual([])
  })

  it('signals the group and the unreaped leader once, and each other process once per signal', async () => {
    const sim = system()
    sim.add(501, { ignores: new Set(['SIGTERM']) })
    sim.add(502, { pgrp: 502, ignores: new Set(['SIGTERM']) })
    const run = await sim.spawn()
    sim.processes.get(LEADER)?.ignores.add('SIGTERM')
    expect(await run.stop({ graceMs: 20 })).toMatchObject({ graceful: 'no', forced: true, survivors: [] })
    expect(sim.signalled(-LEADER)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(sim.signalled(LEADER)).toEqual(['SIGTERM', 'SIGKILL'])
    // 501 is in the leader's group: the group SIGKILL ends it, so re-verification skips its own SIGKILL.
    expect(sim.signalled(501)).toEqual(['SIGTERM'])
    expect(sim.processes.has(501)).toBe(false)
    expect(sim.signalled(502)).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('sends the graceful signal to processes that appear during the stop', async () => {
    const sim = system()
    sim.processes.get(LEADER)?.ignores.add('SIGTERM')
    const run = await sim.spawn()
    let forked = false
    const originalScan = sim.proc.scan.bind(sim.proc)
    sim.proc.scan = () => {
      if (sim.signalled(LEADER).length > 0 && !forked) {
        forked = true
        sim.add(800, { pgrp: 800 })
      }
      return originalScan()
    }
    await run.stop({ graceMs: 50 })
    expect(sim.signalled(800)[0]).toBe('SIGTERM')
  })

  it('does not signal the group by ID after the leader was reaped unless a live member is known', async () => {
    const sim = system()
    sim.add(900, { pgrp: 900, session: LEADER })
    const run = await sim.spawn()
    const exited = new Promise((done) => run.onExit(done))
    sim.die(LEADER, null, 0)
    await exited
    await run.stop({ graceMs: 5 })
    expect(sim.signalled(-LEADER)).toEqual([])
    expect(sim.signalled(LEADER)).toEqual([])
    expect(sim.signalled(900)).toEqual(['SIGTERM'])
  })

  it('treats zombies as ended and ignores processes older than the leader or than their parent', async () => {
    const sim = system()
    sim.add(501, { state: 'Z' })
    sim.add(502, { starttime: 10 }) // in the session but older than the leader: not attributed
    sim.add(503, { session: 7, pgrp: 7, ppid: LEADER, starttime: 5 }) // "child" older than its parent: PID reuse
    const run = await sim.spawn()
    expect((await run.remaining()).map((p) => p.pid)).toEqual([LEADER])
    await run.stop({ graceMs: 5 })
    expect(sim.signalled(501)).toEqual([])
    expect(sim.signalled(502)).toEqual([])
    expect(sim.signalled(503)).toEqual([])
  })

  it('reports a process it is not permitted to signal as a survivor', async () => {
    const sim = system()
    sim.add(501, { pgrp: 501, eperm: true, comm: 'sudo' })
    const run = await sim.spawn()
    const result = await run.stop({ graceMs: 5 })
    expect(result.survivors.map((s) => s.pid)).toEqual([501])
  })

  it('calls exit listeners registered after the exit', async () => {
    const sim = system()
    const run = await sim.spawn()
    await run.stop({ graceMs: 5 })
    await new Promise((done) => setTimeout(done, 5))
    const info = await new Promise((done) => run.onExit(done))
    expect(info).toEqual({ code: null, signal: 'SIGTERM', forced: false })
  })

  it('refuses to manage a process whose identity cannot be read, and kills it', async () => {
    const sim = system()
    sim.processes.delete(LEADER)
    await expect(sim.spawn()).rejects.toMatchObject({ name: 'SpawnError', reason: 'other' })
    expect(sim.signals).toEqual([
      [-LEADER, 'SIGKILL'],
      [LEADER, 'SIGKILL'],
    ])
  })

  it('keeps stopping the known processes when /proc cannot be read, and reports them instead of claiming success', async () => {
    const sim = system()
    sim.add(501, { pgrp: 501, ignores: new Set(['SIGTERM']) })
    const run = await sim.spawn()
    await run.remaining()
    sim.proc.scan = () => Promise.reject(Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }))
    const result = await run.stop({ graceMs: 5 })
    expect(sim.signalled(501)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(sim.processes.has(501)).toBe(false)
    // The end could not be observed, so the last known process is reported, not a clean stop.
    expect(result).toMatchObject({ forced: true, survivors: [{ pid: 501, name: 'p501' }] })
    expect(await run.remaining()).toEqual([{ pid: 501, name: 'p501', commandLine: '' }])
  })

  it('ignores a scan that finishes after a newer one, so a just-observed escapee stays attributed', async () => {
    const sim = system()
    sim.add(600, { pgrp: 600 })
    const run = await sim.spawn()
    await run.remaining()

    // Scans resolve only when released, with the processes as they were when the scan started.
    const held: (() => void)[] = []
    const realScan = sim.proc.scan.bind(sim.proc)
    sim.proc.scan = () => {
      const snapshot = realScan()
      return new Promise((done) => held.push(() => done(snapshot)))
    }
    const older = run.remaining()
    sim.add(601, { ppid: 600, session: 601, pgrp: 601 }) // 600 forks a child that calls setsid
    const newer = run.remaining()
    held[1]?.()
    await newer
    held[0]?.() // the older scan, without 601, finishes last
    await older
    sim.proc.scan = realScan

    // The parent exits: only the earlier observation links 601 to the run.
    sim.processes.delete(600)
    const escapee = sim.processes.get(601)
    if (escapee !== undefined) sim.processes.set(601, { ...escapee, ppid: 1 })
    await run.stop({ graceMs: 5 })
    expect(sim.signalled(601)).toEqual(['SIGTERM'])
    expect(sim.processes.has(601)).toBe(false)
  })

  it('reads the boot ID before starting anything, so a failure leaves no process', async () => {
    const sim = system()
    sim.proc.bootId = () => {
      throw new Error('Unreadable boot ID in /proc/sys/kernel/random/boot_id')
    }
    await expect(sim.spawn()).rejects.toMatchObject({ name: 'SpawnError', reason: 'other', message: expect.stringContaining('boot ID') as unknown })
    expect(sim.spawnCalls).toBe(0)
  })

  it('does not remember a failed stop, so it can be retried', async () => {
    const sim = system()
    sim.add(501, { pgrp: 501, ignores: new Set(['SIGTERM', 'SIGKILL']) })
    const run = await sim.spawn()
    const realCommandLine = sim.proc.commandLine.bind(sim.proc)
    sim.proc.commandLine = () => {
      throw new Error('unexpected')
    }
    await expect(run.stop({ graceMs: 5 })).rejects.toThrow('unexpected')
    sim.proc.commandLine = realCommandLine
    expect((await run.stop({ graceMs: 5 })).survivors.map((p) => p.pid)).toEqual([501])
  })
})
