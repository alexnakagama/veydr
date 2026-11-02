import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type ContextMeasurement, type ProgramResult, contextIds, runProgram, system32, windowsPowerShell } from '../../scripts/windows-probe/driver.mjs'
import { placeholderIds } from '../../scripts/windows-probe/placeholder.mjs'
import { type Owner, type PortsResult, LATENCY_CALLS, LISTEN_ADDRESSES, controlAnswer, latencyAnswer, listenerAnswer, median, netstatListing, ownerAnswer, parseNetstat, portAnswers, portsResult, runPorts, startListener, unreadableOwners } from '../../scripts/windows-probe/ports.mjs'

// The parts of the port probes that can be checked anywhere: how measurements become answers, the
// listener, and how the driver is wired. What Windows reports is measured by the windows-probe
// workflow; the Windows CI lane runs ports.ps1 below.

const probeDir = join(__dirname, '../../scripts/windows-probe')
const ran = (overrides: Partial<ProgramResult> = {}): ProgramResult => ({ code: 0, signal: null, stdout: '', stderr: '', ...overrides })
const helperPid = 4242
const listeners = [{ address: '127.0.0.1', port: 50001 }, { address: '::1', port: 50002 }, { address: '0.0.0.0', port: 50003 }]
const rows = listeners.map((l) => ({ ...l, pid: helperPid }))
const owner = (overrides: Partial<Owner> = {}): Owner => ({ Pid: helperPid, Name: 'node', NameError: null, Created: '133', CreatedError: null, Gone: false, ...overrides })
const durations = (ms: number): number[] => Array.from({ length: LATENCY_CALLS }, () => ms)

describe('netstat output', () => {
  const output = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       940',
    '  TCP    127.0.0.1:50001        0.0.0.0:0              LISTENING       4242',
    '  TCP    10.1.0.4:50100         20.1.2.3:443           ESTABLISHED     77',
    '  TCP    [::]:135               [::]:0                 LISTENING       940',
    '  TCP    [::1]:50002            [::]:0                 ABHÖREN         4242',
    '  TCP    [fe80::1%4]:5357       [::]:0                 LISTENING       4',
    '  UDP    0.0.0.0:123            *:*                                    1200',
    '',
  ].join('\r\n')

  it('finds listening sockets by their wildcard remote address, whatever the state is called', () => {
    expect(parseNetstat(output)).toEqual([
      { address: '0.0.0.0', port: 135, pid: 940 },
      { address: '127.0.0.1', port: 50001, pid: 4242 },
      { address: '::', port: 135, pid: 940 },
      { address: '::1', port: 50002, pid: 4242 },
      { address: 'fe80::1%4', port: 5357, pid: 4 },
    ])
  })

  it('gives no listing for a netstat that failed', () => {
    expect(netstatListing(ran({ stdout: output }))).toHaveProperty('rows')
    expect(netstatListing(ran({ code: null, error: 'spawn ENOENT' }))).toEqual({ error: 'the command did not start: spawn ENOENT' })
    expect(netstatListing(ran({ code: null, signal: 'SIGTERM' }))).toEqual({ error: 'the command did not finish within 60 s' })
    expect(netstatListing(ran({ code: 1, stderr: 'bad' }))).toEqual({ error: 'netstat exited with 1: bad' })
  })
})

