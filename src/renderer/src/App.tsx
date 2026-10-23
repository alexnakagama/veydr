import { useEffect, useState, type JSX } from 'react'
import type { ApiResult, AppInfo, CommandProcessState, Notice, ProjectView } from '../../shared/api'
import type { Stores } from './state'
import type { ProcessesState } from './state/processes'
import type { ProjectsState } from './state/projects'
import { UNREACHABLE, useStore } from './state/store'

type View = 'projects' | 'about'

const views: readonly { id: View; label: string }[] = [
  { id: 'projects', label: 'Projects' },
  { id: 'about', label: 'About' },
]

export type InfoState = { status: 'loading' } | { status: 'ready'; info: AppInfo } | { status: 'error'; message: string }

function useAppInfo(): InfoState {
  const [state, setState] = useState<InfoState>({ status: 'loading' })
  useEffect(() => {
    let active = true
    window.veydr.app
      .getInfo()
      .then((result: ApiResult<AppInfo>) => {
        if (!active) return
        setState(result.ok ? { status: 'ready', info: result.value } : { status: 'error', message: result.error.message })
      })
      .catch(() => {
        if (active) setState({ status: 'error', message: UNREACHABLE })
      })
    return () => {
      active = false
    }
  }, [])
  return state
}

export function App({ stores }: { stores: Stores }): JSX.Element {
  const info = useAppInfo()
  const notices = useStore(stores.notices)
  const projects = useStore(stores.projects)
  const processes = useStore(stores.processes)
  return (
    <Shell
      info={info}
      notices={notices.visible}
      noticeError={notices.error}
      onDismissNotice={(id) => stores.notices.dismiss(id)}
      projects={projects}
      processes={processes}
    />
  )
}

export interface ShellProps {
  readonly info: InfoState
  readonly notices: readonly Notice[]
  /** Why notices cannot be received, if they cannot. */
  readonly noticeError: string | null
  readonly onDismissNotice: (id: string) => void
  readonly projects: ProjectsState
  readonly processes: ProcessesState
}

