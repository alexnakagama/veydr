import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildAnswer, compilerPath, compilerVersion, helperReport, runHelperBuild } from '../../scripts/windows-probe/helper-build.mjs'
import { contextIds, windowsPowerShell } from '../../scripts/windows-probe/driver.mjs'
import { placeholderIds } from '../../scripts/windows-probe/placeholder.mjs'
import {
  type CtrlSend,
  type Member,
  allEndedAnswer,
  consoleWindowAnswer,
  ctrlCAnswer,
  descendantsOf,
  gracefulAnswer,
  libuvJobAnswer,
  reuseAnswer,
  runProcessTree,
  startHelper,
  survivors,
} from '../../scripts/windows-probe/process-tree.mjs'
import { WORKER, markerFile, readyFile, specFile, writeAtomic } from '../../scripts/windows-probe/tree-files.mjs'

// The parts of the process-tree and helper probes that can be checked anywhere: how measurements
// become answers, the helper's protocol, and the worker tree. What Windows does is measured by the
// windows-probe workflow; the Windows CI lane compiles and starts the C# below.

const root = join(__dirname, '../..')
const member = (name: string, pid: number): Member => ({ name, pid, created: `${pid}000` })
const row = (m: Member, overrides = {}) => ({ Pid: m.pid, Running: true, Created: m.created, Error: null, ...overrides })
const sent: CtrlSend = { Attached: true, AttachError: 0, Sent: true, SendError: 0 }