describe('port answers', () => {
  const answer = (listing: Parameters<typeof listenerAnswer>[0]['listing']) => listenerAnswer({ method: 'm', listing, listeners, helperPid })

  it('wants every listener on its address, port and PID', () => {
    expect(answer({ rows })).toEqual({ answer: 'yes', detail: '' })
    expect(answer({ rows: rows.slice(0, 2) })).toEqual({ answer: 'no', detail: 'm does not list 0.0.0.0 port 50003 with PID 4242' })
    expect(answer({ rows: rows.map((r) => ({ ...r, pid: 1 })) }).answer).toBe('no')
    expect(answer({ rows: rows.map((r) => ({ ...r, port: r.port + 1 })) }).answer).toBe('no')
    expect(answer({ rows: rows.map((r) => ({ ...r, address: '10.0.0.1' })) }).answer).toBe('no')
    expect(answer({ error: 'broken' })).toEqual({ answer: null, detail: 'm: broken' })
    // Spelled as the sources spell it.
    expect(listenerAnswer({ method: 'm', listing: { rows: [{ address: '[::1]', port: 1, pid: 1 }] }, listeners: [{ address: '::1', port: 1 }], helperPid: 1 }).answer).toBe('yes')
  })

  it('passes the control if one method finds the listeners, and tells a miss from no measurement', () => {
    const [yes, no, none] = [{ answer: 'yes', detail: '' }, { answer: 'no', detail: 'missed' }, { answer: null, detail: 'broken' }] as const
    expect(controlAnswer({ a: no, b: yes, c: none }).answer).toBe('yes')
    expect(controlAnswer({ a: no, b: none })).toEqual({ answer: 'no', detail: 'missed; broken' })
    expect(controlAnswer({ a: none, b: none })).toEqual({ answer: null, detail: 'broken; broken' })
  })

  it('takes the median of an even and an odd count', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([3, 1, 2])).toBe(2)
  })

  it('holds latency to both limits, inclusively', () => {
    const listing = (durationsMs: number[]) => ({ durationsMs, rows })
    expect(latencyAnswer(listing(durations(300))).answer).toBe('yes')
    expect(latencyAnswer(listing([...durations(1).slice(1), 1000])).answer).toBe('yes')
    expect(latencyAnswer(listing(durations(300.5)))).toEqual({ answer: 'no', detail: 'the median is 300.5 ms and the slowest 300.5 ms' })
    expect(latencyAnswer(listing([...durations(1).slice(1), 1000.5])).answer).toBe('no')
    expect(latencyAnswer(listing(durations(1).slice(1))).answer).toBeNull()
    expect(latencyAnswer({ error: 'broken' })).toEqual({ answer: null, detail: 'broken' })
  })

  it('wants every owner read, not counting one that ended', () => {
    const blocked = owner({ Pid: 4, Name: 'System', Created: null, CreatedError: 'Access is denied' })
    const gone = owner({ Pid: 9, Name: null, NameError: 'not running', Created: null, CreatedError: 'bad', Gone: true })
    expect(ownerAnswer({ section: { rows: [owner(), gone] }, helperPid })).toEqual({ answer: 'yes', detail: '' })
    expect(ownerAnswer({ section: { rows: [owner(), blocked] }, helperPid })).toEqual({ answer: 'no', detail: '1 of 2 owners could not be read: PID 4 (System)' })
    expect(unreadableOwners([owner(), blocked, gone])).toEqual([{ pid: 4, name: 'System', createdError: 'Access is denied' }])
    expect(ownerAnswer({ section: { rows: [owner({ Name: null, NameError: 'x' })] }, helperPid }).answer).toBe('no')
    expect(ownerAnswer({ section: { rows: [blocked] }, helperPid }).answer).toBeNull()
    expect(ownerAnswer({ section: { error: 'broken' }, helperPid })).toEqual({ answer: null, detail: 'broken' })
  })

  it('reads ports.ps1\'s output, keeping each section apart', () => {
    const good = { durationsMs: [1.5], rows }
    const owners = { rows: [owner()] }
    const text = (value: unknown): string => JSON.stringify(value)
    expect(portsResult({ fileText: `﻿${text({ ps: good, api: good, owners })}`, run: ran() })).toEqual({ ps: good, api: good, owners })
    expect(portsResult({ fileText: text({ ps: { error: 'no CIM' }, api: good, owners }), run: ran() }).ps).toEqual({ error: 'no CIM' })
    for (const bad of [{ durationsMs: 'x', rows }, { durationsMs: [1], rows: [{ address: 1, port: 1, pid: 1 }] }, { durationsMs: [null], rows }, null]) {
      expect(portsResult({ fileText: text({ ps: bad, api: good, owners }), run: ran() })).toEqual({ ps: { error: 'ports.ps1\'s ps section is malformed' }, api: good, owners })
    }
    expect(portsResult({ fileText: text({ ps: good, api: good, owners: { rows: [{ Pid: 1 }] } }), run: ran() }).owners).toEqual({ error: 'ports.ps1\'s owners section is malformed' })
    const all = (error: string): PortsResult => ({ ps: { error }, api: { error }, owners: { error } })
    expect(portsResult({ fileText: undefined, run: ran({ code: 1, stderr: 'boom' }) })).toEqual(all('ports.ps1 exited with 1 and wrote no result file: boom'))
    expect(portsResult({ fileText: 'nope', run: ran() })).toEqual(all('ports.ps1 exited with 0 and its result file is not JSON'))
    expect(portsResult({ fileText: text({ error: 'compile' }), run: ran({ code: 1 }) })).toEqual(all('compile'))
    expect(portsResult({ fileText: text({ ps: good, api: good, owners }), run: ran({ code: 1 }) })).toEqual(all('ports.ps1 exited with 1 and its result is not usable'))
  })

  it('answers exactly the checks of each account', () => {
    const script = { ps: { durationsMs: durations(500), rows }, api: { durationsMs: durations(2), rows }, owners: { rows: [owner()] } }
    const listener = { pid: helperPid, listeners }
    const admin = portAnswers({ user: 'admin', listener, netstat: { rows }, script })
    expect(Object.keys(admin).sort()).toEqual(placeholderIds('ports', 'admin').sort())
    const standard = portAnswers({ user: 'standard', listener, script })
    expect(Object.keys(standard).sort()).toEqual(placeholderIds('ports', 'standard').sort())
    expect(standard['port-ps-latency']?.answer).toBe('no')
    expect(standard['port-api-latency']).toEqual({ answer: 'yes', detail: '', data: { durationsMs: durations(2) } })
    expect(standard['port-control-std']?.data['methods']).toEqual({ 'Get-NetTCPConnection': 'yes', GetExtendedTcpTable: 'yes' })
  })

  it('shows only the rows on the listeners\' ports, so no machine-wide listing reaches a result file', () => {
    const others = [{ address: '0.0.0.0', port: 135, pid: 940 }]
    const script = { ps: { durationsMs: [1], rows: [...rows, ...others] }, api: { durationsMs: [1], rows }, owners: { rows: [owner()] } }
    const answers = portAnswers({ user: 'admin', listener: { pid: helperPid, listeners }, netstat: { rows: [...rows, ...others] }, script })
    expect(answers['port-netstat']?.data['rows']).toEqual(rows)
    expect(answers['port-ps']?.data['rows']).toEqual(rows)
  })

  it('still answers with what was measured when one method fails', () => {
    const script = { ps: { error: 'no CIM' }, api: { durationsMs: [1], rows }, owners: { error: 'no' } }
    const answers = portAnswers({ user: 'admin', listener: { pid: helperPid, listeners }, netstat: { error: 'no netstat' }, script })
    expect(answers['port-control']?.answer).toBe('yes')
    expect(answers['port-ps']).toMatchObject({ answer: null, detail: 'Get-NetTCPConnection: no CIM' })
    expect(answers['port-netstat']?.answer).toBeNull()
    expect(answers['port-api']?.answer).toBe('yes')
  })
})

