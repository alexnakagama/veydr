import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { sleep } from '../support/proc'
import {
  commandLines,
  isAlive,
  killTagged,
  parseProcStat,
  parseWindowsRows,
  taggedFromRows,
  processIdentity,
  TAG_VARIABLE,
  taggedProcesses,
} from '../support/processes'

// The portable process helper of the tests (add-windows-environment-and-commands design D7), on the
// system the tests run on (Linux and Windows CI): it must see a tagged process it did not start
// itself, or every "no process remains" check built on it would pass without looking.

async function eventually<T>(read: () => T, done: (value: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (done(value)) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last seen: ${JSON.stringify(value)}`)
    await sleep(100)
  }
}

describe('test/support/processes.ts on this system', () => {
  const started: ChildProcess[] = []
  afterEach(() => {
    for (const child of started.splice(0)) child.kill('SIGKILL')
  })

  it('sees a started tagged process, identifies it, reads its command line, and kills it', { timeout: 120_000 }, async () => {
    const tag = crypto.randomUUID()
    const marker = `veydr-processes-${crypto.randomUUID()}`
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', marker], {
      env: { ...process.env, [TAG_VARIABLE]: tag },
      stdio: 'ignore',
    })
    started.push(child)
    await once(child, 'spawn')
    const pid = child.pid ?? 0

    const [seen] = await eventually(() => taggedProcesses(tag), (found) => found.length > 0, 'the tagged process')
    expect(seen).toMatchObject({ pid, ppid: process.pid })
    expect(seen?.starttime).toMatch(/^\d+$/)
    expect(taggedProcesses(tag)).toEqual([seen])
    // The same identity by PID; a start time it never had does not identify it.
    expect(processIdentity(pid)).toEqual(seen)
    expect(isAlive(pid, seen?.starttime)).toBe(true)
    expect(isAlive(pid, '1')).toBe(false)
    expect(commandLines([pid]).get(pid)).toContain(marker)
    // Another tag matches nothing; this process is not tagged.
    expect(taggedProcesses(crypto.randomUUID())).toEqual([])

    const exited = once(child, 'exit')
    killTagged(tag)
    await exited
    await eventually(() => taggedProcesses(tag), (found) => found.length === 0, 'the killed process to be gone')
    expect(processIdentity(pid)).toBeNull()
    expect(isAlive(pid, seen?.starttime)).toBe(false)
    expect(commandLines([pid]).has(pid)).toBe(false)
  })

  it('refuses inputs that are not a tag, a process ID, or a start time', () => {
    expect(() => taggedProcesses('')).toThrow('not a scenario tag')
    expect(() => taggedProcesses("x' OR 1=1")).toThrow('not a scenario tag')
    expect(() => killTagged('VEYDR')).toThrow('not a scenario tag')
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(() => processIdentity(pid), String(pid)).toThrow('not a process ID')
    expect(() => commandLines([process.pid, 0])).toThrow('not a process ID')
    expect(() => isAlive(process.pid, undefined)).toThrow('no start time')
    expect(() => isAlive(process.pid, '')).toThrow('no start time')
  })
})

describe('process query parsing', () => {
  it('reads Win32_Process rows and refuses anything else, never taking a broken answer for "none"', () => {
    expect(parseWindowsRows('[]\r\n')).toEqual([])
    expect(parseWindowsRows('[{"pid":4242,"ppid":1,"name":"node.exe","starttime":"134070000000000000","commandLine":"node x","status":"tagged"}]')).toEqual([
      { pid: 4242, ppid: 1, name: 'node.exe', starttime: '134070000000000000', commandLine: 'node x', status: 'tagged' },
    ])
    expect(parseWindowsRows('[{"pid":4,"ppid":0,"name":"System","starttime":"1","commandLine":null}]')[0]?.commandLine).toBeNull()
    for (const output of ['', 'WARNING: something', '{"pid":1}', 'null', '[null]', '[{"pid":"1","ppid":0,"name":"a","starttime":"1","commandLine":null}]', '[{"pid":1,"ppid":0,"name":"a","starttime":"","commandLine":null}]', '[{"pid":1,"ppid":0,"name":"a","starttime":"1"}]', '[{"pid":1,"ppid":0,"name":"a","starttime":"1","commandLine":null,"status":"gone"}]']) {
      expect(() => parseWindowsRows(output), output).toThrow(/process query/)
    }
  })

  it('picks the tagged processes of a Windows query, and fails when a child of one could not be read', () => {
    const row = (pid: number, ppid: number, name: string, status: 'tagged' | 'unreadable' | null) => ({ pid, ppid, name, starttime: String(pid), commandLine: null, status })
    // The helper and console hosts carry the tag but are not the command's processes.
    expect(
      taggedFromRows([row(10, 1, 'veydr-helper.exe', 'tagged'), row(11, 10, 'node.exe', 'tagged'), row(12, 10, 'Conhost.exe', 'tagged'), row(13, 11, 'node.exe', 'tagged')]),
    ).toEqual([
      { pid: 11, ppid: 10, starttime: '11' },
      { pid: 13, ppid: 11, starttime: '13' },
    ])
    // An unreadable process started by anything else (another user's, the system's) is not the scenario's.
    expect(taggedFromRows([row(11, 10, 'node.exe', 'tagged'), row(20, 4, 'svchost.exe', 'unreadable')])).toEqual([{ pid: 11, ppid: 10, starttime: '11' }])
    // One started by a tagged process (also by the excluded helper) would be missed: the query fails.
    expect(() => taggedFromRows([row(11, 10, 'node.exe', 'tagged'), row(14, 11, 'tool32.exe', 'unreadable')])).toThrow('tool32.exe (PID 14, parent 11)')
    expect(() => taggedFromRows([row(10, 1, 'veydr-helper.exe', 'tagged'), row(15, 10, 'node.exe', 'unreadable')])).toThrow('node.exe (PID 15, parent 10)')
    // Except a console host, which Windows starts for the console and never runs anything.
    expect(taggedFromRows([row(10, 1, 'veydr-helper.exe', 'tagged'), row(16, 10, 'conhost.exe', 'unreadable')])).toEqual([])
    // And Chromium's own sandboxed processes, when a test starts Veydr itself with the tag: Electron's
    // executable with a --type= switch. A command's process with such an argument is not exempt.
    const chromium = (pid: number, name: string, commandLine: string) => ({ ...row(pid, 30, name, 'unreadable'), commandLine })
    const veydr = row(30, 1, 'electron.exe', 'tagged')
    expect(taggedFromRows([veydr, chromium(31, 'electron.exe', 'electron.exe --type=renderer --enable-sandbox')])).toEqual([{ pid: 30, ppid: 1, starttime: '30' }])
    expect(() => taggedFromRows([veydr, chromium(32, 'node.exe', 'node.exe tool.mjs --type=renderer')])).toThrow('node.exe (PID 32, parent 30)')
    expect(() => taggedFromRows([veydr, chromium(33, 'Electron.exe', 'electron.exe app')])).toThrow('Electron.exe (PID 33, parent 30)')
  })

  it('reads /proc/<pid>/stat, whose command name may hold spaces and parentheses', () => {
    const fields = 'S 1 300 300 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 98765 0'
    expect(parseProcStat(300, `300 (node) ${fields}`)).toEqual({ pid: 300, ppid: 1, pgid: 300, sid: 300, state: 'S', starttime: '98765' })
    expect(parseProcStat(300, `300 (a) b (c)) ${fields}`)).toMatchObject({ ppid: 1, starttime: '98765' })
    for (const text of ['', '300 node S 1', '300 (node) S x 300 300']) expect(() => parseProcStat(300, text), text).toThrow('unparsable')
  })
})
