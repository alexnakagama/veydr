import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLinuxProcessTree } from '../../src/main/platform/linux/process-tree'
import { createLinuxCommandResolver } from '../../src/main/platform/linux/resolver'
import { withoutRuntimeVariables } from '../../src/main/platform/runtime-env'
import { createPlanner } from '../../src/main/supervisor/plan'
import { createProcessStateRegistry } from '../../src/main/supervisor/state'
import { createSupervisor, type LaunchTarget, type OutputSink } from '../../src/main/supervisor/supervisor'
import type { ProcessStateEvent } from '../../src/shared/api'
import type { CommandConfig } from '../../src/shared/config'
import { command, project, quietLog } from '../unit/support/config'
import { fixture, scenario, TAG_VARIABLE, taggedProcesses, waitForLedger, waitUntil, type Scenario } from '../support/proc'

// The supervisor driving real Linux process trees through the interim planner.

const scenarios: Scenario[] = []
afterEach(() => {
  for (const s of scenarios.splice(0)) s.cleanup()
})

function track(): Scenario {
  const s = scenario()
  scenarios.push(s)
  return s
}

function harness(s: Scenario, cmd: Partial<CommandConfig>, output?: OutputSink) {
  const events: ProcessStateEvent[] = []
  const states = createProcessStateRegistry((event) => events.push(event))
  const config = command({ stopTimeoutMs: 2_000, ...cmd, env: [{ key: TAG_VARIABLE, value: s.tag, secret: false }, ...(cmd.env ?? [])] })
  const target: LaunchTarget = { project: project({ path: s.dir, commands: [config] }), command: config }
  const supervisor = createSupervisor({
    processTree: createLinuxProcessTree(),
    states,
    lookup: (id) => (id === config.id ? target : null),
    plan: createPlanner({
      resolver: createLinuxCommandResolver(),
      environment: { base: () => Promise.resolve({ env: withoutRuntimeVariables(process.env), warnings: [] }) },
      envNames: 'exact',
    }),
    log: quietLog(),
    ...(output === undefined ? {} : { output }),
  })
  return { supervisor, events, commandId: config.id }
}

const node = (script: string, args: readonly string[]): CommandConfig['execution'] => ({ mode: 'direct', file: process.execPath, args: [script, ...args] })

describe('supervisor on Linux', () => {
  it('[spec:process-supervision/start-a-command] starts the process in its working directory with its effective environment', async () => {
    const s = track()
    mkdirSync(join(s.dir, 'api'))
    const { supervisor, commandId } = harness(s, {
      cwd: 'api',
      execution: node(fixture('tree'), ['--ledger', join(s.dir, 'ledger.jsonl')]),
      env: [{ key: 'VEYDR_TEST_PORT', value: '4321', secret: false }],
    })
    const state = await supervisor.start(commandId)
    expect(state).toMatchObject({ status: 'running' })
    const [root] = await waitForLedger(s.ledger, 1)
    expect(root?.pid).toBe(state.pid)

    const pid = state.pid ?? 0
    expect(readlinkSync(`/proc/${pid}/cwd`)).toBe(join(s.dir, 'api'))
    const environ = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
    expect(environ).toContain('VEYDR_TEST_PORT=4321')
    expect(environ.filter((entry) => entry.startsWith('ELECTRON_'))).toEqual([])
    // Standard input is not connected (spec: output does not block processes).
    expect(readlinkSync(`/proc/${pid}/fd/0`)).toBe('/dev/null')

    expect(await supervisor.stop(commandId)).toMatchObject({ status: 'exited', exit: { signal: 'SIGTERM', forced: false }, survivors: [] })
    expect(taggedProcesses(s.tag)).toEqual([])
  })

  it('stops what an exited leader left behind and reports the leader exit code', async () => {
    const s = track()
    const { supervisor, events, commandId } = harness(s, {
      execution: node(fixture('tree'), ['--ledger', s.ledger, '--depth', '1', '--fanout', '2', '--exit-after', '300', '--exit-code', '7']),
    })
    await supervisor.start(commandId)
    await waitForLedger(s.ledger, 3)
    await waitUntil(() => events.at(-1)?.status === 'exited', 'exited state')
    expect(events.map((e) => e.status)).toEqual(['starting', 'running', 'stopping', 'exited'])
    expect(events.at(-1)).toMatchObject({ exit: { code: 7, signal: null, forced: false }, survivors: [] })
    expect(taggedProcesses(s.tag)).toEqual([])
  })

  it('reports a spawn error as failed with the reason', async () => {
    const s = track()
    const { supervisor, commandId } = harness(s, { execution: { mode: 'direct', file: 'veydr-no-such-executable', args: [] } })
    expect(await supervisor.start(commandId)).toMatchObject({
      status: 'failed',
      error: 'Executable not found: veydr-no-such-executable (searched PATH)',
      pid: null,
    })
  })

  it(
    '[spec:process-supervision/high-volume-output] keeps a producer at ≥ 80 % of its `| cat > /dev/null` throughput while the consumer is stalled',
    async () => {
      const s = track()
      const BYTES = 1024 * 1024 * 1024
      const TRIALS = 5
      const report = join(s.dir, 'report.json')
      const throughput = (): number => {
        const { bytes, ms } = JSON.parse(readFileSync(report, 'utf8')) as { bytes: number; ms: number }
        expect(bytes).toBe(BYTES)
        return bytes / ms
      }

      // A consumer that stopped taking output (e.g. a renderer that no longer acknowledges):
      // it holds a bounded number of chunks and never processes them.
      const held: Buffer[] = []
      let received = 0
      const stalled: OutputSink = {
        open: () => undefined,
        write: (_commandId, _runId, _stream, chunk) => {
          received += chunk.length
          if (held.length < 64) held.push(chunk)
        },
        close: () => undefined,
      }
      const { supervisor, events, commandId } = harness(s, { execution: node(fixture('flood'), ['--bytes', String(BYTES), '--report', report]) }, stalled)

      const baseline: number[] = []
      const veydr: number[] = []
      for (let trial = 0; trial < TRIALS; trial++) {
        const shell = spawn('/bin/sh', ['-c', `"$0" "$1" --bytes ${BYTES} --report "$2" | cat > /dev/null`, process.execPath, fixture('flood'), report], { stdio: 'ignore' })
        await new Promise((done) => shell.once('exit', done))
        baseline.push(throughput())

        received = 0
        const exitedBefore = events.filter((e) => e.status === 'exited').length
        await supervisor.start(commandId)
        await waitUntil(() => events.filter((e) => e.status === 'exited').length > exitedBefore, 'flood exit', 30_000)
        expect(events.at(-1)).toMatchObject({ exit: { code: 0 } })
        veydr.push(throughput())
        await waitUntil(() => received === BYTES, 'all output consumed')
      }

      const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0
      const ratio = median(veydr) / median(baseline)
      console.info(
        `[output-drain] baseline ${(median(baseline) / 1e6).toFixed(2)} GB/s, Veydr ${(median(veydr) / 1e6).toFixed(2)} GB/s, ratio ${ratio.toFixed(2)}`,
      )
      expect(ratio).toBeGreaterThanOrEqual(0.8)
    },
    120_000,
  )
})