/** The window layout for given states; separate from `App` so it renders without IPC. */
export function Shell({ info, notices, noticeError, onDismissNotice, projects, processes }: ShellProps): JSX.Element {
  const [view, setView] = useState<View>('projects')

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Sidebar">
        <div className="brand">Veydr</div>
        <nav aria-label="Main">
          <ul className="nav-list">
            {views.map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  className="nav-item"
                  aria-current={view === v.id ? 'page' : undefined}
                  onClick={() => setView(v.id)}
                >
                  {v.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <section className="sidebar-section" aria-labelledby="sidebar-projects">
          <h2 id="sidebar-projects" className="sidebar-heading">
            Projects
          </h2>
          {projects.status === 'ready' && projects.projects.length > 0 ? (
            <ul className="sidebar-projects" data-testid="sidebar-projects">
              {projects.projects.map((project) => (
                <li key={project.id}>{project.name}</li>
              ))}
            </ul>
          ) : (
            <p className="sidebar-empty">{projects.status === 'loading' ? 'Loading…' : 'No projects'}</p>
          )}
        </section>
        <footer className="sidebar-footer" data-testid="app-info-summary">
          {info.status === 'ready' ? `${info.info.name} ${info.info.version} · ${info.info.platform}` : ' '}
        </footer>
      </aside>

      <main className="content" aria-labelledby="view-title">
        {info.status === 'ready' && !info.info.platformSupported && (
          <div className="banner" role="alert">
            Process features are not available on this platform.
          </div>
        )}
        {info.status === 'error' && (
          <div className="banner" role="alert">
            {info.message}
          </div>
        )}
        {noticeError !== null && (
          <div className="banner" role="alert">
            Notices are unavailable: {noticeError}
          </div>
        )}
        {notices.length > 0 && <Notices notices={notices} onDismiss={onDismissNotice} />}
        {view === 'projects' ? <ProjectsView projects={projects} processes={processes} /> : <AboutView info={info} />}
      </main>
    </div>
  )
}

function Notices({ notices, onDismiss }: { notices: readonly Notice[]; onDismiss: (id: string) => void }): JSX.Element {
  return (
    <section className="notices" aria-label="Notices">
      {notices.map((notice) => (
        <div
          key={notice.id}
          className={`banner notice notice-${notice.severity}`}
          role={notice.severity === 'error' ? 'alert' : 'status'}
          data-testid="notice"
          data-kind={notice.kind}
        >
          <div className="notice-body">
            <p className="notice-message">{notice.message}</p>
            {notice.files.length > 0 && (
              <ul className="notice-files" aria-label="Files">
                {notice.files.map((file) => (
                  <li key={file}>
                    <code>{file}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button type="button" className="notice-dismiss" onClick={() => onDismiss(notice.id)}>
            Dismiss
          </button>
        </div>
      ))}
    </section>
  )
}

const statusLabels: Readonly<Record<CommandProcessState['status'], string>> = {
  idle: 'Idle',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  exited: 'Exited',
  failed: 'Failed',
}

function ProjectsView({ projects, processes }: { projects: ProjectsState; processes: ProcessesState }): JSX.Element {
  return (
    <>
      <h1 id="view-title">Projects</h1>
      {projects.status === 'loading' && <p className="muted">Loading projects…</p>}
      {projects.status === 'error' && (
        <div className="banner" role="alert">
          Projects could not be loaded: {projects.message}
        </div>
      )}
      {processes.status === 'error' && (
        <div className="banner" role="alert">
          Process states could not be loaded: {processes.error}
        </div>
      )}
      {processes.liveError !== null && (
        <div className="banner" role="alert">
          Live process updates are unavailable, so states may be outdated: {processes.liveError}
        </div>
      )}
      {projects.status === 'ready' &&
        (projects.projects.length === 0 ? (
          <div className="empty-state" data-testid="empty-projects">
            <h2>No projects yet</h2>
            <p>Projects you register will appear here with their commands, logs, and ports.</p>
          </div>
        ) : (
          projects.projects.map((project) => <ProjectSection key={project.id} project={project} processes={processes} />)
        ))}
    </>
  )
}

function ProjectSection({ project, processes }: { project: ProjectView; processes: ProcessesState }): JSX.Element {
  const headingId = `project-${project.id}`
  return (
    <section className="project" aria-labelledby={headingId} data-testid="project">
      <h2 id={headingId}>{project.name}</h2>
      <p className="project-path">{project.path}</p>
      {project.commands.length === 0 ? (
        <p className="muted">No commands</p>
      ) : (
        <ul className="command-list" aria-label={`Commands of ${project.name}`}>
          {project.commands.map((command) => {
            const state = processes.commands.get(command.id)
            const label = processes.status === 'loading' ? '…' : statusLabels[state?.status ?? 'idle']
            return (
              <li key={command.id} className="command" data-testid="command" data-command-id={command.id}>
                <span className="command-name">{command.name}</span>
                <span className={`status status-${state?.status ?? 'idle'}`} data-testid="command-status">
                  {label}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function AboutView({ info }: { info: InfoState }): JSX.Element {
  return (
    <>
      <h1 id="view-title">About</h1>
      {info.status === 'ready' ? (
        <dl className="info-list" data-testid="app-info">
          <dt>Version</dt>
          <dd>{info.info.version}</dd>
          <dt>Platform</dt>
          <dd>{info.info.platformSupported ? info.info.platform : `${info.info.platform} (not supported)`}</dd>
          <dt>Electron</dt>
          <dd>{info.info.versions.electron}</dd>
          <dt>Chromium</dt>
          <dd>{info.info.versions.chrome}</dd>
          <dt>Node.js</dt>
          <dd>{info.info.versions.node}</dd>
        </dl>
      ) : (
        <p>{info.status === 'loading' ? 'Loading…' : 'Application information is unavailable.'}</p>
      )}
    </>
  )
}