describe('the listener', () => {
  it('reports its ports, drops connections, and goes when its stdin closes', { timeout: 30_000 }, async () => {
    const listener = await startListener({ addresses: ['127.0.0.1', '0.0.0.0'] })
    expect(listener.listeners.map((l) => l.address)).toEqual(['127.0.0.1', '0.0.0.0'])
    const [first] = listener.listeners
    const closed = await new Promise<boolean>((resolve, reject) => {
      const socket = connect((first as { port: number }).port, '127.0.0.1')
      socket.once('close', () => resolve(true))
      socket.once('error', reject)
      socket.resume()
    })
    expect(closed).toBe(true)
    expect(listener.alive()).toBe(true)
    await listener.stop()
    expect(listener.alive()).toBe(false)
    await listener.stop()
    await expect(new Promise((resolve, reject) => {
      const socket = connect((first as { port: number }).port, '127.0.0.1')
      socket.once('connect', () => {
        socket.destroy()
        reject(new Error('still listening'))
      })
      socket.once('error', resolve)
    })).resolves.toBeInstanceOf(Error)
  })

  it('rejects with the reason when it cannot listen', { timeout: 30_000 }, async () => {
    await expect(startListener({ addresses: ['not an address'] })).rejects.toThrow(/ended before it listened: port-listener\.mjs: /)
    await expect(startListener({ addresses: [] })).rejects.toThrow('expected at least one address')
  })

  it('ends with the process that started it', { timeout: 30_000 }, async () => {
    const script = join(probeDir, 'port-listener.mjs')
    const parent = `const c = require('node:child_process').spawn(process.execPath, [${JSON.stringify(script)}, '127.0.0.1'], { stdio: ['pipe', 'pipe', 'inherit'] }); c.stdout.once('data', (d) => { process.stdout.write(c.pid + ' ' + d); process.exit(0) })`
    const child = spawn(process.execPath, ['-e', parent], { stdio: ['ignore', 'pipe', 'inherit'] })
    const output = await new Promise<string>((resolve) => {
      let text = ''
      child.stdout.on('data', (chunk: Buffer) => (text += chunk.toString()))
      child.on('close', () => resolve(text))
    })
    const pid = Number(output.split(' ')[0])
    await expect.poll(() => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }, { timeout: 10_000 }).toBe(false)
  })
})

