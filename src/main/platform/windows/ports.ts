import { formatIpv4, formatIpv6 } from '../address'
import type { ListeningPort, PlatformLog, PortInspector, PortOwner, PortSnapshot } from '../types'
import { imageName, isFiletime, windowsIdentity } from './identity'
import { parsePortsOutput, type PortsListener, type PortsOwner } from './protocol'

// The Windows port inspector (add-windows-port-inspection design D4). It turns the line that
// `veydr-helper.exe ports` printed into the same `PortSnapshot` the Linux inspector produces. It
// runs nothing itself: `readPorts` is given by the composition root (`createHelperPortsReader`), so
// this module's import closure reaches no process or network module (design D6, checked by
// port-service.test.ts).

export interface WindowsPortInspectorOptions {
  /** Runs `veydr-helper.exe ports` and resolves with its raw stdout. */
  readonly readPorts: () => Promise<string>
  readonly log?: PlatformLog
}

/** 1601-01-01 to 1970-01-01 in FILETIME units (100 ns). */
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n
const FILETIME_PER_MS = 10_000n

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The bytes of a validated lowercase hex address, in the network order the helper wrote them. */
function hexBytes(hex: string): number[] {
  const bytes: number[] = []
  for (let i = 0; i < hex.length; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16))
  return bytes
}

const addressOf = (listener: PortsListener): string => (listener.family === 'ipv4' ? formatIpv4(hexBytes(listener.address)) : formatIpv6(hexBytes(listener.address)))

/**
 * Milliseconds since the Unix epoch of a canonical FILETIME decimal (`isFiletime`), rounded down;
 * `null` before 1970, which no listing can have been taken at. A FILETIME is at most 2^63 - 1, so
 * the result is a safe integer. Throws a `RangeError` for anything that is not such a decimal.
 */
export function filetimeToUnixMs(filetime: string): number | null {
  if (!isFiletime(filetime)) throw new RangeError(`Not a FILETIME: ${JSON.stringify(String(filetime).slice(0, 40))}`)
  const ticks = BigInt(filetime) - FILETIME_UNIX_EPOCH
  return ticks < 0n ? null : Number(ticks / FILETIME_PER_MS)
}

/**
 * What the Ports view shows for a PID's owner entry (design D4). Only a `known` owner, which the
 * helper opened and found created before the fence, is shown by identity; a `reused` PID, a `gone`
 * process (PID 0 included) and an `error` are `unknown`, so a PID that may now name another process
 * is never shown as the holder.
 */
function portOwner(entry: PortsOwner): PortOwner {
  switch (entry.state) {
    case 'known':
      return { kind: 'known', processes: [{ identity: windowsIdentity(entry.pid, entry.created), name: imageName(entry.image) || `PID ${entry.pid}` }] }
    case 'restricted':
      return { kind: 'restricted' }
    case 'gone':
    case 'reused':
    case 'error':
      return { kind: 'unknown' }
  }
}

/**
 * Listening TCP sockets on Windows, IPv4 and IPv6, through the helper's `ports` subcommand. A
 * listing that cannot be read or is malformed rejects with an `Error` naming the helper; nothing of
 * it is shown, as on Linux when a table cannot be read.
 */
export function createWindowsPortInspector(options: WindowsPortInspectorOptions): PortInspector {
  const { readPorts, log } = options

  return {
    async list(): Promise<PortSnapshot> {
      let output: string
      try {
        output = await readPorts()
      } catch (error) {
        throw new Error(`The Windows helper could not list the listening ports: ${messageOf(error)}`, { cause: error })
      }
      let listing
      try {
        listing = parsePortsOutput(output)
      } catch (error) {
        throw new Error(`The Windows helper's port listing was refused: ${messageOf(error)}`, { cause: error })
      }
      const takenAt = filetimeToUnixMs(listing.takenAt)
      if (takenAt === null) throw new Error(`The Windows helper's port listing was refused: it was taken before 1970 (${listing.takenAt})`)

      // The protocol guarantees exactly one owner entry per listener PID.
      const owners = new Map<number, PortOwner>()
      const errors = new Map<string, number>()
      for (const entry of listing.owners) {
        owners.set(entry.pid, portOwner(entry))
        if (entry.state === 'error') errors.set(String(entry.code), (errors.get(String(entry.code)) ?? 0) + 1)
      }
      if (errors.size > 0) log?.record('warn', 'ports.owner-errors', Object.fromEntries(errors))

      const ports: ListeningPort[] = listing.listeners.map((listener) => ({
        family: listener.family,
        address: addressOf(listener),
        port: listener.port,
        owner: owners.get(listener.pid) ?? { kind: 'unknown' },
      }))
      ports.sort((a, b) => a.port - b.port || compare(a.family, b.family) || compare(a.address, b.address))
      return { takenAt, ports }
    },
  }
}
