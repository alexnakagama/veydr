import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, rmdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { SpawnError } from '../../src/main/platform/errors'
import { createLinuxProcessTree, type LinuxProcessTreeOptions } from '../../src/main/platform/linux/process-tree'
import type { ExitInfo, ManagedProcess, SpawnPlan } from '../../src/main/platform/types'
import {
  fixture,
  isAlive,
  REPETITIONS,
  scenario,
  startSentinel,
  taggedProcesses,
  treeSize,
  waitForLedger,
  waitUntil,
  type Scenario,
  type Sentinel,
} from '../support/proc'

// Real process trees against the Linux implementation (tasks 4.5, 4.6). Every cleanup claim is
// checked by enumerating /proc independently (test/support/proc.ts), and a sentinel started
// outside the supervisor must survive every scenario untouched (design D14).

let sentinel: Sentinel
beforeAll(async () => {
  sentinel = await startSentinel()
})
afterAll(() => {
  sentinel.stop()
})

const scenarios: Scenario[] = []
afterEach(() => {
  for (const s of scenarios.splice(0)) s.cleanup()
  expect(sentinel.alive(), 'sentinel alive').toBe(true)
  expect(sentinel.signals(), 'signals received by the sentinel').toEqual([])
})

function track(): Scenario {
  const s = scenario()
  scenarios.push(s)
  return s
}

const nodePlan = (s: Scenario, script: string, args: readonly string[]): SpawnPlan => ({
  file: process.execPath,
  args: [script, '--ledger', s.ledger, ...args],
  cwd: s.dir,
  env: s.env,
})

const exitOf = (run: ManagedProcess): Promise<ExitInfo> => new Promise((done) => run.onExit(done))

async function spawnFailure(plan: SpawnPlan, options?: LinuxProcessTreeOptions): Promise<SpawnError> {
  const error: unknown = await createLinuxProcessTree(options).spawn(plan).then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(SpawnError)
  return error as SpawnError
}

/** Repeats a scenario `REPETITIONS` times (50 under VEYDR_STRESS=1), each with fresh processes. */
async function repeat(run: (s: Scenario, i: number) => Promise<void>): Promise<void> {
  for (let i = 0; i < REPETITIONS; i++) {
    const s = track()
    await run(s, i)
    // Zero leaks, by independent enumeration of everything that inherited the scenario's tag.
    expect(taggedProcesses(s.tag), `leaked processes (repetition ${i})`).toEqual([])
    s.cleanup()
  }
}

const timeout = (perRepetitionMs: number): number => 10_000 + REPETITIONS * perRepetitionMs