describe('the driver', () => {
  const measure = (pid: number): Promise<ContextMeasurement> =>
    Promise.resolve({
      targetPid: pid,
      parentPid: pid,
      console: { attached: false, lastError: 6, window: 0 },
      job: { driverInJob: false, helperInJob: false, limitFlags: null, limitsError: null },
      token: { user: 'RUNNER\\veydr-probe', elevated: false, elevationType: 'default', administrators: 'absent' },
      hkcu: { environment: 'present', environmentValues: 2 },
      helper: 'detached',
    })
  const collect = async (args: string[]) => {
    const lines: { id: string; answer: unknown; detail: string; data: Record<string, unknown> }[] = []
    await runPorts(args, { measure, probeDirectory: () => ({ usable: true }), write: (line) => lines.push(JSON.parse(line) as (typeof lines)[number]) })
    return lines
  }

  // Without Windows no method starts, which shows each check is reported, once, after the context checks.
  it.skipIf(process.platform !== 'linux')('[linux-only: no netstat.exe or PowerShell, so nothing is measured] reports every check of each account', { timeout: 60_000 }, async () => {
    for (const user of ['admin', 'standard'] as const) {
      const lines = await collect(['--user', user])
      expect(lines.map((l) => l.id).sort(), user).toEqual([...contextIds(user), ...placeholderIds('ports', user)].sort())
      expect(lines.slice(0, contextIds(user).length).map((l) => l.id), user).toEqual(contextIds(user))
      for (const line of lines) {
        expect(line.data['context'], line.id).toEqual({ user, console: 'none' })
        if (!line.id.startsWith('ctx-')) expect(line.answer, line.id).toBeNull()
      }
    }
  })

  it('refuses arguments it does not take, and answers null when the standard user is unavailable', async () => {
    await expect(collect(['extra', '--user', 'admin'])).rejects.toThrow('expected no positional arguments')
    const lines = await collect(['--user', 'standard', '--unavailable', 'no account'])
    expect(lines.map((l) => l.id)).toEqual([...contextIds('standard'), ...placeholderIds('ports', 'standard')])
    for (const line of lines) expect(line.answer, line.id).toBeNull()
  })

  it.skipIf(process.platform !== 'win32')('[windows-only: Windows PowerShell 5.1] ports.ps1 and netstat find a real listener', { timeout: 180_000 }, async () => {
    const listener = await startListener({ addresses: LISTEN_ADDRESSES })
    const dir = mkdtempSync(join(tmpdir(), 'veydr-probe-test-'))
    try {
      const outFile = join(dir, 'ports.json')
      const run = await runProgram(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(probeDir, 'ports.ps1'), '-OutFile', outFile, '-Calls', String(LATENCY_CALLS)], { timeoutMs: 150_000 })
      expect(run.code, run.stderr).toBe(0)
      const script = portsResult({ fileText: readFileSync(outFile, 'utf8'), run })
      const netstat = netstatListing(await runProgram(system32('netstat.exe'), ['-ano'], { timeoutMs: 60_000 }))
      const answers = portAnswers({ user: 'admin', listener, netstat, script })
      expect(script.api).toHaveProperty('durationsMs')
      expect(answers['port-api']?.answer).toBe('yes')
      expect(answers['port-ps']?.answer).toBe('yes')
      expect(answers['port-netstat']?.answer).toBe('yes')
      expect(ownerAnswer({ section: script.owners, helperPid: listener.pid }).answer).not.toBeNull()
    } finally {
      await listener.stop()
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })
})
