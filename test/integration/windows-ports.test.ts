import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { HELPER_PATH } from '../../scripts/build-windows-helper.mjs'
import { parsePortsOutput } from '../../src/main/platform/windows/protocol'
import { sleep } from '../support/proc'
import { creationTimes } from './support/windows'

// Windows port inspection through the real helper's `ports`, the supervisor and
// `createHelperPortsReader` (add-windows-port-inspection design D7). Group 4 implements the tagged
// cases, and the standard-user cases get their own `[windows-only: Windows accounts]` suite then.
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

  it.todo('[spec:port-inspection/command-port-shown-on-windows] attributes a command\'s and a grandchild\'s listeners to the command, with PID, name and creation time')
  it.todo('[spec:port-inspection/unmanaged-listener-on-windows] lists unmanaged listeners on 127.0.0.1 and ::1 with their PID and no command')
  it.todo('[spec:port-inspection/owner-hidden-from-a-standard-user-on-windows] shows a standard user the fixture\'s owner, and another listener\'s, as restricted')
  it.todo('[spec:port-inspection/windows-port-inspection-verified-natively] runs the helper\'s ports as a real standard user on the runner')
})
