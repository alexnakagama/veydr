import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it } from 'vitest'
import { createLinuxCommandResolver } from '../../src/main/platform/linux/resolver'
import { createLinuxPortInspector } from '../../src/main/platform/linux/ports'
import { createProcReader } from '../../src/main/platform/linux/proc-reader'
import { createLinuxProcessTree } from '../../src/main/platform/linux/process-tree'
import { withoutRuntimeVariables } from '../../src/main/platform/runtime-env'
import { createPortService } from '../../src/main/ports/service'
import { createPlanner } from '../../src/main/supervisor/plan'
import { createProcessStateRegistry } from '../../src/main/supervisor/state'
import { createSupervisor, type LaunchTarget } from '../../src/main/supervisor/supervisor'
import type { ListeningPort } from '../../src/shared/api'
import type { CommandConfig } from '../../src/shared/config'
import { command, project, quietLog } from '../unit/support/config'
import { fixture, readProcess, REPETITIONS, scenario, TAG_VARIABLE, taggedProcesses, waitUntil, readLedger, type LedgerEntry, type Scenario } from '../support/proc'

// Tasks 8.2 and 8.4: port inspection against real sockets and real process trees.

const scenarios: Scenario[] = []
afterEach(() => {
  for (const s of scenarios.splice(0)) s.cleanup()
})

function track(): Scenario {
  const s = scenario()
  scenarios.push(s)
  return s
}

const proc = createProcReader()
const inspector = createLinuxPortInspector({ bootId: () => proc.bootId(), log: quietLog() })

/** A supervisor running one listener command, and the port service over it. */
function harness(s: Scenario, listenArgs: readonly string[]) {
  const config: CommandConfig = command({
    stopTimeoutMs: 2_000,
    execution: { mode: 'direct', file: process.execPath, args: [fixture('listen'), '--ledger', s.ledger, ...listenArgs] },
    env: [{ key: TAG_VARIABLE, value: s.tag, secret: false }],
  })
  const target: LaunchTarget = { project: project({ path: s.dir, commands: [config] }), command: config }
  const supervisor = createSupervisor({
    processTree: createLinuxProcessTree({ log: quietLog() }),
    states: createProcessStateRegistry(() => undefined),
    lookup: (id) => (id === config.id ? target : null),
    plan: createPlanner({
      resolver: createLinuxCommandResolver(),
      environment: { base: () => Promise.resolve({ env: withoutRuntimeVariables(process.env), warnings: [] }) },
      envNames: 'exact',
    }),
    log: quietLog(),
  })
  const ports = createPortService({ inspector, attribution: () => supervisor.attribution() })
  return { supervisor, ports, commandId: config.id }
}

/** Waits until the fixture's listening process has recorded its ports. */
async function listening(s: Scenario, role = 'listener'): Promise<LedgerEntry> {
  await waitUntil(() => readLedger(s.ledger).some((e) => e.role === role), `${role} in ${s.ledger}`)
  const entry = readLedger(s.ledger).find((e) => e.role === role)
  if (entry === undefined) throw new Error('unreachable')
  return entry
}

const at = (ports: readonly ListeningPort[], port: number | null | undefined): ListeningPort[] => ports.filter((p) => p.port === port)

