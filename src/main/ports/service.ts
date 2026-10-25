import type { ListeningPort, PortOwner, PortSnapshot } from '../../shared/api'
import type { PortInspector, PortOwner as PlatformPortOwner, ProcessIdentity } from '../platform/types'

/** The processes of one command's current run (an attribution set, design D8). */
export interface CommandProcesses {
  readonly commandId: string
  readonly processes: readonly ProcessIdentity[]
}

/**
 * What the ports service may use. Deliberately read-only: listing sockets and reading attribution
 * sets. It has no access to the supervisor's lifecycle actions or to any signalling API (spec:
 * read-only inspection).
 */
export interface PortServiceDeps {
  readonly inspector: PortInspector
  readonly attribution: () => Promise<readonly CommandProcesses[]>
}

export interface PortService {
  /** Every listening TCP socket visible to the user, each attributed to a command where possible. */
  list(): Promise<PortSnapshot>
}

const identityKey = (identity: ProcessIdentity): string => `${identity.pid}:${identity.token}`

/**
 * Port inspection (design D12). A port belongs to a command if a process holding it is in the
 * command's attribution set, identified by PID and start time, so a reused PID never matches.
 */
export function createPortService(deps: PortServiceDeps): PortService {
  return {
    async list() {
      // Read together, so attribution is observed as close as possible to the socket read.
      const [snapshot, attribution] = await Promise.all([deps.inspector.list(), deps.attribution()])
      const commandOf = new Map<string, string>()
      for (const { commandId, processes } of attribution) {
        for (const identity of processes) commandOf.set(identityKey(identity), commandId)
      }
      const ports: ListeningPort[] = snapshot.ports.map((port) => ({
        family: port.family,
        address: port.address,
        port: port.port,
        owner: ownerView(port.owner, commandOf),
      }))
      return { refreshedAt: snapshot.takenAt, ports }
    },
  }
}

/** The holder shown for a socket: the oldest holder that belongs to a command, else the oldest. */
function ownerView(owner: PlatformPortOwner, commandOf: ReadonlyMap<string, string>): PortOwner {
  if (owner.kind !== 'known') return { kind: owner.kind }
  const managed = owner.processes.find((p) => commandOf.has(identityKey(p.identity)))
  const shown = managed ?? owner.processes[0]
  return {
    kind: 'known',
    pid: shown.identity.pid,
    name: shown.name,
    commandId: managed === undefined ? null : (commandOf.get(identityKey(managed.identity)) ?? null),
  }
}
