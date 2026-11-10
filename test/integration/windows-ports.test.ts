import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { HELPER_PATH } from '../../scripts/build-windows-helper.mjs'
import { EXIT_ID, OUTPUT_ID } from '../../scripts/windows-probe/ports-standard-user.mjs'
import { withoutRuntimeVariables } from '../../src/main/platform/runtime-env'
import type { PortSnapshot } from '../../src/main/platform/types'
import { createHelperCheck, createHelperPortsReader } from '../../src/main/platform/windows/helper-tool'
import { createWindowsPortInspector } from '../../src/main/platform/windows/ports'
import { createWindowsProcessTree } from '../../src/main/platform/windows/process-tree'
import { parsePortsOutput } from '../../src/main/platform/windows/protocol'
import { createWindowsCommandResolver, systemCmdExe } from '../../src/main/platform/windows/resolver'
import { createPortService } from '../../src/main/ports/service'
import { createPlanner } from '../../src/main/supervisor/plan'
import { createProcessStateRegistry } from '../../src/main/supervisor/state'
import { createSupervisor, type LaunchTarget } from '../../src/main/supervisor/supervisor'
import type { CommandConfig } from '../../src/shared/config'
import { command, project, quietLog } from '../unit/support/config'
import { fixture, readLedger, scenario, sleep, TAG_VARIABLE, waitUntil, type LedgerEntry, type Scenario } from '../support/proc'
import { taggedProcesses } from '../support/processes'
import { creationTimes, powershell } from './support/windows'

// Windows port inspection through the real helper's `ports`, the supervisor and
// `createHelperPortsReader` (add-windows-port-inspection design D7): the raw helper (task 2.4), a
// command's and an unmanaged process's listeners, the latency with 1,000 sockets, and the restricted
// rule as a real standard user (task 4.2).
//
// The helper is built by `node scripts/build-windows-helper.mjs`, which the `windows` CI job runs
// first. A missing helper fails these tests; it never skips them.

/**
 * How old every fixture listener is before a listing (design D7), well past the helper's 20 ms fence
 * margin (design D1), so that a genuine holder is never reported as `reused`.
 */
const FIXTURE_AGE_MS = 100

/** The first line `child` prints; rejects if it exits or fails first, rather than waiting for the test timeout. */
function firstLine(child: ChildProcess, what: string): Promise<string> {
  const stdout = child.stdout
  if (stdout === null) return Promise.reject(new Error(`${what} has no stdout`))
  return new Promise((resolve, reject) => {
    createInterface({ input: stdout }).once('line', resolve)
    child.once('error', (error) => reject(new Error(`${what} could not start: ${error.message}`)))
    child.once('exit', (code, signal) => reject(new Error(`${what} exited (${String(code ?? signal)}) before it listened`)))
  })
}

/** A listener on 127.0.0.1 and ::1 in one process; prints `{"v4":<port>,"v6":<port>}` once both listen. */
const DUAL_LISTENER = `
const { createServer } = require('node:net')
const listen = (host) => new Promise((done, fail) => {
  const server = createServer((socket) => socket.destroy())
  server.once('error', fail)
  server.listen(0, host, () => done(server.address().port))
})
Promise.all([listen('127.0.0.1'), listen('::1')]).then(([v4, v6]) => process.stdout.write(JSON.stringify({ v4, v6 }) + '\\n'))
setInterval(() => {}, 1 << 30)
`

const runPorts = (...extra: string[]) => spawnSync(HELPER_PATH, ['ports', ...extra], { input: '', encoding: 'utf8', windowsHide: true, timeout: 30_000 })