describe('Linux port inspection', () => {
  it('[spec:port-inspection/port-opened-by-a-child-process] attributes a port opened by a grandchild to its command', async () => {
    for (let i = 0; i < REPETITIONS; i++) {
      const s = track()
      const { supervisor, ports, commandId } = harness(s, ['--depth', '2'])
      const state = await supervisor.start(commandId)
      const listener = await listening(s)
      // The listener is a grandchild of the command's leader.
      const parent = readProcess(listener.ppid)
      expect(parent?.ppid).toBe(state.pid)
      expect(listener.pid).not.toBe(state.pid)

      const shown = at((await ports.list()).ports, listener.port)
      expect(shown).toEqual([{ family: 'ipv4', address: '127.0.0.1', port: listener.port, owner: { kind: 'known', pid: listener.pid, name: 'node', commandId } }])

      expect(await supervisor.stop(commandId)).toMatchObject({ status: 'exited', survivors: [] })
      expect(taggedProcesses(s.tag)).toEqual([])
      expect(at((await ports.list()).ports, listener.port)).toEqual([])
    }
  })

  it('attributes a port of a descendant that started its own session while its parent was observed', async () => {
    const s = track()
    const { supervisor, ports, commandId } = harness(s, ['--depth', '2', '--escape'])
    await supervisor.start(commandId)
    const listener = await listening(s)
    expect(listener.sid).toBe(listener.pid)
    const shown = at((await ports.list()).ports, listener.port)
    expect(shown[0]?.owner).toEqual({ kind: 'known', pid: listener.pid, name: 'node', commandId })
    expect(await supervisor.stop(commandId)).toMatchObject({ status: 'exited', survivors: [] })
    expect(taggedProcesses(s.tag)).toEqual([])
  })

  it('[spec:port-inspection/unmanaged-listener-owned-by-user] lists listeners Veydr did not start, IPv4 and IPv6, with PID and name and no command', async () => {
    const s = track()
    const { ports } = harness(s, [])
    spawn(process.execPath, [fixture('listen'), '--ledger', s.ledger, '--role', 'v4'], { env: s.env, stdio: 'ignore' })
    const v4 = await listening(s, 'v4')
    const ipv6 = existsSync('/proc/net/tcp6')
    if (ipv6) spawn(process.execPath, [fixture('listen'), '--ledger', s.ledger, '--host', '::1', '--role', 'v6'], { env: s.env, stdio: 'ignore' })
    const v6 = ipv6 ? await listening(s, 'v6') : null

    const list = (await ports.list()).ports
    expect(at(list, v4.port)).toEqual([{ family: 'ipv4', address: '127.0.0.1', port: v4.port, owner: { kind: 'known', pid: v4.pid, name: 'node', commandId: null } }])
    if (v6 !== null) {
      expect(at(list, v6.port)).toEqual([{ family: 'ipv6', address: '::1', port: v6.port, owner: { kind: 'known', pid: v6.pid, name: 'node', commandId: null } }])
    }
  })

  it('marks listeners of other users as restricted (where this machine has any)', async () => {
    const uid = process.geteuid?.() ?? -1
    // Ports with a LISTEN socket of another user, read independently of Veydr's parser.
    const foreign = new Set<number>()
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
      if (!existsSync(file)) continue
      for (const line of readFileSync(file, 'utf8').split('\n').slice(1)) {
        const fields = line.trim().split(/\s+/)
        if (fields[3] === '0A' && Number(fields[7]) !== uid) foreign.add(Number.parseInt(fields[1]?.split(':')[1] ?? '', 16))
      }
    }
    const list = (await inspector.list()).ports
    for (const port of foreign) {
      // A port can have an own socket too (e.g. on another address); at least one is restricted.
      expect(list.filter((p) => p.port === port).map((p) => p.owner.kind), `port ${port}`).toContain('restricted')
    }
    // Recorded so a run on a machine without such listeners is visible in the output.
    console.info(`other users' listening ports on this machine: ${foreign.size === 0 ? 'none' : [...foreign].join(', ')}`)
  })
})

describe('Linux port inspection performance', () => {
  it('lists 1,000 listening sockets in under 100 ms (task 8.4)', async () => {
    const s = track()
    const { supervisor, ports, commandId } = harness(s, ['--count', '1000'])
    await supervisor.start(commandId)
    const listener = await listening(s)
    const own = new Set(listener.ports)
    expect(own.size).toBe(1000)

    const time = async <T>(run: () => Promise<T>): Promise<{ ms: number; result: T }> => {
      const started = performance.now()
      const result = await run()
      return { ms: performance.now() - started, result }
    }
    const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN
    // The first scan warms up file system caches and the JIT; the threshold (design: the port scan,
    // i.e. reading every socket and its holder) applies to the median of the next seven. The time
    // of `ports.list`, which also reads the attribution sets, is recorded alongside.
    await ports.list()
    const inspectorTimes: number[] = []
    const serviceTimes: number[] = []
    for (let i = 0; i < 7; i++) {
      const scan = await time(() => inspector.list())
      inspectorTimes.push(scan.ms)
      expect(scan.result.ports.filter((p) => own.has(p.port) && p.owner.kind === 'known' && p.owner.processes[0].identity.pid === listener.pid)).toHaveLength(1000)
      const listed = await time(() => ports.list())
      serviceTimes.push(listed.ms)
      expect(listed.result.ports.filter((p) => own.has(p.port) && p.owner.kind === 'known' && p.owner.commandId === commandId)).toHaveLength(1000)
    }
    const total = (await inspector.list()).ports.length
    console.info(
      `port scan with ${total} listening sockets: inspector median ${median(inspectorTimes).toFixed(1)} ms (${inspectorTimes.map((t) => t.toFixed(1)).join(', ')}); ` +
        `ports.list with attribution median ${median(serviceTimes).toFixed(1)} ms (${serviceTimes.map((t) => t.toFixed(1)).join(', ')})`,
    )
    expect(median(inspectorTimes)).toBeLessThan(100)

    expect(await supervisor.stop(commandId)).toMatchObject({ status: 'exited', survivors: [] })
  })
})
