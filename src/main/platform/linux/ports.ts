import { readdir, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { ListeningPort, PlatformLog, PortInspector, PortOwner, PortProcess, PortSnapshot } from '../types'
import { parseNetTcp, socketInode, TCP_LISTEN, type AddressFamily, type NetSocket } from './net'
import { displayName, isPidEntry, linuxIdentity, parseCmdline, parseStat, parseStatusUids, type ProcStat } from './procfs'

/** The file reads the inspector needs; every path is under the /proc root. */
export interface PortProcFs {
  readFile(path: string): Promise<Buffer>
  readdir(path: string): Promise<string[]>
  readlink(path: string): Promise<string>
}

export interface LinuxPortInspectorOptions {
  /** Mount point of procfs. */
  readonly root?: string
  readonly fs?: PortProcFs
  /** Effective user ID of Veydr (`process.geteuid()`). */
  readonly uid?: number
  /** The current boot's ID, for process identities. */
  readonly bootId: () => string
  readonly now?: () => number
  readonly log?: PlatformLog
}

const nodeFs: PortProcFs = {
  readFile: (path) => readFile(path),
  readdir: (path) => readdir(path),
  readlink: (path) => readlink(path),
}

const ROOT = 0

/** Processes whose open files are read at the same time. */
const PROCESS_CONCURRENCY = 8

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The process does not exist (any more). */
const isGone = (code: string | undefined): boolean => code === 'ENOENT' || code === 'ESRCH'
/** Reading is not permitted (another user's or a non-dumpable process). */
const isDenied = (code: string | undefined): boolean => code === 'EACCES' || code === 'EPERM'

/** What reading the open files of every process found. */
interface Holders {
  /** Socket inode → PIDs of processes holding it. */
  readonly byInode: Map<number, Set<number>>
  /** Processes whose open files (or some of them) could not be read for lack of permission. */
  readonly denied: number[]
  /** Other read failures, by error code (logged once per scan). */
  readonly failures: Map<string, number>
}

/**
 * Listening TCP sockets on Linux (design D12): LISTEN rows of /proc/net/tcp and /proc/net/tcp6
 * (the network namespace Veydr runs in), mapped to processes through the `socket:[inode]` links in
 * /proc/<pid>/fd. Only files are read: nothing is signalled, executed, or connected to.
 *
 * The tables are read first, then the links: a socket in a table was open when the links were
 * read, so a just-opened socket is never missed for having appeared between the two reads.
 *
 * A socket whose holder is not found is `restricted` when the OS hides it from this user: it was
 * created by another user (unless Veydr runs as root, which sees every process), or the open files
 * of a process that could be the user's own could not be read (the holder may be that process).
 * Otherwise it is `unknown` (e.g. its holder exited between the reads).
 */
export function createLinuxPortInspector(options: LinuxPortInspectorOptions): PortInspector {
  const root = options.root ?? '/proc'
  const fs = options.fs ?? nodeFs
  const uid = options.uid ?? process.geteuid?.() ?? -1
  const now = options.now ?? Date.now
  const log = options.log

  const readTable = async (name: 'tcp' | 'tcp6', family: AddressFamily): Promise<readonly NetSocket[]> => {
    let text: string
    try {
      text = (await fs.readFile(join(root, 'net', name))).toString('utf8')
    } catch (error) {
      // No IPv6 in this kernel (or namespace): there are no IPv6 sockets.
      if (errnoOf(error) === 'ENOENT') return []
      throw new Error(`Could not read ${join(root, 'net', name)}: ${messageOf(error)}`, { cause: error })
    }
    const { sockets, malformed } = parseNetTcp(text, family)
    if (malformed > 0) log?.record('warn', 'ports.malformed-rows', { file: name, rows: malformed })
    return sockets.filter((socket) => socket.state === TCP_LISTEN)
  }

  const fail = (holders: Holders, code: string | undefined): void => {
    const key = code ?? 'unknown'
    holders.failures.set(key, (holders.failures.get(key) ?? 0) + 1)
  }

  /**
   * Whether `pid`, whose open files are not readable, could be the user's own: any of its user IDs
   * is Veydr's. Another user's process cannot hold a socket created by this user unless one of
   * this user's processes passed it on, and that one then holds it too.
   */
  const couldBeOwn = async (pid: number): Promise<boolean> => {
    let uids: readonly number[] | null
    try {
      uids = parseStatusUids((await fs.readFile(join(root, String(pid), 'status'))).toString('utf8'))
    } catch (error) {
      // Exited: it holds nothing. Otherwise it cannot be ruled out.
      return !isGone(errnoOf(error))
    }
    return uids === null || uids.includes(uid)
  }

  /**
   * Whether a refused process could be the user's own (e.g. non-dumpable or setuid) and so may hold
   * an own socket. Checked only when an own socket has no holder, which is rare: every desktop has
   * many unreadable processes of root.
   */
  const ownRefused = async (denied: readonly number[]): Promise<boolean> => {
    for (const pid of denied) if (await couldBeOwn(pid)) return true
    return false
  }

  /** Records which of `wanted` the process `pid` holds. */
  const readProcess = async (pid: number, wanted: ReadonlySet<number>, holders: Holders): Promise<void> => {
    const dir = join(root, String(pid), 'fd')
    let fds: string[]
    try {
      fds = await fs.readdir(dir)
    } catch (error) {
      const code = errnoOf(error)
      if (isDenied(code)) holders.denied.push(pid)
      else if (!isGone(code)) fail(holders, code)
      return
    }
    let denied = false
    await Promise.all(
      fds.map(async (fd) => {
        let link: string
        try {
          link = await fs.readlink(join(dir, fd))
        } catch (error) {
          const code = errnoOf(error)
          // ENOENT: closed (or the process exited) since the directory was read.
          if (isDenied(code)) denied = true
          else if (!isGone(code)) fail(holders, code)
          return
        }
        const inode = socketInode(link)
        if (inode === null || !wanted.has(inode)) return
        const pids = holders.byInode.get(inode)
        if (pids === undefined) holders.byInode.set(inode, new Set([pid]))
        else pids.add(pid)
      }),
    )
    if (denied) holders.denied.push(pid)
  }

  /** Identity and display name of `pid`; `null` if it exited meanwhile. */
  const describe = async (pid: number, bootId: string): Promise<{ readonly stat: ProcStat; readonly process: PortProcess } | null> => {
    let stat: ProcStat | null
    try {
      stat = parseStat((await fs.readFile(join(root, String(pid), 'stat'))).toString('utf8'))
    } catch {
      return null
    }
    if (stat === null) return null
    let args: string[] = []
    try {
      args = parseCmdline(await fs.readFile(join(root, String(pid), 'cmdline')))
    } catch {
      // Exited meanwhile, or hidden: the kernel's command name is shown instead.
    }
    return { stat, process: { identity: linuxIdentity(bootId, stat), name: displayName(stat, args) } }
  }

  /** Which processes hold the sockets `wanted`. */
  const readHolders = async (wanted: ReadonlySet<number>): Promise<Holders> => {
    const holders: Holders = { byInode: new Map(), denied: [], failures: new Map() }
    if (wanted.size === 0) return holders
    const pids = (await fs.readdir(root)).filter(isPidEntry).map(Number)
    // A few processes at a time: thousands of links queued at once compete with every other file
    // operation for libuv's small thread pool, which is slower overall (measured, task 8.4).
    let next = 0
    const worker = async (): Promise<void> => {
      for (let pid = pids[next++]; pid !== undefined; pid = pids[next++]) await readProcess(pid, wanted, holders)
    }
    await Promise.all(Array.from({ length: PROCESS_CONCURRENCY }, worker))
    if (holders.failures.size > 0) log?.record('warn', 'ports.read-failed', Object.fromEntries(holders.failures))
    return holders
  }

  const ownerOf = (socket: NetSocket, pids: ReadonlySet<number> | undefined, known: ReadonlyMap<number, { stat: ProcStat; process: PortProcess }>, ownHidden: boolean): PortOwner => {
    const processes = [...(pids ?? [])]
      .flatMap((pid) => {
        const found = known.get(pid)
        return found === undefined ? [] : [found]
      })
      // Oldest first: a socket shared with children is normally opened by the oldest holder.
      .sort((a, b) => a.stat.starttime - b.stat.starttime || a.stat.pid - b.stat.pid)
      .map((found) => found.process)
    const [first, ...rest] = processes
    if (first !== undefined) return { kind: 'known', processes: [first, ...rest] }
    if (uid !== ROOT && socket.uid !== uid) return { kind: 'restricted' }
    return { kind: ownHidden ? 'restricted' : 'unknown' }
  }

  /** Whether `socket` would be listed without a holder. */
  const unheld = (socket: NetSocket, holders: Holders, known: ReadonlyMap<number, unknown>): boolean =>
    ![...(holders.byInode.get(socket.inode) ?? [])].some((pid) => known.has(pid))

  return {
    async list(): Promise<PortSnapshot> {
      const takenAt = now()
      const [tcp, tcp6] = await Promise.all([readTable('tcp', 'ipv4'), readTable('tcp6', 'ipv6')])
      const sockets = [...tcp, ...tcp6]
      // Inode 0: the socket has no file, so no process can hold it.
      const holders = await readHolders(new Set(sockets.map((s) => s.inode).filter((inode) => inode !== 0)))

      const bootId = options.bootId()
      const owners = new Set(sockets.flatMap((socket) => [...(holders.byInode.get(socket.inode) ?? [])]))
      const known = new Map<number, { stat: ProcStat; process: PortProcess }>()
      await Promise.all(
        [...owners].map(async (pid) => {
          const found = await describe(pid, bootId)
          if (found !== null) known.set(pid, found)
        }),
      )

      // Only an own socket without holder needs to know whether a refused process could be own.
      const ownUnheld = sockets.some((socket) => (uid === ROOT || socket.uid === uid) && unheld(socket, holders, known))
      const ownHidden = ownUnheld && (await ownRefused(holders.denied))
      const ports: ListeningPort[] = sockets.map((socket) => ({
        family: socket.family,
        address: socket.address,
        port: socket.port,
        owner: ownerOf(socket, holders.byInode.get(socket.inode), known, ownHidden),
      }))
      ports.sort((a, b) => a.port - b.port || compare(a.family, b.family) || compare(a.address, b.address))
      return { takenAt, ports }
    },
  }
}