describe.runIf(process.platform === 'win32')('[windows-only: the helper\'s TCP tables]', () => {
  const children: ChildProcess[] = []
  afterEach(() => {
    for (const child of children.splice(0)) child.kill()
  })

  it('lists a fixture\'s listeners on 127.0.0.1 and ::1, owned by its PID with its creation time (task 2.4)', async () => {
    const child = spawn(process.execPath, ['-e', DUAL_LISTENER], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
    children.push(child)
    const pid = child.pid
    if (pid === undefined) throw new Error('the listener fixture did not start')
    const { v4, v6 } = JSON.parse(await firstLine(child, 'the listener fixture')) as { v4: number; v6: number }
    // Read independently of the helper, with GetProcessTimes from PowerShell.
    const created = creationTimes([pid]).get(pid)
    if (created === undefined) throw new Error(`could not read the creation time of the listener fixture ${pid}`)
    await sleep(FIXTURE_AGE_MS)

    const run = runPorts()
    expect(run.error).toBeUndefined()
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    const listing = parsePortsOutput(run.stdout)
    expect(listing.listeners).toContainEqual({ family: 'ipv4', address: '7f000001', port: v4, pid })
    expect(listing.listeners).toContainEqual({ family: 'ipv6', address: `${'0'.repeat(31)}1`, port: v6, pid })
    const owners = listing.owners.filter((owner) => owner.pid === pid)
    expect(owners).toEqual([{ pid, state: 'known', created, image: expect.any(String) as string }])
    // Windows paths compare without case; the real path resolves a short (8.3) or linked node path.
    const image = owners[0]?.state === 'known' ? owners[0].image : ''
    expect(realpathSync.native(image).toLowerCase()).toBe(realpathSync.native(process.execPath).toLowerCase())
    // The fence was read after the fixture started.
    expect(BigInt(listing.takenAt)).toBeGreaterThan(BigInt(created))
  })

  it('reads nothing on stdin, and refuses arguments with a usage line and exit code 2', async () => {
    // stdin stays open: the helper must not wait for it.
    const child = spawn(HELPER_PATH, ['ports'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    children.push(child)
    const out: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    // 'close', not 'exit': stdout has then been read to its end.
    const [code] = (await once(child, 'close')) as [number | null]
    expect(code).toBe(0)
    expect(() => parsePortsOutput(Buffer.concat(out).toString('utf8'))).not.toThrow()

    for (const extra of [['extra'], ['--json'], ['']]) {
      const usage = runPorts(...extra)
      expect(usage.status, extra.join(' ')).toBe(2)
      expect(usage.stdout, extra.join(' ')).toBe('')
      expect(usage.stderr, extra.join(' ')).toContain('veydr-helper ports')
    }
  })

})

/** The name the Ports view shows for the Node executable running the fixtures: its file name, as on disk. */
const NODE_NAME = basename(realpathSync.native(process.execPath)).toLowerCase()

/** The listings of `port`, from the port service (`ListeningPort` of the shared API) or straight from the inspector. */
const at = <T extends { readonly port: number }>(ports: readonly T[], port: number | null | undefined): T[] => ports.filter((p) => p.port === port)

/** The inspector Veydr wires on Windows (task 5.1): the helper check shared with the process tree, and the reader that runs exactly `ports`. */
function shippedWiring() {
  const helperCheck = createHelperCheck(HELPER_PATH)
  const tree = createWindowsProcessTree({ helperPath: HELPER_PATH, helperCheck, log: quietLog() })
  const inspector = createWindowsPortInspector({ readPorts: createHelperPortsReader({ helperPath: HELPER_PATH, check: helperCheck }), log: quietLog() })
  return { tree, inspector }
}

describe.runIf(process.platform === 'win32')('[windows-only: Job Objects and the helper\'s TCP tables]', () => {
  const scenarios: Scenario[] = []
  afterEach(() => {
    for (const s of scenarios.splice(0)) s.cleanup()
  })
  const track = (): Scenario => {
    const s = scenario()
    scenarios.push(s)
    return s
  }

  /** A supervisor running one listener command (listen.mjs with `listenArgs`), and the port service over it. */
  function harness(s: Scenario, listenArgs: readonly string[]) {
    const { tree, inspector } = shippedWiring()
    const config: CommandConfig = command({
      stopTimeoutMs: 5_000,
      execution: { mode: 'direct', file: process.execPath, args: [fixture('listen'), '--ledger', s.ledger, ...listenArgs] },
      env: [{ key: TAG_VARIABLE, value: s.tag, secret: false }],
    })
    const target: LaunchTarget = { project: project({ path: s.dir, commands: [config] }), command: config }
    const supervisor = createSupervisor({
      processTree: tree,
      states: createProcessStateRegistry(() => undefined),
      lookup: (id) => (id === config.id ? target : null),
      plan: createPlanner({
        resolver: createWindowsCommandResolver({ cmdExe: systemCmdExe(process.env['SystemRoot']), log: quietLog() }),
        environment: { base: () => Promise.resolve({ env: withoutRuntimeVariables(process.env), warnings: [] }) },
        envNames: 'case-insensitive',
      }),
      log: quietLog(),
    })
    const ports = createPortService({ inspector, attribution: () => supervisor.attribution() })
    return { supervisor, ports, inspector, commandId: config.id }
  }

  /** The ledger entry of the fixture's process in `role`, once it listens, and once it is FIXTURE_AGE_MS old. */
  async function listening(s: Scenario, role = 'listener'): Promise<LedgerEntry> {
    await waitUntil(() => readLedger(s.ledger).some((e) => e.role === role), `${role} in ${s.ledger}`, 30_000)
    const entry = readLedger(s.ledger).find((e) => e.role === role)
    if (entry === undefined) throw new Error('unreachable')
    // The entry is written once the process listens, so it is at least this old from here on.
    await sleep(FIXTURE_AGE_MS)
    return entry
  }

  it('[spec:port-inspection/command-port-shown-on-windows] attributes a command\'s and a grandchild\'s listeners to the command, with PID, name and creation time', { timeout: 120_000 }, async () => {
    for (const depth of [0, 2]) {
      const s = track()
      const { supervisor, ports, inspector, commandId } = harness(s, ['--depth', String(depth)])
      const state = await supervisor.start(commandId)
      expect(state, JSON.stringify(state.error)).toMatchObject({ status: 'running' })
      const listener = await listening(s)
      if (depth === 0) {
        expect(listener.pid).toBe(state.pid)
      } else {
        // The listener is a grandchild of the command's process: its parent is the chain's last intermediate.
        const ledger = readLedger(s.ledger)
        const first = ledger.find((e) => e.role === 'intermediate-2')
        const second = ledger.find((e) => e.role === 'intermediate-1')
        expect(first?.pid).toBe(state.pid)
        expect(second?.ppid).toBe(first?.pid)
        expect(listener.ppid).toBe(second?.pid)
      }

      const shown = at((await ports.list()).ports, listener.port)
      expect(shown, `depth ${depth}`).toEqual([{ family: 'ipv4', address: '127.0.0.1', port: listener.port, owner: { kind: 'known', pid: listener.pid, name: expect.any(String) as string, commandId } }])
      const owner = shown[0]?.owner
      expect(owner?.kind === 'known' ? owner.name.toLowerCase() : null).toBe(NODE_NAME)
      // The identity the command was matched by: the PID with its creation time, read independently with GetProcessTimes.
      const created = creationTimes([listener.pid]).get(listener.pid)
      expect(created, `the creation time of ${listener.pid}`).toBeDefined()
      const holder = at((await inspector.list()).ports, listener.port)[0]?.owner
      expect(holder?.kind === 'known' ? holder.processes.map((p) => p.identity) : holder).toEqual([{ pid: listener.pid, token: created }])

      expect(await supervisor.stop(commandId)).toMatchObject({ status: 'exited', survivors: [] })
      expect(taggedProcesses(s.tag)).toEqual([])
      expect(at((await ports.list()).ports, listener.port)).toEqual([])
    }
  })

  it('[spec:port-inspection/unmanaged-listener-on-windows] lists unmanaged listeners on 127.0.0.1 and ::1 with their PID and name and no command', { timeout: 60_000 }, async () => {
    const s = track()
    const { ports } = harness(s, [])
    for (const [host, role] of [['127.0.0.1', 'v4'], ['::1', 'v6']] as const) {
      spawn(process.execPath, [fixture('listen'), '--ledger', s.ledger, '--host', host, '--role', role], { env: s.env, stdio: 'ignore', windowsHide: true })
    }
    const v4 = await listening(s, 'v4')
    const v6 = await listening(s, 'v6')

    const list = (await ports.list()).ports
    const expected = (family: 'ipv4' | 'ipv6', address: string, entry: LedgerEntry) => [{ family, address, port: entry.port, owner: { kind: 'known', pid: entry.pid, name: expect.any(String) as string, commandId: null } }]
    expect(at(list, v4.port)).toEqual(expected('ipv4', '127.0.0.1', v4))
    expect(at(list, v6.port)).toEqual(expected('ipv6', '::1', v6))
    for (const port of [...at(list, v4.port), ...at(list, v6.port)]) expect(port.owner.kind === 'known' ? port.owner.name.toLowerCase() : null).toBe(NODE_NAME)
  })

  it('lists 1,000 listening sockets of one process with a median under 500 ms, and prints the figures (design D7)', { timeout: 180_000 }, async () => {
    const s = track()
    const { supervisor, ports, inspector, commandId } = harness(s, ['--count', '1000'])
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
    const ownedBy = (snapshot: PortSnapshot) => snapshot.ports.filter((p) => own.has(p.port) && p.owner.kind === 'known' && p.owner.processes[0]?.identity.pid === listener.pid)
    // The first listing reads the helper's version and warms up the file system cache; the threshold
    // (the helper's start and both tables, design D3) applies to the median of the next seven.
    await ports.list()
    const inspectorTimes: number[] = []
    const serviceTimes: number[] = []
    for (let i = 0; i < 7; i++) {
      const scan = await time(() => inspector.list())
      inspectorTimes.push(scan.ms)
      expect(ownedBy(scan.result)).toHaveLength(1000)
      const listed = await time(() => ports.list())
      serviceTimes.push(listed.ms)
      expect(listed.result.ports.filter((p) => own.has(p.port) && p.owner.kind === 'known' && p.owner.commandId === commandId)).toHaveLength(1000)
    }
    const total = (await inspector.list()).ports.length
    console.info(
      `Windows port listing with ${total} listening sockets: inspector (helper start and both tables) median ${median(inspectorTimes).toFixed(1)} ms (${inspectorTimes.map((t) => t.toFixed(1)).join(', ')}); ` +
        `ports.list with attribution median ${median(serviceTimes).toFixed(1)} ms (${serviceTimes.map((t) => t.toFixed(1)).join(', ')})`,
    )
    expect(median(inspectorTimes)).toBeLessThan(500)

    expect(await supervisor.stop(commandId)).toMatchObject({ status: 'exited', survivors: [] })
    expect(taggedProcesses(s.tag)).toEqual([])
  })
})

// The restricted rule as a real standard user (design D7): W0's launcher creates a temporary local
// account, runs ports-standard-user.mjs as that account with the helper copied next to it, and
// removes the account whatever happens. It changes the machine's accounts, so it runs only in CI,
// where every failure of the launcher throws: the check fails rather than skips there.

const STANDARD_USER_ACCOUNT = 'veydr-probe'
/** The driver's own limit (-Timeout); the launcher's waits around it add at most a few minutes. */
const DRIVER_TIMEOUT_S = 180
/** Beyond every wait of the launcher, so it can always remove the account before this ends it. */
const LAUNCHER_TIMEOUT_MS = 540_000

interface ResultLine {
  readonly id: string
  readonly answer: 'yes' | 'no' | null
  readonly detail: string
  readonly data: Record<string, unknown>
}

/** Runs standard-user.ps1 with `args` and resolves with its exit code and output; ends it after LAUNCHER_TIMEOUT_MS. */
function runLauncher(args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const powershellExe = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = join(__dirname, '../../scripts/windows-probe/standard-user.ps1')
  return new Promise((resolve, reject) => {
    const child = spawn(powershellExe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    const timer = setTimeout(() => {
      spawnSync(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    }, LAUNCHER_TIMEOUT_MS)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`standard-user.ps1 could not start: ${error.message}`))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
  })
}

/**
 * Runs standard-user.ps1 -Cleanup if the account still exists, and throws, naming `earlier` (the
 * launch's own error, if any) too: the launcher must remove
 * the account whatever happens (-Cleanup also removes C:\\veydr-probe-std and stops the account's processes).
 */
function removeLeftoverAccount(earlier: unknown): void {
  if (powershell(`[bool](Get-LocalUser -Name '${STANDARD_USER_ACCOUNT}' -ErrorAction SilentlyContinue)`).trim() !== 'True') return
  const powershellExe = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = join(__dirname, '../../scripts/windows-probe/standard-user.ps1')
  const cleanup = spawnSync(powershellExe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Cleanup'], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  const before = earlier === undefined ? '' : `; before that, ${loggable(earlier instanceof Error ? earlier.message : JSON.stringify(earlier) ?? 'an unknown error')}`
  throw new Error(`standard-user.ps1 left the account ${STANDARD_USER_ACCOUNT} behind; -Cleanup exited with ${String(cleanup.status)}: ${loggable(`${cleanup.stdout}\n${cleanup.stderr}`)}${before}`)
}

/**
 * The launcher's output for the job log, without workflow commands: its first line masks the
 * account's password with `::add-mask::`, which must reach the runner itself, not this log, or the
 * password would be printed in clear.
 */
const loggable = (text: string): string =>
  text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('::'))
    .join('\n')
    .trim()

describe.runIf(process.platform === 'win32')('[windows-only: Windows accounts]', () => {
  const dirs: string[] = []
  const children: ChildProcess[] = []
  afterEach(() => {
    for (const child of children.splice(0)) child.kill()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it.skipIf(process.env['CI'] !== 'true')(
    '[spec:port-inspection/owner-hidden-from-a-standard-user-on-windows] [spec:port-inspection/windows-port-inspection-verified-natively] shows a standard user the owner of the runner\'s listener, and of another listener, as restricted',
    // The launcher's own limit, then -Cleanup if it left the account.
    { timeout: LAUNCHER_TIMEOUT_MS + 180_000 },
    async () => {
      expect(existsSync(HELPER_PATH), `${HELPER_PATH} (run node scripts/build-windows-helper.mjs)`).toBe(true)
      const dir = mkdtempSync(join(tmpdir(), 'veydr-ports-std-'))
      dirs.push(dir)
      // The launcher appends to an existing results file only, as windows-probe.yml's identity line creates it.
      const results = join(dir, 'results.jsonl')
      writeFileSync(results, '')

      // A listener of the runner's account, which the standard user may not query.
      const ledger = join(dir, 'ledger.jsonl')
      const child = spawn(process.execPath, [fixture('listen'), '--ledger', ledger, '--role', 'runner'], { stdio: 'ignore', windowsHide: true })
      children.push(child)
      await waitUntil(() => existsSync(ledger) && readLedger(ledger).some((e) => e.role === 'runner'), `the runner's listener in ${ledger}`, 30_000)
      const runner = readLedger(ledger).find((e) => e.role === 'runner')
      if (runner?.port === undefined || runner.port === null) throw new Error('the runner\'s listener recorded no port')
      await sleep(FIXTURE_AGE_MS)

      let launched: Awaited<ReturnType<typeof runLauncher>> | undefined
      let launchError: unknown
      try {
        launched = await runLauncher(['-Results', results, '-Timeout', String(DRIVER_TIMEOUT_S), '-Driver', 'ports-standard-user.mjs', '-Helper', HELPER_PATH])
      } catch (error) {
        launchError = error
      }
      // The launcher removes the account itself; one it left (it was ended at its timeout, or failed
      // to remove it) is removed here, and the test fails. ci.yml has no cleanup step of its own.
      removeLeftoverAccount(launchError)
      if (launched === undefined) throw launchError
      console.info(`standard-user.ps1 exited with ${String(launched.code)}:\n${loggable(launched.stdout)}\n${loggable(launched.stderr)}`)

      const lines = readFileSync(results, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as ResultLine)
      // The standard user could not be created or used: the driver answered every line with the reason.
      const unavailable = lines.find((line) => line.data['unavailable'] === true)
      if (unavailable !== undefined) throw new Error(loggable(`the standard user was unavailable: ${unavailable.detail}`))
      if (launched.code !== 0) throw new Error(`standard-user.ps1 failed (exit code ${String(launched.code)}): ${loggable(launched.stderr)}`)

      const byId = new Map(lines.map((line) => [line.id, line]))
      expect(lines.map((line) => line.id)).toEqual(['ctx-no-console', 'ctx-job', 'ctx-standard-user', EXIT_ID, OUTPUT_ID])
      // The control: the driver ran with a token outside Administrators, so a pass is not an administrator's.
      expect(byId.get('ctx-standard-user'), JSON.stringify(byId.get('ctx-standard-user'))).toMatchObject({ answer: 'yes', data: { administrators: 'absent', elevated: false } })
      expect(byId.get(EXIT_ID), JSON.stringify(byId.get(EXIT_ID))).toMatchObject({ answer: 'yes', data: { exitCode: 0 } })
      const output = byId.get(OUTPUT_ID)
      expect(output?.answer, JSON.stringify(output)).toBe('yes')
      const stdout = output?.data['stdout']
      if (typeof stdout !== 'string') throw new Error('the driver kept no stdout of the helper')

      const listed = (await createWindowsPortInspector({ readPorts: () => Promise.resolve(stdout) }).list()).ports
      expect(at(listed, runner.port)).toEqual([{ family: 'ipv4', address: '127.0.0.1', port: runner.port, owner: { kind: 'restricted' } }])
      const others = listed.filter((p) => p.port !== runner.port && p.owner.kind === 'restricted')
      expect(others.length, 'listeners of other accounts, such as system services').toBeGreaterThan(0)
      console.info(`as the standard user: ${listed.length} listening sockets, ${listed.filter((p) => p.owner.kind === 'restricted').length} restricted, ${listed.filter((p) => p.owner.kind === 'known').length} known`)
    },
  )
})