describe('process-tree answers', () => {
  it('counts a process as surviving only with the same PID and creation time', () => {
    const [a, b, c] = [member('a', 1), member('b', 2), member('c', 3)]
    expect(survivors([a, b, c], [row(a), row(b, { Running: false, Created: null }), row(c, { Created: 'another process' })])).toEqual([a])
    expect(() => survivors([a], [])).toThrow('no state for PID 1')
    expect(() => survivors([a], [row(a, { Error: 'Access is denied' })])).toThrow('cannot read PID 1: Access is denied')
    expect(survivors([a], [row(a, { Error: 'Access is denied' })], { tolerate: true })).toEqual([])
  })

  it('finds descendants through parent links, and survives a cycle of reused PIDs', () => {
    const processes = [{ Pid: 1, Parent: 9 }, { Pid: 2, Parent: 1 }, { Pid: 3, Parent: 2 }, { Pid: 4, Parent: 1 }, { Pid: 5, Parent: 7 }, { Pid: 9, Parent: 3 }]
    expect(descendantsOf(processes, 1).sort()).toEqual([1, 2, 3, 4, 9])
  })

  it('names what survived', () => {
    expect(allEndedAnswer([member('a', 1)], [], 'x').answer).toBe('yes')
    expect(allEndedAnswer([member('a', 1)], [member('a', 1)], 'taskkill')).toEqual({ answer: 'no', detail: 'still running after taskkill: a' })
  })

  it('tells libuv\'s job from the runner\'s by the processes in it', () => {
    const input = { childInJob: true, childPid: 2 }
    // As measured on the runner: libuv adds the spawning process to its job too.
    expect(libuvJobAnswer({ ...input, ownJob: { Pids: [1, 2, 3], LimitFlags: 0x3c00 } }).answer).toBe('yes')
    expect(libuvJobAnswer({ ...input, childInJob: false, ownJob: {} }).answer).toBe('no')
    expect(libuvJobAnswer({ ...input, ownJob: { Pids: [3], LimitFlags: 0x3c00 } }).answer).toBe('no')
    expect(libuvJobAnswer({ ...input, ownJob: { Pids: [1, 2], LimitFlags: 0x800 } }).answer).toBe('no')
    expect(libuvJobAnswer({ ...input, ownJob: { Pids: [2], LimitFlags: null, LimitsError: 'denied' } }).answer).toBeNull()
    expect(libuvJobAnswer({ ...input, ownJob: { Pids: null, PidsError: 'denied' } })).toMatchObject({ answer: null, detail: expect.stringContaining('denied') as string })
  })

  it('calls a stop graceful only with the marker, an empty tree and a live helper', () => {
    const good = { send: sent, marker: true, left: [], helperAlive: true, driverEvents: 0 }
    expect(gracefulAnswer(good)).toEqual({ answer: 'yes', detail: '' })
    expect(gracefulAnswer({ ...good, marker: false }).detail).toContain('no marker')
    expect(gracefulAnswer({ ...good, left: [member('cmd', 1)] }).detail).toContain('still running after 5 s: cmd')
    expect(gracefulAnswer({ ...good, helperAlive: false }).detail).toContain('helper did not survive')
    expect(gracefulAnswer({ ...good, send: null, helperAlive: false }).detail).toContain('the helper ended while sending the event')
    expect(gracefulAnswer({ ...good, driverEvents: 1 }).detail).toContain('the driver received 1 console events')
    // An unreadable process may still run, so it is never counted as ended; a seen failure still says no.
    expect(gracefulAnswer({ ...good, unknown: [member('cmd', 1)] })).toEqual({ answer: null, detail: 'could not tell whether these ended: cmd' })
    expect(gracefulAnswer({ ...good, marker: false, unknown: [member('cmd', 1)] }).answer).toBe('no')
    expect(gracefulAnswer({ ...good, marker: false, send: { ...sent, Attached: false, AttachError: 6 } }).detail).toContain('AttachConsole failed with error 6')
    expect(gracefulAnswer({ ...good, send: { ...sent, Sent: false, SendError: 5 } }).detail).toContain('GenerateConsoleCtrlEvent failed with error 5')
  })

  it('answers pt-ctrl-c only when the event reached the baseline', () => {
    expect(ctrlCAnswer({ baselineMarker: true, groupMarker: false, send: sent }).answer).toBe('yes')
    expect(ctrlCAnswer({ baselineMarker: true, groupMarker: true, send: sent }).answer).toBe('no')
    expect(ctrlCAnswer({ baselineMarker: false, groupMarker: false, send: sent }).answer).toBeNull()
    expect(ctrlCAnswer({ baselineMarker: true, groupMarker: false, send: { ...sent, Attached: false } }).answer).toBeNull()
  })

  it('answers pt-console-window only on a visible window station', () => {
    const hidden = { Attached: true, AttachError: 0, Visible: false }
    const shown = { ...hidden, Visible: true }
    const station = { Name: 'WinSta0', Visible: true }
    expect(consoleWindowAnswer({ station: { Name: 'Service-0x0', Visible: false }, hidden, shown }).answer).toBeNull()
    expect(consoleWindowAnswer({ station, hidden, shown }).answer).toBe('yes')
    expect(consoleWindowAnswer({ station, hidden: shown, shown }).answer).toBe('no')
    // Neither an attach that failed nor a session that shows no window at all is an observation.
    expect(consoleWindowAnswer({ station, hidden: { ...hidden, Attached: false, AttachError: 6 }, shown }).answer).toBeNull()
    expect(consoleWindowAnswer({ station, hidden, shown: hidden }).answer).toBeNull()
  })

  it('answers pt-identity-reuse from the creation times, or not at all', () => {
    const reuse = { Spawned: 10, ElapsedMs: 5, ReusedPid: 4, FirstCreated: '1', SecondCreated: '2' }
    expect(reuseAnswer(reuse).answer).toBe('yes')
    expect(reuseAnswer({ ...reuse, SecondCreated: '1' }).answer).toBe('no')
    expect(reuseAnswer({ ...reuse, ReusedPid: null }).answer).toBeNull()
  })
})

describe('helper-csc-build answers', () => {
  const ok = { code: 0, signal: null, stdout: '', stderr: '' }
  const good = { compile: ok, run: ok, report: { inJob: true }, tree: { a: 1 }, alive: [] }

  it('says yes only when every step worked', () => {
    expect(buildAnswer(good)).toEqual({ answer: 'yes', detail: '' })
    expect(buildAnswer({ ...good, compile: { ...ok, code: 1, stdout: 'error CS1002' } }).detail).toContain('error CS1002')
    expect(buildAnswer({ ...good, compile: { ...ok, code: null, error: 'csc.exe does not exist' } }).detail).toContain('does not exist')
    expect(buildAnswer({ ...good, run: { ...ok, code: 1, stderr: 'job-helper: denied' } }).detail).toContain('job-helper: denied')
    expect(buildAnswer({ ...good, report: { inJob: false } }).answer).toBe('no')
    expect(buildAnswer({ compile: ok, run: ok, tree: { a: 1 }, alive: [] }).answer).toBe('no')
    expect(buildAnswer({ compile: ok, run: ok, report: { inJob: true }, alive: [] }).answer).toBe('no')
    expect(buildAnswer({ ...good, alive: ['helper-grandchild'] }).detail).toContain('helper-grandchild')
  })

  it('reads the compiler\'s banner and the helper\'s report', () => {
    expect(compilerVersion('Microsoft (R) Visual C# Compiler version 4.8.9232.0\r\nfor C# 5\r\n')).toBe('4.8.9232.0')
    expect(compilerVersion('')).toBeNull()
    expect(helperReport('{"inJob":true,"childExitCode":1,"activeProcesses":0}\r\n')).toEqual({ inJob: true, childExitCode: 1, activeProcesses: 0 })
    expect(helperReport('nothing')).toBeUndefined()
    expect(compilerPath('C:\\Windows')).toContain('csc.exe')
  })
})

