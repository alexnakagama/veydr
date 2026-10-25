import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProcReader } from '../../src/main/platform/linux/proc-reader'
import { displayName, isLive, isPidEntry, parseBootId, parseCmdline, parseStat, parseStatusUids } from '../../src/main/platform/linux/procfs'

const captured = (name: string): Buffer => readFileSync(join(__dirname, '../fixtures/procfs', name))
const text = (name: string): string => captured(name).toString('utf8')

describe('/proc parsing (captured fixtures)', () => {
  it('parses a command name with spaces and parentheses', () => {
    expect(parseStat(text('stat-parentheses.txt'))).toEqual({
      pid: 108240,
      comm: 'a b) (c',
      state: 'S',
      ppid: 108239,
      pgrp: 108231,
      session: 108231,
      starttime: 535467,
    })
  })

  it('parses an ordinary process and a kernel thread', () => {
    expect(parseStat(text('stat-cat.txt'))).toMatchObject({ pid: 108344, comm: 'cat', state: 'R', ppid: 108231, pgrp: 108231, session: 108231, starttime: 535688 })
    expect(parseStat(text('stat-kthreadd.txt'))).toMatchObject({ pid: 2, comm: 'kthreadd', ppid: 0, pgrp: 0, session: 0, starttime: 10 })
  })

  it('recognizes zombies as not live', () => {
    const zombie = parseStat(text('stat-zombie.txt'))
    expect(zombie).toMatchObject({ pid: 108250, state: 'Z', starttime: 535488 })
    expect(zombie !== null && isLive(zombie)).toBe(false)
    const running = parseStat(text('stat-cat.txt'))
    expect(running !== null && isLive(running)).toBe(true)
    for (const state of ['X', 'x']) {
      expect(isLive({ pid: 1, comm: 'x', state, ppid: 0, pgrp: 1, session: 1, starttime: 1 })).toBe(false)
    }
  })

  it('reads the user IDs from /proc/<pid>/status (port inspection)', () => {
    expect(parseStatusUids(text('status-cat.txt'))).toEqual([1000, 1000, 1000, 1000])
    expect(parseStatusUids('Name:\tpasswd\nUid:\t1000\t0\t0\t0\nGid:\t1000\t1000\t1000\t1000\n')).toEqual([1000, 0, 0, 0])
    expect(parseStatusUids('Name:\tx\nUid:\t1000\t0\n')).toBeNull()
    expect(parseStatusUids('Name:\tx\n')).toBeNull()
  })

  it('rejects malformed stat content', () => {
    const valid = text('stat-cat.txt')
    for (const bad of [
      '',
      'garbage',
      '123 cat R 1 2 3',
      '(cat) R 1 2 3',
      'x (cat) R 1 2 3 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5 0',
      '123 (cat) R 1 2 3', // too few fields: no start time
      valid.replace(' R ', ' RR '),
      valid.replace(' R 108231 ', ' R -1 '),
      valid.replace(' 535688 ', ' 5e5 '),
      valid.replace(' 535688 ', ' 99999999999999999999 '),
      `123(cat) ${valid.slice(valid.indexOf(') ') + 2)}`,
    ]) {
      expect(parseStat(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('parses command lines; kernel threads have none', () => {
    expect(parseCmdline(captured('cmdline-parentheses.bin'))).toEqual(['/opt/tools/a b) (c', '30'])
    expect(parseCmdline(captured('cmdline-kernel-thread.bin'))).toEqual([])
    expect(parseCmdline(Buffer.from('node\0-e\0\0'))).toEqual(['node', '-e', ''])
  })

  it('names a process after its first argument, falling back to the kernel command name', () => {
    const comm = { comm: 'MainThread' }
    expect(displayName(comm, ['/usr/bin/node', 'server.js'])).toBe('node')
    expect(displayName(comm, ['npm run dev'])).toBe('npm run dev')
    expect(displayName(comm, [])).toBe('MainThread')
    expect(displayName(comm, ['/usr/bin/'])).toBe('MainThread')
    expect(displayName(comm, [''])).toBe('MainThread')
  })

  it('parses the boot ID', () => {
    expect(parseBootId(text('boot_id.txt'))).toBe('fe842736-befd-4703-a9f6-ed979b5b00d3')
    expect(parseBootId('not-a-boot-id\n')).toBeNull()
    expect(parseBootId('')).toBeNull()
  })

  it('accepts only process directory names', () => {
    expect(['1', '108240', '0', 'self', 'thread-self', 'sys', '12a', ''].filter(isPidEntry)).toEqual(['1', '108240'])
  })
})

describe('/proc reader', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  /** A fake /proc built from the captured files. */
  function fakeProc(): string {
    const root = mkdtempSync(join(tmpdir(), 'veydr-procfs-'))
    roots.push(root)
    const add = (pid: string, stat: string, cmdline?: Buffer): void => {
      mkdirSync(join(root, pid))
      writeFileSync(join(root, pid, 'stat'), stat)
      if (cmdline !== undefined) writeFileSync(join(root, pid, 'cmdline'), cmdline)
    }
    add('108240', text('stat-parentheses.txt'), captured('cmdline-parentheses.bin'))
    add('2', text('stat-kthreadd.txt'), captured('cmdline-kernel-thread.bin'))
    add('108250', text('stat-zombie.txt'))
    add('77', 'corrupted')
    mkdirSync(join(root, '78')) // vanished: no stat file
    mkdirSync(join(root, 'self'))
    mkdirSync(join(root, 'sys/kernel/random'), { recursive: true })
    writeFileSync(join(root, 'sys/kernel/random/boot_id'), captured('boot_id.txt'))
    return root
  }

  it('scans every readable process and skips malformed or vanished ones', async () => {
    const reader = createProcReader(fakeProc())
    const pids = (await reader.scan()).map((s) => s.pid).sort((a, b) => a - b)
    expect(pids).toEqual([2, 108240, 108250])
  })

  it('reads single processes, command lines, and the boot ID', () => {
    const reader = createProcReader(fakeProc())
    expect(reader.stat(108240)).toMatchObject({ comm: 'a b) (c', starttime: 535467 })
    expect(reader.stat(999)).toBeNull()
    expect(reader.stat(77)).toBeNull()
    expect(reader.commandLine(108240)).toEqual(['/opt/tools/a b) (c', '30'])
    expect(reader.commandLine(999)).toEqual([])
    expect(reader.bootId()).toBe('fe842736-befd-4703-a9f6-ed979b5b00d3')
  })

  it('fails loudly on an unreadable boot ID', () => {
    const root = fakeProc()
    writeFileSync(join(root, 'sys/kernel/random/boot_id'), 'nope')
    expect(() => createProcReader(root).bootId()).toThrow(/boot ID/)
  })

  it('reads the real /proc of this machine', async () => {
    const reader = createProcReader()
    const self = reader.stat(process.pid)
    expect(self).toMatchObject({ pid: process.pid, ppid: process.ppid })
    expect((await reader.scan()).some((s) => s.pid === process.pid)).toBe(true)
    expect(reader.bootId()).toMatch(/^[0-9a-f-]{36}$/)
  })
})
