import { useEffect, useState, type JSX } from 'react'
import type { ListeningPort, VeydrApi } from '../../shared/api'
import { createPortsPoller, pollWhileVisible, PORTS_POLL_INTERVAL_MS, type PortsState } from './state/ports'
import type { ProjectsState } from './state/projects'
import { useStore } from './state/store'

/** Command names by command ID, as "project › command". */
function commandNames(projects: ProjectsState): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  if (projects.status !== 'ready') return names
  for (const project of projects.projects) for (const command of project.commands) names.set(command.id, `${project.name} › ${command.name}`)
  return names
}

/** Listening TCP ports, read-only (spec: port inspection). */
export function PortsView({ api, projects }: { api: Pick<VeydrApi['ports'], 'list'>; projects: ProjectsState }): JSX.Element {
  const [poller] = useState(() => createPortsPoller(api))
  // Polls while the view is mounted and the window is visible (design D12: every 3 s, only while
  // the ports view is visible).
  useEffect(() => pollWhileVisible(poller, document), [poller])
  return <PortsContent state={useStore(poller)} projects={projects} onRefresh={poller.refresh} />
}

export function PortsContent({ state, projects, onRefresh }: { state: PortsState; projects: ProjectsState; onRefresh: () => void }): JSX.Element {
  const names = commandNames(projects)
  const ports = state.snapshot?.ports ?? []
  const managed = ports.filter((p) => p.owner.kind === 'known' && p.owner.commandId !== null)
  const unsupported = state.error?.code === 'unsupported_platform'
  return (
    <>
      <div className="view-header">
        <h1 id="view-title">Ports</h1>
        {!unsupported && (
          // Stays enabled while a (periodic) request is in flight; a click then refreshes right after it.
          <button type="button" className="button" onClick={onRefresh} aria-busy={state.loading}>
            Refresh
          </button>
        )}
      </div>
      {unsupported ? (
        <div className="banner" role="alert" data-testid="ports-unsupported">
          Port inspection is not yet available on this platform.
        </div>
      ) : (
        <>
          <p className="muted" data-testid="ports-status">
            {state.snapshot === null ? (
              state.error === null && 'Reading listening ports…'
            ) : (
              <>
                Last refreshed{' '}
                <time dateTime={new Date(state.snapshot.refreshedAt).toISOString()} data-testid="ports-refreshed">
                  {new Date(state.snapshot.refreshedAt).toLocaleTimeString()}
                </time>
                {` · refreshed every ${PORTS_POLL_INTERVAL_MS / 1000} s while this view is open`}
              </>
            )}
          </p>
          {state.error !== null && (
            <div className="banner" role="alert">
              Ports could not be read: {state.error.message}
            </div>
          )}
          {state.snapshot !== null && (
            <>
              <section className="ports-section" aria-labelledby="ports-managed">
                <h2 id="ports-managed">Commands</h2>
                {managed.length === 0 ? (
                  <p className="muted">No running command is listening on a TCP port.</p>
                ) : (
                  <PortTable ports={managed} names={names} label="Ports of running commands" testId="ports-managed-table" />
                )}
              </section>
              <section className="ports-section" aria-labelledby="ports-all">
                <h2 id="ports-all">All listening ports</h2>
                {ports.length === 0 ? (
                  <p className="muted">Nothing is listening on a TCP port.</p>
                ) : (
                  <PortTable ports={ports} names={names} label="All listening ports" testId="ports-all-table" />
                )}
                <p className="muted ports-note">
                  Restricted: the port belongs to another user or to the system, and Linux does not show its process to you. Veydr only reads this list; it never stops or signals
                  processes from here.
                </p>
              </section>
            </>
          )}
        </>
      )}
    </>
  )
}

function PortTable({ ports, names, label, testId }: { ports: readonly ListeningPort[]; names: ReadonlyMap<string, string>; label: string; testId: string }): JSX.Element {
  return (
    <table className="ports-table" aria-label={label} data-testid={testId}>
      <thead>
        <tr>
          <th scope="col">Port</th>
          <th scope="col">Address</th>
          <th scope="col">Process</th>
          <th scope="col">Command</th>
        </tr>
      </thead>
      <tbody>
        {ports.map((port, index) => (
          // Several sockets can share address and port (SO_REUSEPORT), so the position disambiguates.
          <PortRow key={`${port.family} ${port.address} ${port.port} ${index}`} port={port} names={names} />
        ))}
      </tbody>
    </table>
  )
}

function PortRow({ port, names }: { port: ListeningPort; names: ReadonlyMap<string, string> }): JSX.Element {
  const { owner } = port
  const managed = owner.kind === 'known' && owner.commandId !== null
  return (
    <tr data-testid="port-row" data-port={port.port} data-family={port.family} data-owner={owner.kind} data-managed={managed ? 'true' : 'false'}>
      <td className="ports-number">{port.port}</td>
      <td>
        <code>{port.address}</code> <span className="muted">{port.family === 'ipv4' ? 'IPv4' : 'IPv6'}</span>
      </td>
      <td data-testid="port-process">
        {owner.kind === 'known' ? (
          <>
            {owner.name} <span className="muted">PID {owner.pid}</span>
          </>
        ) : owner.kind === 'restricted' ? (
          <span className="badge badge-restricted" title="Owned by another user or the system; Linux does not show its process to you.">
            Restricted
          </span>
        ) : (
          <span className="muted" title="The process could not be determined (it may have just exited).">
            Unknown
          </span>
        )}
      </td>
      <td data-testid="port-command">
        {owner.kind !== 'known' ? (
          <span className="muted">—</span>
        ) : owner.commandId === null ? (
          <span className="muted">Not managed</span>
        ) : (
          (names.get(owner.commandId) ?? 'Removed command')
        )}
      </td>
    </tr>
  )
}