describe('drivers', () => {
  it('answer every check of their area for each account when the standard user is unavailable', async () => {
    for (const [area, run] of [['process-tree', runProcessTree], ['helper', runHelperBuild]] as const) {
      const lines: { id: string; answer: unknown }[] = []
      await run(['--user', 'standard', '--unavailable', 'no account'], { write: (line) => lines.push(JSON.parse(line) as { id: string; answer: unknown }) })
      expect(lines.map((l) => l.id)).toEqual([...contextIds('standard'), ...placeholderIds(area, 'standard')])
      expect(lines.every((l) => l.answer === null)).toBe(true)
      await expect(run(['extra', '--user', 'admin'])).rejects.toThrow('expected no positional arguments')
    }
  })

  it('run only the -std checks as the standard user', () => {
    expect(placeholderIds('process-tree', 'standard').sort()).toEqual([
      'pt-control-std',
      'pt-ctrl-break-attach-cmd-std',
      'pt-ctrl-break-attach-node-std',
      'pt-ctrl-break-attach-npm-std',
      'pt-job-terminate-std',
    ])
    expect(placeholderIds('helper', 'standard')).toEqual(['helper-csc-build-std'])
  })

  it('the process-tree driver names each of its checks in its source', () => {
    const source = readFileSync(join(root, 'scripts/windows-probe/process-tree.mjs'), 'utf8')
    for (const id of placeholderIds('process-tree', 'admin')) {
      const base = id.replace(/^pt-ctrl-break-attach-(node|npm|cmd)$/, 'pt-ctrl-break-attach-${child}').replace(/^(pt-control|pt-job-terminate)$/, '$1${suffix}')
      expect(source, id).toContain(base)
    }
  })
})

describe('helper protocol', () => {
  /** A stand-in for process-tree.ps1. */
  const fake = (body: string) => (): ChildProcess => spawn(process.execPath, ['-e', body], { stdio: ['pipe', 'pipe', 'pipe'] })
  const serve = `
    console.log(JSON.stringify({ ready: true }))
    require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const r = JSON.parse(line)
      if (r.op === 'die') process.exit(7)
      if (r.op === 'silent') return
      console.log(r.op === 'fail' ? JSON.stringify({ id: r.id, ok: false, error: 'Access is denied', code: 5 }) : JSON.stringify({ id: r.id, ok: true, result: r.value ?? null }))
    })`

  it('matches replies to requests and carries Win32 error codes', async () => {
    const helper = await startHelper({ start: fake(serve) })
    expect(await helper.request('echo', { value: 1 })).toBe(1)
    await expect(helper.request('fail')).rejects.toMatchObject({ message: 'Access is denied', code: 5 })
    expect(await helper.alivePing()).toBe(true)
    await helper.close()
  })

  it('times out a request, and rejects what is pending when the helper dies', async () => {
    const helper = await startHelper({ start: fake(serve) })
    await expect(helper.request('silent', {}, 50)).rejects.toThrow('did not answer silent')
    await expect(helper.request('die')).rejects.toThrow('the helper exited with 7')
    expect(helper.alive).toBe(false)
    expect(await helper.alivePing()).toBe(false)
    await helper.close()
  })

  it('reports a helper that cannot start', async () => {
    await expect(startHelper({ start: fake(`console.log(JSON.stringify({ ready: false, error: 'CS1002' }))`) })).rejects.toThrow('the helper failed to start: CS1002')
    await expect(startHelper({ start: fake('console.log("not json")') })).rejects.toThrow('its first line is not JSON')
    await expect(startHelper({ start: fake('process.exit(4)') })).rejects.toThrow('the helper exited with 4')
    await expect(startHelper({ start: fake('setTimeout(() => {}, 60000)'), timeoutMs: 100 })).rejects.toThrow('did not start within')
  })
})

