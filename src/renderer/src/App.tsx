import { useEffect, useState, type JSX } from 'react'
import type { ApiResult, AppInfo } from '../../shared/api'

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
        if (active) setState({ status: 'error', message: 'Could not reach the application.' })
      })
    return () => {
      active = false
    }
  }, [])
  return state
}

export function App(): JSX.Element {
  return <Shell info={useAppInfo()} />
}

/** The window layout for a given application-info state; separate from `App` so it renders without IPC. */
export function Shell({ info }: { info: InfoState }): JSX.Element {
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
          <p className="sidebar-empty">No projects</p>
        </section>
        <footer className="sidebar-footer" data-testid="app-info-summary">
          {info.status === 'ready' ? `${info.info.name} ${info.info.version} · ${info.info.platform}` : ' '}
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
        {view === 'projects' ? <ProjectsView /> : <AboutView info={info} />}
      </main>
    </div>
  )
}

function ProjectsView(): JSX.Element {
  return (
    <>
      <h1 id="view-title">Projects</h1>
      <div className="empty-state" data-testid="empty-projects">
        <h2>No projects yet</h2>
        <p>Projects you register will appear here with their commands, logs, and ports.</p>
      </div>
    </>
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