describe('Linux process tree: start failures', () => {
  it('[spec:process-supervision/spawn-error] reports a missing executable, a non-executable file, and a missing working directory', async () => {
    const s = track()
    const plan = (overrides: Partial<SpawnPlan>): SpawnPlan => ({ file: process.execPath, args: [], cwd: s.dir, env: s.env, ...overrides })

    const notOnPath = await spawnFailure(plan({ file: 'veydr-no-such-executable' }))
    expect(notOnPath).toMatchObject({ reason: 'executable-not-found', message: 'Executable not found: veydr-no-such-executable (searched PATH)' })

    const missingPath = join(s.dir, 'bin', 'missing')
    expect(await spawnFailure(plan({ file: missingPath }))).toMatchObject({ reason: 'executable-not-found', message: `Executable not found: ${missingPath}` })

    const notExecutable = join(s.dir, 'script.sh')
    writeFileSync(notExecutable, '#!/bin/sh\necho hi\n', { mode: 0o644 })
    expect(await spawnFailure(plan({ file: notExecutable }))).toMatchObject({
      reason: 'not-executable',
      message: `Permission denied: ${notExecutable} is not executable`,
    })

    const missingDir = join(s.dir, 'gone')
    expect(await spawnFailure(plan({ cwd: missingDir }))).toMatchObject({ reason: 'cwd-missing', message: `Working directory does not exist: ${missingDir}` })

    expect(await spawnFailure(plan({ cwd: notExecutable }))).toMatchObject({
      reason: 'cwd-not-directory',
      message: `Working directory is not a directory: ${notExecutable}`,
    })

    const locked = join(s.dir, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o000)
    try {
      expect(await spawnFailure(plan({ cwd: locked }))).toMatchObject({ reason: 'cwd-inaccessible' })
    } finally {
      chmodSync(locked, 0o700)
    }

    // A NUL byte is rejected by Node before any process exists.
    expect(await spawnFailure(plan({ args: ['a\0b'] }))).toMatchObject({ reason: 'other' })

    // No partial process remains after any of these.
    expect(taggedProcesses(s.tag)).toEqual([])
  })

  it('reports a directory that disappears between the check and the spawn as missing', async () => {
    const s = track()
    const cwd = join(s.dir, 'vanishing')
    mkdirSync(cwd)
    const failure = await spawnFailure(
      { file: process.execPath, args: [], cwd, env: s.env },
      {
        spawnChild: (file, args, options) => {
          // Remove the directory after the check, right before the real spawn.
          rmdirSync(cwd)
          return spawn(file, args, options)
        },
      },
    )
    expect(failure).toMatchObject({ reason: 'cwd-missing' })
  })
})