describe('tree-worker.mjs', () => {
  const dirs: string[] = []
  const pids: number[] = []
  afterEach(() => {
    for (const pid of pids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const start = (spec: { name: string; [option: string]: unknown }): { dir: string; child: ChildProcess } => {
    const dir = mkdtempSync(join(tmpdir(), 'veydr-probe-worker-'))
    dirs.push(dir)
    const file = specFile(dir, spec.name)
    writeAtomic(file, JSON.stringify({ ...spec, dir }))
    const child = spawn(process.execPath, [WORKER, file], { stdio: 'ignore' })
    pids.push(child.pid as number)
    return { dir, child }
  }
  const waitFile = async (file: string): Promise<void> => {
    await expect.poll(() => existsSync(file), { timeout: 10_000, interval: 20 }).toBe(true)
  }
  const ready = (dir: string, name: string) => JSON.parse(readFileSync(readyFile(dir, name), 'utf8')) as { pid: number; children: Record<string, number> }

  it('starts its children after the gate, and is ready after them', async () => {
    const dir0 = mkdtempSync(join(tmpdir(), 'veydr-probe-gate-'))
    dirs.push(dir0)
    const gate = join(dir0, 'go')
    const { dir, child } = start({ name: 'leader', waitFor: gate, children: [{ name: 'child', children: [{ name: 'grandchild' }] }] })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(existsSync(readyFile(dir, 'child'))).toBe(false)
    writeAtomic(gate, '')
    await waitFile(readyFile(dir, 'leader'))
    const leader = ready(dir, 'leader')
    const middle = ready(dir, 'child')
    pids.push(middle.pid, middle.children['grandchild'] as number)
    expect(leader.pid).toBe(child.pid)
    expect(leader.children['child']).toBe(middle.pid)
    expect(ready(dir, 'grandchild').pid).toBe(middle.children['grandchild'])
  })

  it('leaves a detached child running when it exits after being ready', async () => {
    const { dir, child } = start({ name: 'bridge', exitAfterReady: true, children: [{ name: 'orphan', detached: true }] })
    const code = await new Promise((resolve) => child.once('exit', resolve))
    expect(code).toBe(0)
    const orphan = ready(dir, 'bridge').children['orphan'] as number
    pids.push(orphan)
    expect(() => process.kill(orphan, 0)).not.toThrow()
  })

  // On Windows child.kill() is TerminateProcess, which no handler sees; the probe sends real console events there.
  it.skipIf(process.platform !== 'linux')('[linux-only: POSIX signals] writes a marker and exits 0 on a signal it handles', async () => {
    const { dir, child } = start({ name: 'target', signals: true })
    await waitFile(readyFile(dir, 'target'))
    child.kill('SIGINT')
    const code = await new Promise((resolve) => child.once('exit', resolve))
    expect(code).toBe(0)
    expect(existsSync(markerFile(dir, 'target', 'int'))).toBe(true)
  })
})

// The C# compiles only on Windows: these catch a mistake on every pull request, without a probe run.
describe('on Windows', () => {
  it.skipIf(process.platform !== 'win32')('[windows-only: Windows PowerShell 5.1] process-tree.ps1 compiles and answers', { timeout: 180_000 }, async () => {
    const helper = await startHelper()
    expect(windowsPowerShell()).toContain('powershell.exe')
    const self = (await helper.request('inspect', { pids: [process.pid] })) as { Processes: { Pid: number; Running: boolean; Created: string }[] }
    expect(self.Processes[0]).toMatchObject({ Pid: process.pid, Running: true })
    const list = (await helper.request('snapshot')) as { Processes: { Pid: number }[] }
    expect(list.Processes.map((p) => p.Pid)).toContain(process.pid)
    const { job } = (await helper.request('create-job')) as { job: number }
    expect(job).toBeGreaterThan(0)
    expect(await helper.request('window-station')).toHaveProperty('Name')
    const log = join(mkdtempSync(join(tmpdir(), 'veydr-probe-events-')), 'events.log')
    await helper.request('ignore-console-events', { logFile: log })
    await helper.request('allow-ctrl-c')
    await expect(helper.request('in-job', { pid: 0, job: 99 })).rejects.toThrow()
    await helper.close()
  })

  it.skipIf(process.platform !== 'win32')('[windows-only: .NET Framework csc.exe] job-helper.cs compiles', { timeout: 120_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'veydr-probe-csc-'))
    try {
      const run = spawnSync(compilerPath(), ['/target:exe', `/out:${join(dir, 'job-helper.exe')}`, join(root, 'scripts/windows-probe/job-helper.cs')], { encoding: 'latin1', windowsHide: true })
      expect(run.status, run.stdout).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
