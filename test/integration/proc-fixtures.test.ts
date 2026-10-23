import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  fixture,
  isAlive,
  scenario,
  startSentinel,
  taggedProcesses,
  treeSize,
  waitForLedger,
  waitUntil,
  type Scenario,
} from '../support/proc'

// Self-test of the process fixtures (task 4.1): the ledger must list every process a fixture
// spawned, and the shapes the supervisor tests rely on (process groups, sessions) must be real.
const scenarios: Scenario[] = []
afterEach(() => {
  for (const s of scenarios.splice(0)) s.cleanup()
})

function track(): Scenario {
  const s = scenario()
  scenarios.push(s)
  return s
}

describe('process fixtures', () => {
  it('tree.mjs records every spawned process, including a setpgid child and a setsid escapee', async () => {
    const s = track()
    const depth = 2
    const fanout = 3
    spawn(process.execPath, [fixture('tree'), '--ledger', s.ledger, '--depth', String(depth), '--fanout', String(fanout), '--setpgid', '--escape'], {
      env: s.env,
      stdio: 'ignore',
      detached: true,
    })
    const entries = await waitForLedger(s.ledger, treeSize(depth, fanout))
    expect(entries).toHaveLength(13)
    expect(new Set(entries.map((e) => e.pid)).size).toBe(13)
    for (const entry of entries) expect(isAlive(entry.pid, entry.starttime), entry.role).toBe(true)

    // Independent enumeration finds exactly the ledger's processes, plus the bash that moved the
    // setpgid child into its own group.
    const ledgerPids = new Set(entries.map((e) => e.pid))
    const tagged = taggedProcesses(s.tag)
    const extra = tagged.filter((p) => !ledgerPids.has(p.pid))
    expect(extra).toHaveLength(1)
    expect(tagged.filter((p) => ledgerPids.has(p.pid))).toHaveLength(13)

    const root = entries.find((e) => e.role === 'root')
    const setpgid = entries.find((e) => e.role === 'root.0:setpgid')
    const escapee = entries.find((e) => e.role === 'root.1:setsid')
    expect(root).toMatchObject({ pgid: root?.pid, sid: root?.pid })
    // The setpgid child stays in the root's session but leads its own group.
    expect(setpgid).toMatchObject({ sid: root?.sid, pgid: setpgid?.pid })
    // The escapee (second child when --setpgid takes the first) leads a new session.
    expect(escapee).toMatchObject({ sid: escapee?.pid, pgid: escapee?.pid, ppid: root?.pid })
    expect(entries.filter((e) => e.role.startsWith('root.1:setsid.')).every((e) => e.sid === escapee?.pid)).toBe(true)
    // Grandchildren of the setpgid child inherit its group.
    expect(entries.filter((e) => e.role.startsWith('root.0:setpgid.')).every((e) => e.pgid === setpgid?.pid)).toBe(true)
  })

  it('tree.mjs --escape puts the first child in a new session', async () => {
    const s = track()
    spawn(process.execPath, [fixture('tree'), '--ledger', s.ledger, '--depth', '1', '--fanout', '2', '--escape'], {
      env: s.env,
      stdio: 'ignore',
      detached: true,
    })
    const entries = await waitForLedger(s.ledger, 3)
    const root = entries.find((e) => e.role === 'root')
    const escapee = entries.find((e) => e.role === 'root.0:setsid')
    expect(escapee).toMatchObject({ sid: escapee?.pid, pgid: escapee?.pid, ppid: root?.pid })
    expect(taggedProcesses(s.tag).map((p) => p.pid)).toEqual(entries.map((e) => e.pid).sort((a, b) => a - b))
  })

  it('tree.mjs --exit-after makes the root exit and leaves its descendants running', async () => {
    const s = track()
    const child = spawn(process.execPath, [fixture('tree'), '--ledger', s.ledger, '--depth', '1', '--fanout', '2', '--exit-after', '300', '--exit-code', '3'], {
      env: s.env,
      stdio: 'ignore',
      detached: true,
    })
    const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)))
    const entries = await waitForLedger(s.ledger, 3)
    expect(await exited).toBe(3)
    const children = entries.filter((e) => e.role !== 'root')
    expect(children.every((e) => isAlive(e.pid, e.starttime))).toBe(true)
  })

  it('escape.mjs leaves an orphaned escapee in its own session after the middle process exits', async () => {
    const s = track()
    spawn(process.execPath, [fixture('escape'), '--ledger', s.ledger, '--middle-exit-ms', '20'], { env: s.env, stdio: 'ignore', detached: true })
    const entries = await waitForLedger(s.ledger, 3)
    const leader = entries.find((e) => e.role === 'leader')
    const middle = entries.find((e) => e.role === 'middle')
    const escapee = entries.find((e) => e.role === 'escapee')
    // Its PPID is the middle process or, once that exited, a subreaper; so it is not asserted.
    expect(escapee).toMatchObject({ sid: escapee?.pid, pgid: escapee?.pid })
    await waitUntil(() => middle !== undefined && !isAlive(middle.pid, middle.starttime), 'middle exit')
    expect(isAlive(escapee?.pid ?? 0, escapee?.starttime ?? '')).toBe(true)
    expect(leader?.sid).not.toBe(escapee?.sid)
  })

  it('listen.mjs records the port it listens on', async () => {
    const s = track()
    spawn(process.execPath, [fixture('listen'), '--ledger', s.ledger], { env: s.env, stdio: 'ignore' })
    const [entry] = await waitForLedger(s.ledger, 1)
    expect(entry?.port).toBeGreaterThan(0)
  })

  it('flood.mjs reports the bytes it wrote', async () => {
    const s = track()
    const report = `${s.dir}/report.json`
    const child = spawn(process.execPath, [fixture('flood'), '--bytes', '1000000', '--report', report], { env: s.env, stdio: ['ignore', 'pipe', 'ignore'] })
    let received = 0
    child.stdout.on('data', (chunk: Buffer) => (received += chunk.length))
    await new Promise((done) => child.once('close', done))
    expect(received).toBe(1_000_000)
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({ bytes: 1_000_000 })
  })

  it('sentinel.mjs records catchable signals and survives them', async () => {
    const sentinel = await startSentinel()
    try {
      process.kill(sentinel.pid, 'SIGTERM')
      await waitUntil(() => sentinel.signals().length === 1, 'signal record')
      expect(sentinel.signals()).toEqual(['SIGTERM'])
      expect(sentinel.alive()).toBe(true)
    } finally {
      sentinel.stop()
    }
  })
})