describe('Linux process tree: stop', () => {
  it(
    '[spec:process-supervision/cooperative-process] [spec:process-supervision/children-and-grandchildren-stopped] stops a cooperative tree gracefully',
    async () => {
      const tree = createLinuxProcessTree()
      await repeat(async (s) => {
        const run = await tree.spawn(nodePlan(s, fixture('tree'), ['--depth', '2', '--fanout', '2']))
        const exited = exitOf(run)
        const entries = await waitForLedger(s.ledger, treeSize(2, 2))
        expect(entries.find((e) => e.role === 'root')).toMatchObject({ pid: run.pid, pgid: run.pid, sid: run.pid })
        expect(run.identity).toEqual({ pid: run.pid, token: expect.stringMatching(/^[0-9a-f-]{36}:\d+$/) as unknown })

        const started = Date.now()
        const result = await run.stop({ graceMs: 5_000 })
        expect(result).toEqual({ graceful: 'yes', forced: false, survivors: [] })
        expect(Date.now() - started).toBeLessThan(5_000)
        expect(await exited).toEqual({ code: null, signal: 'SIGTERM', forced: false })
        for (const entry of entries) expect(isAlive(entry.pid, entry.starttime), entry.role).toBe(false)
      })
    },
    timeout(3_000),
  )

  it(
    '[spec:process-supervision/uncooperative-process] forces a tree that ignores SIGTERM after the stop timeout',
    async () => {
      const tree = createLinuxProcessTree()
      await repeat(async (s) => {
        const run = await tree.spawn(nodePlan(s, fixture('tree'), ['--depth', '2', '--fanout', '2', '--ignore-term']))
        const exited = exitOf(run)
        await waitForLedger(s.ledger, treeSize(2, 2))
        const started = Date.now()
        const result = await run.stop({ graceMs: 300 })
        expect(result).toEqual({ graceful: 'no', forced: true, survivors: [] })
        expect(Date.now() - started).toBeGreaterThanOrEqual(300)
        expect(await exited).toEqual({ code: null, signal: 'SIGKILL', forced: true })
      })
    },
    timeout(3_000),
  )

  it(
    'stops a descendant that moved to its own process group in the same session',
    async () => {
      const tree = createLinuxProcessTree()
      await repeat(async (s) => {
        const run = await tree.spawn(nodePlan(s, fixture('tree'), ['--depth', '2', '--fanout', '2', '--setpgid', '--ignore-term']))
        const entries = await waitForLedger(s.ledger, treeSize(2, 2))
        const moved = entries.filter((e) => e.role.startsWith('root.0:setpgid'))
        expect(moved.length).toBe(3)
        for (const entry of moved) expect(entry.pgid).not.toBe(run.pid)
        expect(await run.stop({ graceMs: 200 })).toMatchObject({ forced: true, survivors: [] })
      })
    },
    timeout(3_000),
  )

  it(
    '[spec:process-supervision/observed-escaped-descendant-stopped] stops an observed descendant that started a new session, after its parent exited',
    async () => {
      const tree = createLinuxProcessTree({ scanIntervalMs: 100 })
      await repeat(async (s) => {
        const run = await tree.spawn(nodePlan(s, fixture('escape'), ['--middle-exit-ms', '700']))
        const entries = await waitForLedger(s.ledger, 3)
        const middle = entries.find((e) => e.role === 'middle')
        const escapee = entries.find((e) => e.role === 'escapee')
        if (middle === undefined || escapee === undefined) throw new Error('fixture incomplete')
        expect(escapee.sid).not.toBe(run.pid)
        // The escapee is now an orphan in its own session; only the earlier observation links it to the run.
        await waitUntil(() => !isAlive(middle.pid, middle.starttime), 'middle exit')
        expect(await run.stop({ graceMs: 2_000 })).toEqual({ graceful: 'yes', forced: false, survivors: [] })
        expect(isAlive(escapee.pid, escapee.starttime)).toBe(false)
      })
    },
    timeout(3_000),
  )

  it(
    'stops a setsid child whose parent is still alive (found by the scan at stop start)',
    async () => {
      // The default 2 s scan interval: the stop-time scan must find the escapee by its parent link.
      const tree = createLinuxProcessTree()
      await repeat(async (s) => {
        const run = await tree.spawn(nodePlan(s, fixture('tree'), ['--depth', '2', '--fanout', '2', '--escape']))
        const entries = await waitForLedger(s.ledger, treeSize(2, 2))
        expect(entries.filter((e) => e.role.startsWith('root.0:setsid')).every((e) => e.sid !== run.pid)).toBe(true)
        expect(await run.stop({ graceMs: 2_000 })).toEqual({ graceful: 'yes', forced: false, survivors: [] })
      })
    },
    timeout(3_000),
  )

  it(
    'reports what a leader left behind after exiting on its own, and stops it',
    async () => {
      const tree = createLinuxProcessTree()
      await repeat(async (s) => {
        const run = await tree.spawn(nodePlan(s, fixture('tree'), ['--depth', '1', '--fanout', '2', '--exit-after', '200', '--exit-code', '4']))
        const entries = await waitForLedger(s.ledger, 3)
        expect(await exitOf(run)).toEqual({ code: 4, signal: null, forced: false })
        const left = await run.remaining()
        expect(left.map((p) => p.pid).sort()).toEqual(entries.filter((e) => e.role !== 'root').map((e) => e.pid).sort())
        expect(left.every((p) => p.name === 'node' && p.commandLine.includes('tree.mjs'))).toBe(true)
        expect(await run.stop({ graceMs: 2_000 })).toEqual({ graceful: 'yes', forced: false, survivors: [] })
        expect(await run.remaining()).toEqual([])
      })
    },
    timeout(3_000),
  )

  it('shares one stop between concurrent callers and reports a run that already ended as stopped', async () => {
    const s = track()
    const tree = createLinuxProcessTree()
    const run = await tree.spawn(nodePlan(s, fixture('tree'), ['--depth', '1', '--fanout', '1']))
    await waitForLedger(s.ledger, 2)
    const [a, b] = await Promise.all([run.stop({ graceMs: 2_000 }), run.stop({ graceMs: 2_000 })])
    expect(a).toBe(b)
    expect(await run.stop({ graceMs: 2_000 })).toEqual({ graceful: 'yes', forced: false, survivors: [] })
    expect(taggedProcesses(s.tag)).toEqual([])
  })
})
