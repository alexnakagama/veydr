import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOST_LITTLE_ENDIAN, parseNetTcp, socketInode, TCP_LISTEN } from '../../src/main/platform/linux/net'
import { createLinuxPortInspector, type PortProcFs } from '../../src/main/platform/linux/ports'

// Task 8.1: /proc/net/tcp{,6} parsing and the inode → PID mapping, with restricted owners.

const captured = (name: string): string => readFileSync(join(__dirname, '../fixtures/procnet', name), 'utf8')
const BOOT = '3f0c2b1a-9d8e-4c7b-a6f5-0e1d2c3b4a59'

describe('/proc/net/tcp parsing (captured fixtures)', () => {
  it('the fixtures were captured on a little-endian host, like this one', () => {
    expect(HOST_LITTLE_ENDIAN).toBe(true)
  })

  it('parses IPv4 rows: addresses, ports, states, owners, and inodes', () => {
    const { sockets, malformed } = parseNetTcp(captured('tcp.txt'), 'ipv4')
    expect(malformed).toBe(0)
    expect(sockets.map((s) => [s.address, s.port, s.state, s.uid, s.inode])).toEqual([
      ['127.0.0.1', 631, TCP_LISTEN, 0, 416545],
      ['127.0.0.1', 47801, TCP_LISTEN, 1000, 502046],
      ['0.0.0.0', 47804, TCP_LISTEN, 1000, 502049],
      ['192.168.0.10', 45504, 0x01, 1000, 495201],
      ['192.168.0.10', 34694, 0x06, 0, 0],
      ['127.0.0.1', 47801, 0x01, 1000, 502052],
      ['127.0.0.1', 54352, 0x01, 1000, 502051],
    ])
    expect(sockets.every((s) => s.family === 'ipv4')).toBe(true)
  })

  it('parses IPv6 rows, including the unspecified, loopback, and IPv4-mapped addresses', () => {
    const { sockets, malformed } = parseNetTcp(captured('tcp6.txt'), 'ipv6')
    expect(malformed).toBe(0)
    expect(sockets.map((s) => [s.address, s.port, s.state, s.uid, s.inode])).toEqual([
      ['::1', 47802, TCP_LISTEN, 1000, 502047],
      ['::1', 631, TCP_LISTEN, 0, 416544],
      ['::ffff:127.0.0.1', 47805, TCP_LISTEN, 1000, 502050],
      ['::', 47803, TCP_LISTEN, 1000, 502048],
    ])
    expect(sockets.every((s) => s.family === 'ipv6')).toBe(true)
  })

  it('writes IPv6 addresses in RFC 5952 form', () => {
    // Each 32-bit word is printed in host order, so on little-endian hosts its bytes are reversed.
    const word = (bytes: string): string => bytes.match(/../g)?.reverse().join('') ?? ''
    const row = (hex: string): string => `   0: ${hex}:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 7 1 0 100 0 0 10 0`
    const address = (groups: string): string => {
      const hex = groups.replaceAll(':', '')
      const text = row([0, 8, 16, 24].map((i) => word(hex.slice(i, i + 8))).join(''))
      return parseNetTcp(text, 'ipv6').sockets[0]?.address ?? 'unparsed'
    }
    expect(address('2001:0db8:0000:0000:0000:0000:0000:0005')).toBe('2001:db8::5')
    expect(address('fe80:0000:0000:0000:0a1b:2c3d:4e5f:6071')).toBe('fe80::a1b:2c3d:4e5f:6071')
    // A single zero group is not shortened; of two equal runs the first is.
    expect(address('2001:0db8:0000:0001:0001:0001:0001:0001')).toBe('2001:db8:0:1:1:1:1:1')
    expect(address('2001:0000:0000:0001:0000:0000:0001:0001')).toBe('2001::1:0:0:1:1')
    // The longest run wins over an earlier, shorter one.
    expect(address('2001:0000:0000:0001:0000:0000:0000:0001')).toBe('2001:0:0:1::1')
    expect(address('0000:0000:0000:0000:0000:0000:0000:0000')).toBe('::')
    expect(address('0000:0000:0000:0000:0000:ffff:c000:0201')).toBe('::ffff:192.0.2.1')
  })

  it('reads the words in network order on a big-endian host', () => {
    const row = '   0: 7F000001:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 9 1 0 100 0 0 10 0'
    expect(parseNetTcp(row, 'ipv4', false).sockets[0]).toMatchObject({ address: '127.0.0.1', port: 80 })
    expect(parseNetTcp(row, 'ipv4', true).sockets[0]).toMatchObject({ address: '1.0.0.127', port: 80 })
  })

  it('skips the header and counts malformed rows without failing', () => {
    const text = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11 1 0 100 0 0 10 0',
      '   1: 0100007F 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12 1 0',
      '   2: 0100007F:0051 00000000:0000 XY 00000000:00000000 00:00000000 00000000  1000        0 13 1 0',
      '   3: 0100007F:0052 00000000:0000 0A 00000000:00000000 00:00000000 00000000  root        0 14 1 0',
      '   4: 00000000000000000000000001000000:0053 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 15 1 0',
      '   5: 0100007F:0054 00000000:0000 0A',
      '',
    ].join('\n')
    expect(parseNetTcp(text, 'ipv4')).toEqual({
      sockets: [{ family: 'ipv4', address: '127.0.0.1', port: 80, state: TCP_LISTEN, uid: 1000, inode: 11 }],
      malformed: 5,
    })
  })

  it('reads socket inodes from fd links and nothing else', () => {
    expect(socketInode('socket:[502046]')).toBe(502046)
    for (const link of ['pipe:[502046]', 'anon_inode:[eventfd]', '/dev/null', 'socket:[]', 'socket:[12a]', '/tmp/socket:[1]']) {
      expect(socketInode(link), link).toBeNull()
    }
  })
})

type Entry = string | Buffer | string[] | { readonly error: string }

/** An in-memory /proc: files, directories (string arrays), fd links, or an errno code per path. */
function fakeProc(entries: Readonly<Record<string, Entry>>): PortProcFs & { readonly reads: string[] } {
  const reads: string[] = []
  const get = (path: string): Entry => {
    reads.push(path)
    const entry = entries[path]
    if (entry === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    if (typeof entry === 'object' && 'error' in entry) throw Object.assign(new Error(`${entry.error}: ${path}`), { code: entry.error })
    return entry
  }
  return {
    reads,
    readFile: (path) =>
      Promise.resolve().then(() => {
        const entry = get(path)
        if (Array.isArray(entry)) throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' })
        return Buffer.isBuffer(entry) ? entry : Buffer.from(entry as string)
      }),
    readdir: (path) =>
      Promise.resolve().then(() => {
        const entry = get(path)
        if (!Array.isArray(entry)) throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' })
        return entry
      }),
    readlink: (path) =>
      Promise.resolve().then(() => {
        const entry = get(path)
        if (typeof entry !== 'string') throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' })
        return entry
      }),
  }
}

/** /proc/<pid>/{stat,status,cmdline,fd/*} of one process; `uids` are its real, effective, saved, and fs user IDs (default: the user's). */
function processEntries(
  pid: number,
  options: { starttime: number; comm: string; args: string[]; fds: Record<string, string> | { error: string }; uids?: readonly number[] },
): Record<string, Entry> {
  const uids = options.uids ?? [1000, 1000, 1000, 1000]
  const entries: Record<string, Entry> = {
    [`/proc/${pid}/stat`]: `${pid} (${options.comm}) S 1 ${pid} ${pid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${options.starttime} 0 0`,
    [`/proc/${pid}/status`]: `Name:\t${options.comm}\nUmask:\t0022\nState:\tS (sleeping)\nPid:\t${pid}\nUid:\t${uids.join('\t')}\nGid:\t${uids.join('\t')}\n`,
    [`/proc/${pid}/cmdline`]: Buffer.from(options.args.map((a) => `${a}\0`).join('')),
  }
  if ('error' in options.fds) {
    entries[`/proc/${pid}/fd`] = { error: options.fds.error }
  } else {
    entries[`/proc/${pid}/fd`] = Object.keys(options.fds)
    for (const [fd, link] of Object.entries(options.fds)) entries[`/proc/${pid}/fd/${fd}`] = link
  }
  return entries
}

const inspector = (fs: PortProcFs, log: { record: (...args: unknown[]) => void } = { record: () => undefined }, uid = 1000) =>
  createLinuxPortInspector({ fs, uid, bootId: () => BOOT, now: () => 1_761_400_000_000, log })

describe('Linux port inspector (simulated /proc with captured socket tables)', () => {
  const tables = { '/proc/net/tcp': captured('tcp.txt'), '/proc/net/tcp6': captured('tcp6.txt') }

  it('lists every listening socket with its holder, identified by PID and start time, and none of the connections', async () => {
    const fs = fakeProc({
      ...tables,
      '/proc': ['1', '4200', '4300', 'self', 'net', 'sys'],
      ...processEntries(1, { starttime: 1, comm: 'systemd', args: ['/sbin/init'], fds: { error: 'EACCES' }, uids: [0, 0, 0, 0] }),
      ...processEntries(4200, {
        starttime: 9_000,
        comm: 'MainThread',
        args: ['/usr/bin/node', 'server.js'],
        fds: { 0: '/dev/null', 1: 'pipe:[77]', 18: 'socket:[502046]', 19: 'socket:[502047]', 20: 'socket:[502048]', 21: 'socket:[502049]', 22: 'socket:[502050]', 23: 'socket:[502052]', 24: 'anon_inode:[eventfd]' },
      }),
      ...processEntries(4300, { starttime: 9_500, comm: 'curl', args: ['curl', 'http://127.0.0.1:47801/'], fds: { 3: 'socket:[502051]' } }),
    })
    const snapshot = await inspector(fs).list()
    const node = { kind: 'known', processes: [{ identity: { pid: 4200, token: `${BOOT}:9000` }, name: 'node' }] }
    expect(snapshot).toEqual({
      takenAt: 1_761_400_000_000,
      ports: [
        // Port 631 belongs to root (uid 0): its holder is not visible to this user.
        { family: 'ipv4', address: '127.0.0.1', port: 631, owner: { kind: 'restricted' } },
        { family: 'ipv6', address: '::1', port: 631, owner: { kind: 'restricted' } },
        { family: 'ipv4', address: '127.0.0.1', port: 47801, owner: node },
        { family: 'ipv6', address: '::1', port: 47802, owner: node },
        { family: 'ipv6', address: '::', port: 47803, owner: node },
        { family: 'ipv4', address: '0.0.0.0', port: 47804, owner: node },
        { family: 'ipv6', address: '::ffff:127.0.0.1', port: 47805, owner: node },
      ],
    })
    // Only processes holding a listening socket are described.
    expect(fs.reads.filter((p) => p.endsWith('/stat') || p.endsWith('/cmdline'))).toEqual(['/proc/4200/stat', '/proc/4200/cmdline'])
  })

  it('[spec:port-inspection/port-owned-by-another-user] marks a socket restricted when its holder may be hidden, distinct from unknown', async () => {
    const own = (inode: number, port: string): string => `   0: 0100007F:${port} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0 100 0 0 10 0`
    const other = (inode: number, port: string): string => `   1: 0100007F:${port} 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 ${inode} 1 0 100 0 0 10 0`
    const table = ['  sl  local_address', own(10, '0BB8'), other(11, '0BB9')].join('\n')

    const kinds = async (entries: Record<string, Entry>, uid = 1000): Promise<[number, string][]> =>
      (await inspector(fakeProc({ '/proc/net/tcp': table, '/proc/net/tcp6': { error: 'ENOENT' }, ...entries }), undefined, uid).list()).ports.map((p) => [p.port, p.owner.kind])
    const shell = processEntries(50, { starttime: 5, comm: 'sh', args: ['sh'], fds: { 0: '/dev/null' } })

    // Every process's files are readable: another user's socket is still restricted (hidepid, or
    // the holder is in another PID namespace), while an own socket without holder is unknown.
    expect(await kinds({ '/proc': ['50'], ...shell })).toEqual([
      [3000, 'unknown'],
      [3001, 'restricted'],
    ])

    // Another user's processes (here root's, as on every desktop) cannot be read. They cannot hold
    // the own socket, so it stays unknown (review L7-02).
    expect(await kinds({ '/proc': ['50', '60'], ...shell, ...processEntries(60, { starttime: 6, comm: 'sshd', args: ['sshd'], fds: { error: 'EACCES' }, uids: [0, 0, 0, 0] }) })).toEqual([
      [3000, 'unknown'],
      [3001, 'restricted'],
    ])

    // An own process whose files cannot be read (non-dumpable, e.g. an agent) may hold it: restricted.
    const agent = processEntries(61, { starttime: 7, comm: 'gpg-agent', args: ['gpg-agent'], fds: { error: 'EACCES' } })
    expect(await kinds({ '/proc': ['50', '61'], ...shell, ...agent })).toEqual([
      [3000, 'restricted'],
      [3001, 'restricted'],
    ])
    // So may a setuid program started by the user (real user ID the user's, effective root).
    const setuid = processEntries(62, { starttime: 8, comm: 'passwd', args: ['passwd'], fds: { error: 'EPERM' }, uids: [1000, 0, 0, 0] })
    expect(await kinds({ '/proc': ['62'], ...setuid })).toEqual([
      [3000, 'restricted'],
      [3001, 'restricted'],
    ])

    // Single unreadable fd links (EPERM, EACCES) of an own process count the same way.
    for (const error of ['EPERM', 'EACCES']) {
      const link = { '/proc': ['50'], ...processEntries(50, { starttime: 5, comm: 'sh', args: ['sh'], fds: { 0: '/dev/null', 1: 'x' } }), '/proc/50/fd/1': { error } }
      expect((await kinds(link))[0], error).toEqual([3000, 'restricted'])
    }

    // A denied process that exits before its status is read holds nothing; one whose status cannot
    // be read for another reason cannot be ruled out.
    const vanished = { ...agent, '/proc/61/status': { error: 'ENOENT' } }
    expect((await kinds({ '/proc': ['61'], ...vanished }))[0]).toEqual([3000, 'unknown'])
    const unreadable = { ...agent, '/proc/61/status': { error: 'EIO' } }
    expect((await kinds({ '/proc': ['61'], ...unreadable }))[0]).toEqual([3000, 'restricted'])

    // Root sees every process: another user's socket without a holder is unknown (review L7-04).
    expect(await kinds({ '/proc': ['50'], ...shell }, 0)).toEqual([
      [3000, 'unknown'],
      [3001, 'unknown'],
    ])
  })

  it('reads the socket tables before the open files, so a socket in a table cannot have appeared after its holder was read (review L7-01)', async () => {
    const fs = fakeProc({
      ...tables,
      '/proc': ['4200'],
      ...processEntries(4200, { starttime: 9_000, comm: 'node', args: ['node'], fds: { 3: 'socket:[502046]', 4: 'socket:[502051]' } }),
    })
    // The tables take a while to read; nothing of the processes may be read before they are done.
    const events: string[] = []
    const slowTables: PortProcFs = {
      readFile: async (path) => {
        const content = await fs.readFile(path)
        if (path.startsWith('/proc/net/')) {
          await new Promise((done) => setTimeout(done, 5))
          events.push(`read ${path}`)
        }
        return content
      },
      readdir: (path) => {
        events.push(`readdir ${path}`)
        return fs.readdir(path)
      },
      readlink: (path) => fs.readlink(path),
    }
    const snapshot = await inspector(slowTables).list()
    expect(events.slice(0, 2).sort()).toEqual(['read /proc/net/tcp', 'read /proc/net/tcp6'])
    expect(events.slice(2)).toEqual(['readdir /proc', 'readdir /proc/4200/fd'])
    // Only the links of listening sockets are kept: 502051 (a connection) is not a listener.
    expect(snapshot.ports.find((p) => p.port === 47801)?.owner.kind).toBe('known')
  })

  it('lists every holder of a shared socket, oldest first', async () => {
    const fs = fakeProc({
      '/proc/net/tcp': captured('tcp.txt'),
      '/proc/net/tcp6': { error: 'ENOENT' },
      '/proc': ['900', '800'],
      ...processEntries(900, { starttime: 2_000, comm: 'worker', args: ['/usr/bin/node', 'worker.js'], fds: { 3: 'socket:[502049]' } }),
      ...processEntries(800, { starttime: 1_000, comm: 'MainThread', args: ['/usr/bin/node', 'primary.js'], fds: { 3: 'socket:[502049]', 4: 'socket:[502049]' } }),
    })
    const port = (await inspector(fs).list()).ports.find((p) => p.port === 47804)
    expect(port?.owner).toEqual({
      kind: 'known',
      processes: [
        { identity: { pid: 800, token: `${BOOT}:1000` }, name: 'node' },
        { identity: { pid: 900, token: `${BOOT}:2000` }, name: 'node' },
      ],
    })
  })

  it('tolerates processes that exit while being read, and reports a socket whose holder exited as unknown', async () => {
    const fs = fakeProc({
      '/proc/net/tcp': captured('tcp.txt'),
      '/proc/net/tcp6': { error: 'ENOENT' },
      // 71 exited before its fd directory was read; 72 closed fd 4 meanwhile; 73 exited before its stat was read.
      '/proc': ['71', '72', '73'],
      '/proc/71/fd': { error: 'ENOENT' },
      ...processEntries(72, { starttime: 72, comm: 'kept', args: [], fds: { 3: 'socket:[502046]', 4: 'x' } }),
      '/proc/72/fd/4': { error: 'ENOENT' },
      '/proc/73/fd': ['3'],
      '/proc/73/fd/3': 'socket:[502049]',
    })
    const log: unknown[] = []
    const ports = (await inspector(fs, { record: (...args) => log.push(args) }).list()).ports
    // Without a command line, the kernel's command name is shown.
    expect(ports.find((p) => p.port === 47801)?.owner).toEqual({ kind: 'known', processes: [{ identity: { pid: 72, token: `${BOOT}:72` }, name: 'kept' }] })
    expect(ports.find((p) => p.port === 47804)?.owner).toEqual({ kind: 'unknown' })
    expect(log).toEqual([])
  })

  it('reports other read failures as unknown owners and logs them once', async () => {
    const fs = fakeProc({
      '/proc/net/tcp': captured('tcp.txt'),
      '/proc/net/tcp6': { error: 'ENOENT' },
      '/proc': ['81', '82'],
      '/proc/81/fd': { error: 'EMFILE' },
      '/proc/82/fd': { error: 'EMFILE' },
    })
    const log: unknown[][] = []
    const ports = (await inspector(fs, { record: (...args) => log.push(args) }).list()).ports
    expect(ports.find((p) => p.port === 47801)?.owner).toEqual({ kind: 'unknown' })
    expect(log).toEqual([['warn', 'ports.read-failed', { EMFILE: 2 }]])
  })

  it('works without IPv6 and fails with the file name when a socket table cannot be read', async () => {
    const noIpv6 = fakeProc({ '/proc/net/tcp': captured('tcp.txt'), '/proc/net/tcp6': { error: 'ENOENT' }, '/proc': [] })
    expect((await inspector(noIpv6).list()).ports.map((p) => p.family)).toEqual(['ipv4', 'ipv4', 'ipv4'])

    const broken = fakeProc({ '/proc/net/tcp': { error: 'EACCES' }, '/proc/net/tcp6': captured('tcp6.txt'), '/proc': [] })
    await expect(inspector(broken).list()).rejects.toThrow('Could not read /proc/net/tcp: EACCES: /proc/net/tcp')
  })

  it('reads no process files when nothing listens, and logs malformed rows', async () => {
    const connectionsOnly = captured('tcp.txt')
      .split('\n')
      .filter((line) => !/ 0A /.test(line))
      .join('\n')
    const fs = fakeProc({ '/proc/net/tcp': `${connectionsOnly}   9: garbage\n`, '/proc/net/tcp6': { error: 'ENOENT' }, '/proc': ['1'] })
    const log: unknown[][] = []
    expect(await inspector(fs, { record: (...args) => log.push(args) }).list()).toEqual({ takenAt: 1_761_400_000_000, ports: [] })
    expect(fs.reads.filter((p) => !p.startsWith('/proc/net/'))).toEqual([])
    expect(log).toEqual([['warn', 'ports.malformed-rows', { file: 'tcp', rows: 1 }]])
  })
})
