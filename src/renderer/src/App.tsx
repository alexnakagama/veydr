import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { ApiResult, AppInfo, CommandProcessState, CommandView, Notice, ProjectView } from '../../shared/api'
import { CommandEditor } from './CommandEditor'
import { ConfirmDialog } from './components/Modal'
import { EnvironmentDialog } from './EnvironmentDialog'
import { describeExit, describeSurvivors, formatUptime } from './process-format'
import { AddProjectDialog, RenameProjectDialog } from './ProjectDialogs'
import { SettingsView } from './SettingsView'
import { ShortcutsDialog, shortcutFor, type ShortcutCommand } from './shortcuts'
import type { Stores } from './state'
import { createProjectActions, type ProjectActions } from './state/actions'
import { createLifecycleRequest, type LifecycleAction, type LifecycleRequest } from './state/lifecycle'
import type { ProcessesState } from './state/processes'
import { loadProjects, type ProjectsState } from './state/projects'
import { UNREACHABLE, useStore } from './state/store'
import { createSurvivorRequest, type SurvivorAction, type SurvivorRequest } from './state/survivors'

type View = 'projects' | 'settings' | 'about'

const views: readonly { id: View; label: string }[] = [
  { id: 'projects', label: 'Projects' },
  { id: 'settings', label: 'Settings' },
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
  const onLifecycle = useMemo((): LifecycleRequest => {
    const request = createLifecycleRequest(window.veydr.processes)
    // A start may fail because a folder went missing (main checks before every start): refresh
    // the project list after starts and after any refused action.
    return async (action, commandId) => {
      const message = await request(action, commandId)
      if (message !== null || action !== 'stop') await loadProjects(stores.projects, window.veydr.projects)
      return message
    }
  }, [stores.projects])
  const onResolveSurvivors = useMemo(() => createSurvivorRequest(window.veydr.processes), [])
  const actions = useMemo(() => createProjectActions(window.veydr, () => loadProjects(stores.projects, window.veydr.projects)), [stores.projects])
  return (
    <Shell
      info={info}
      notices={notices.visible}
      noticeError={notices.error}
      onDismissNotice={(id) => stores.notices.dismiss(id)}
      onResolveSurvivors={onResolveSurvivors}
      projects={projects}
      processes={processes}
      onLifecycle={onLifecycle}
      actions={actions}
    />
  )
}

export interface ShellProps {
  readonly info: InfoState
  readonly notices: readonly Notice[]
  /** Why notices cannot be received, if they cannot. */
  readonly noticeError: string | null
  readonly onDismissNotice: (id: string) => void
  readonly onResolveSurvivors: SurvivorRequest
  readonly projects: ProjectsState
  readonly processes: ProcessesState
  readonly onLifecycle: LifecycleRequest
  readonly actions: ProjectActions
}

/** A dialog the shell shows over everything else; at most one at a time. */
type DialogState =
  | { readonly kind: 'add-project'; readonly path: string }
  | { readonly kind: 'rename-project'; readonly project: ProjectView }
  | { readonly kind: 'remove-project'; readonly project: ProjectView }
  | { readonly kind: 'edit-command'; readonly project: ProjectView; readonly command: CommandView | null }
  | { readonly kind: 'remove-command'; readonly command: CommandView }
  | { readonly kind: 'environment'; readonly command: CommandView }
  | { readonly kind: 'shortcuts' }

/** A lifecycle request in progress or its failure, per command. */
interface LifecycleUi {
  readonly pending: LifecycleAction | null
  readonly error: { readonly action: LifecycleAction; readonly message: string } | null
}

const idleLifecycle: LifecycleUi = { pending: null, error: null }

/** Which lifecycle actions apply to a command in `status` (none while its folder is missing). */
function enabledActions(status: CommandProcessState['status'], missing: boolean): Readonly<Record<LifecycleAction, boolean>> {
  return {
    start: !missing && (status === 'idle' || status === 'exited' || status === 'failed'),
    stop: status === 'running',
    restart: !missing && status === 'running',
  }
}

/** Projects whose name, or one of whose commands' names, contains `filter` (case-insensitive). */
function filterProjects(projects: readonly ProjectView[], filter: string): readonly ProjectView[] {
  const needle = filter.trim().toLowerCase()
  if (needle === '') return projects
  return projects.filter((p) => p.name.toLowerCase().includes(needle) || p.commands.some((c) => c.name.toLowerCase().includes(needle)))
}

/** The window layout for given states; separate from `App` so it renders without IPC. */
export function Shell({ info, notices, noticeError, onDismissNotice, onResolveSurvivors, projects, processes, onLifecycle, actions }: ShellProps): JSX.Element {
  const [view, setView] = useState<View>('projects')
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<{ projectId: string | null; commandId: string | null }>({ projectId: null, commandId: null })
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)
  const [lifecycle, setLifecycle] = useState<ReadonlyMap<string, LifecycleUi>>(new Map())
  const filterRef = useRef<HTMLInputElement>(null)
  const quitting = notices.find((notice) => notice.kind === 'quitting')
  const banners = notices.filter((notice) => notice.kind !== 'quitting')
  const visibleProjects = useMemo(() => (projects.status === 'ready' ? filterProjects(projects.projects, filter) : []), [projects, filter])

  const openDialog = (next: DialogState | null): void => {
    setDialog(next)
    setDialogBusy(false)
    setDialogError(null)
  }

  const requestLifecycle = useCallback(
    (action: LifecycleAction, commandId: string): void => {
      setLifecycle((current) => new Map(current).set(commandId, { pending: action, error: null }))
      void onLifecycle(action, commandId).then((message) =>
        setLifecycle((current) => new Map(current).set(commandId, { pending: null, error: message === null ? null : { action, message } })),
      )
    },
    [onLifecycle],
  )

  const addProject = (): void => {
    setPickError(null)
    void actions.pickDirectory().then((result) => {
      if (!result.ok) return setPickError(result.message)
      if (result.value !== null) openDialog({ kind: 'add-project', path: result.value })
    })
  }

  /** Runs a confirmed destructive action; the dialog stays open with the reason if it is refused. */
  const confirm = (run: () => Promise<{ ok: boolean; message?: string }>): void => {
    setDialogBusy(true)
    setDialogError(null)
    void run().then((result) => {
      setDialogBusy(false)
      if (result.ok) openDialog(null)
      else setDialogError(result.message ?? 'The request failed.')
    })
  }

  const selectProject = (projectId: string, focus: boolean): void => {
    const project = visibleProjects.find((p) => p.id === projectId)
    setSelected({ projectId, commandId: project?.commands[0]?.id ?? null })
    if (focus) document.getElementById(`project-${projectId}`)?.focus()
  }

  // Keyboard shortcuts (outside text fields and dialogs); see `shortcuts.tsx`.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (quitting !== undefined || dialog !== null || view !== 'projects') {
        if (shortcutFor(event) === 'help' && quitting === undefined && dialog === null) openDialog({ kind: 'shortcuts' })
        return
      }
      const shortcut: ShortcutCommand | null = shortcutFor(event)
      if (shortcut === null) return
      event.preventDefault()
      if (shortcut === 'help') return openDialog({ kind: 'shortcuts' })
      if (shortcut === 'filter') return filterRef.current?.focus()
      if (shortcut === 'next-project' || shortcut === 'previous-project') {
        if (visibleProjects.length === 0) return
        const index = visibleProjects.findIndex((p) => p.id === selected.projectId)
        const step = shortcut === 'next-project' ? 1 : -1
        const next = index === -1 ? (step === 1 ? 0 : visibleProjects.length - 1) : (index + step + visibleProjects.length) % visibleProjects.length
        const project = visibleProjects[next]
        if (project !== undefined) selectProject(project.id, true)
        return
      }
      const commandId = selected.commandId
      if (commandId === null) return
      const project = visibleProjects.find((p) => p.commands.some((c) => c.id === commandId))
      if (project === undefined) return
      const status = processes.commands.get(commandId)?.status ?? 'idle'
      const pending = lifecycle.get(commandId)?.pending ?? null
      if (processes.status !== 'loading' && pending === null && enabledActions(status, project.missing)[shortcut]) requestLifecycle(shortcut, commandId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <>
      <div className="shell" inert={quitting !== undefined}>
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
            <input
              ref={filterRef}
              type="search"
              className="sidebar-filter"
              aria-label="Filter projects"
              placeholder="Filter (/)"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {projects.status === 'ready' && projects.projects.length > 0 ? (
              <ul className="sidebar-projects" data-testid="sidebar-projects">
                {visibleProjects.map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      className="sidebar-project"
                      aria-current={selected.projectId === project.id ? 'true' : undefined}
                      onClick={() => {
                        setView('projects')
                        selectProject(project.id, false)
                      }}
                    >
                      {project.name}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="sidebar-empty">{projects.status === 'loading' ? 'Loading…' : 'No projects'}</p>
            )}
          </section>
          <button type="button" className="sidebar-link" onClick={() => openDialog({ kind: 'shortcuts' })}>
            Keyboard shortcuts (?)
          </button>
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
          {banners.length > 0 && <Notices notices={banners} onDismiss={onDismissNotice} onResolveSurvivors={onResolveSurvivors} />}
          {view === 'projects' && (
            <ProjectsView
              projects={projects}
              visible={visibleProjects}
              filtered={filter.trim() !== ''}
              processes={processes}
              lifecycle={lifecycle}
              onLifecycle={requestLifecycle}
              selectedCommandId={selected.commandId}
              onSelect={(projectId, commandId) => setSelected({ projectId, commandId })}
              onAddProject={addProject}
              pickError={pickError}
              actions={actions}
              onDialog={openDialog}
            />
          )}
          {view === 'settings' && <SettingsView actions={actions} />}
          {view === 'about' && <AboutView info={info} />}
        </main>
      </div>
      {dialog?.kind === 'add-project' && (
        <AddProjectDialog
          path={dialog.path}
          actions={actions}
          onAdded={(project) => {
            openDialog(null)
            setSelected({ projectId: project.id, commandId: null })
          }}
          onClose={() => openDialog(null)}
        />
      )}
      {dialog?.kind === 'rename-project' && <RenameProjectDialog project={dialog.project} actions={actions} onClose={() => openDialog(null)} />}
      {dialog?.kind === 'remove-project' && (
        <ConfirmDialog
          title={`Remove ${dialog.project.name}?`}
          message={
            <p>
              The project and its {dialog.project.commands.length === 1 ? 'command' : `${dialog.project.commands.length} commands`} are removed from Veydr. Nothing in{' '}
              <code>{dialog.project.path}</code> is changed or deleted.
            </p>
          }
          confirmLabel="Remove project"
          pending={dialogBusy}
          error={dialogError}
          onCancel={() => openDialog(null)}
          onConfirm={() => confirm(() => actions.removeProject(dialog.project.id))}
        />
      )}
      {dialog?.kind === 'edit-command' && (
        <CommandEditor
          projectId={dialog.project.id}
          projectName={dialog.project.name}
          command={dialog.command}
          actions={actions}
          onSaved={(command) => {
            openDialog(null)
            setSelected({ projectId: dialog.project.id, commandId: command.id })
          }}
          onClose={() => openDialog(null)}
        />
      )}
      {dialog?.kind === 'remove-command' && (
        <ConfirmDialog
          title={`Remove ${dialog.command.name}?`}
          message={<p>The command is removed from Veydr. Its project folder is not changed.</p>}
          confirmLabel="Remove command"
          pending={dialogBusy}
          error={dialogError}
          onCancel={() => openDialog(null)}
          onConfirm={() => confirm(() => actions.removeCommand(dialog.command.id))}
        />
      )}
      {dialog?.kind === 'environment' && (
        <EnvironmentDialog
          commandId={dialog.command.id}
          commandName={dialog.command.name}
          actions={actions}
          // Main withdraws obsolete environment notices only for windows that subscribe later; hide them here.
          onRefreshed={(warnings) => {
            for (const notice of notices) if (notice.kind === 'environment' && !warnings.includes(notice.message)) onDismissNotice(notice.id)
          }}
          onClose={() => openDialog(null)}
        />
      )}
      {dialog?.kind === 'shortcuts' && <ShortcutsDialog onClose={() => openDialog(null)} />}
      {quitting !== undefined && <QuitOverlay notice={quitting} projects={projects} processes={processes} />}
    </>
  )
}

interface NoticesProps {
  readonly notices: readonly Notice[]
  readonly onDismiss: (id: string) => void
  readonly onResolveSurvivors: SurvivorRequest
}

function Notices({ notices, onDismiss, onResolveSurvivors }: NoticesProps): JSX.Element {
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
            {notice.processes !== undefined && notice.processes.length > 0 && (
              <ul className="notice-processes" aria-label="Processes" data-testid="notice-processes">
                {notice.processes.map((p) => (
                  <li key={p.pid} data-testid="notice-process">
                    <span className="notice-process-name">{p.name}</span> <span className="muted">PID {p.pid}</span>
                    <code className="notice-process-command">{p.commandLine === '' ? '(command line unavailable)' : p.commandLine}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {notice.kind === 'crash-survivors' ? (
            <SurvivorActions onResolve={onResolveSurvivors} onResolved={() => onDismiss(notice.id)} />
          ) : (
            <button type="button" className="notice-dismiss" onClick={() => onDismiss(notice.id)}>
              Dismiss
            </button>
          )}
        </div>
      ))}
    </section>
  )
}

const survivorLabels: Readonly<Record<SurvivorAction, string>> = { terminate: 'Terminate', dismiss: 'Leave running' }

/** Survivors are terminated only on this explicit choice (spec: survivors after crash). */
function SurvivorActions({ onResolve, onResolved }: { onResolve: SurvivorRequest; onResolved: () => void }): JSX.Element {
  const [pending, setPending] = useState<SurvivorAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const resolve = (action: SurvivorAction): void => {
    setPending(action)
    setError(null)
    void onResolve(action).then((outcome) => {
      setPending(null)
      // Survivors that could not be terminated arrive as a new notice.
      if (outcome.ok) onResolved()
      else setError(outcome.message)
    })
  }
  return (
    <div className="notice-actions">
      {(['terminate', 'dismiss'] as const).map((action) => (
        <button key={action} type="button" className="notice-dismiss" disabled={pending !== null} onClick={() => resolve(action)}>
          {pending === action ? `${survivorLabels[action]}…` : survivorLabels[action]}
        </button>
      ))}
      {error !== null && (
        <p className="notice-action-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

const activeStatuses: ReadonlySet<CommandProcessState['status']> = new Set(['starting', 'running', 'stopping'])

/** Covers the window while Veydr stops every command before quitting (design D10). */
function QuitOverlay({ notice, projects, processes }: { notice: Notice; projects: ProjectsState; processes: ProcessesState }): JSX.Element {
  const commands = projects.status === 'ready' ? projects.projects.flatMap((project) => project.commands) : []
  const active = commands.filter((command) => {
    const status = processes.commands.get(command.id)?.status
    return status !== undefined && activeStatuses.has(status)
  })
  return (
    <div className="quit-overlay" role="alertdialog" aria-modal="true" aria-labelledby="quit-overlay-title" data-testid="quit-overlay">
      <div className="quit-overlay-panel">
        <h2 id="quit-overlay-title">{notice.message}</h2>
        {active.length > 0 && (
          <ul className="quit-overlay-list" aria-label="Commands being stopped">
            {active.map((command) => (
              <li key={command.id}>
                {command.name} <span className="muted">{statusLabels[processes.commands.get(command.id)?.status ?? 'idle']}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
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

interface ProjectsViewProps {
  readonly projects: ProjectsState
  /** The projects shown (after the filter). */
  readonly visible: readonly ProjectView[]
  readonly filtered: boolean
  readonly processes: ProcessesState
  readonly lifecycle: ReadonlyMap<string, LifecycleUi>
  readonly onLifecycle: (action: LifecycleAction, commandId: string) => void
  readonly selectedCommandId: string | null
  readonly onSelect: (projectId: string, commandId: string) => void
  readonly onAddProject: () => void
  readonly pickError: string | null
  readonly actions: ProjectActions
  readonly onDialog: (dialog: DialogState) => void
}

function ProjectsView(props: ProjectsViewProps): JSX.Element {
  const { projects, visible, filtered, processes, onAddProject, pickError } = props
  return (
    <>
      <div className="view-header">
        <h1 id="view-title">Projects</h1>
        <button type="button" className="button button-primary" onClick={onAddProject}>
          Add project
        </button>
      </div>
      {pickError !== null && (
        <div className="banner" role="alert">
          {pickError}
        </div>
      )}
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
        ) : visible.length === 0 && filtered ? (
          <p className="muted">No project matches the filter.</p>
        ) : (
          visible.map((project) => <ProjectSection key={project.id} project={project} {...props} />)
        ))}
    </>
  )
}

type ProjectSectionProps = { readonly project: ProjectView } & Omit<ProjectsViewProps, 'projects' | 'visible' | 'filtered' | 'onAddProject' | 'pickError'>

function ProjectSection({ project, processes, lifecycle, onLifecycle, selectedCommandId, onSelect, actions, onDialog }: ProjectSectionProps): JSX.Element {
  const headingId = `project-heading-${project.id}`
  const [problem, setProblem] = useState<string | null>(null)
  const run = (request: () => Promise<{ ok: boolean; message?: string }>): void => {
    setProblem(null)
    void request().then((result) => {
      if (!result.ok) setProblem(result.message ?? 'The request failed.')
    })
  }
  const relocate = (): void =>
    run(async () => {
      const picked = await actions.pickDirectory()
      if (!picked.ok || picked.value === null) return picked.ok ? { ok: true } : picked
      return actions.relocateProject(project.id, picked.value)
    })

  return (
    <section id={`project-${project.id}`} tabIndex={-1} className="project" aria-labelledby={headingId} data-testid="project" data-project-id={project.id}>
      <div className="project-header">
        <h2 id={headingId}>{project.name}</h2>
        {project.missing && (
          <span className="badge badge-warning" data-testid="project-missing-badge">
            Folder missing
          </span>
        )}
      </div>
      <p className="project-path">{project.path}</p>
      {project.missing && (
        <p className="command-problem" data-testid="project-missing">
          This folder does not exist (or is not a folder), so its commands cannot start. Relocate the project if it has moved.
        </p>
      )}
      <div className="project-actions">
        <button type="button" className="button" aria-label={`Add command to ${project.name}`} onClick={() => onDialog({ kind: 'edit-command', project, command: null })}>
          Add command
        </button>
        <button type="button" className="button" aria-label={`Open folder of ${project.name}`} onClick={() => run(() => actions.openFolder(project.id))}>
          Open folder
        </button>
        <button type="button" className="button" aria-label={`Open ${project.name} in editor`} onClick={() => run(() => actions.openInEditor(project.id))}>
          Open in editor
        </button>
        <button type="button" className="button" aria-label={`Rename ${project.name}`} onClick={() => onDialog({ kind: 'rename-project', project })}>
          Rename
        </button>
        <button type="button" className="button" aria-label={`Relocate ${project.name}`} onClick={relocate}>
          Relocate…
        </button>
        <button type="button" className="button button-danger" aria-label={`Remove ${project.name}`} onClick={() => onDialog({ kind: 'remove-project', project })}>
          Remove
        </button>
      </div>
      {problem !== null && (
        <p className="command-problem" role="alert" data-testid="project-problem">
          {problem}
        </p>
      )}
      {project.commands.length === 0 ? (
        <p className="muted">No commands</p>
      ) : (
        <ul className="command-list" aria-label={`Commands of ${project.name}`}>
          {project.commands.map((command) => (
            <CommandRow
              key={command.id}
              command={command}
              missing={project.missing}
              state={processes.commands.get(command.id)}
              loading={processes.status === 'loading'}
              ui={lifecycle.get(command.id) ?? idleLifecycle}
              selected={selectedCommandId === command.id}
              onSelect={() => onSelect(project.id, command.id)}
              onLifecycle={onLifecycle}
              onEdit={() => onDialog({ kind: 'edit-command', project, command })}
              onEnvironment={() => onDialog({ kind: 'environment', command })}
              onRemove={() => onDialog({ kind: 'remove-command', command })}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

const actionLabels: Readonly<Record<LifecycleAction, string>> = { start: 'Start', stop: 'Stop', restart: 'Restart' }

/** Current time, updated every second while `active`. */
function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/** How a command runs, as one line; arguments with spaces or quotes are shown quoted. */
export function describeExecution(execution: CommandView['execution']): string {
  if (execution.mode === 'shell') return execution.script
  const quote = (arg: string): string => (arg === '' || /[\s"'\\]/.test(arg) ? JSON.stringify(arg) : arg)
  return [execution.file, ...execution.args].map(quote).join(' ')
}

interface CommandRowProps {
  readonly command: CommandView
  readonly missing: boolean
  readonly state: CommandProcessState | undefined
  readonly loading: boolean
  readonly ui: LifecycleUi
  readonly selected: boolean
  readonly onSelect: () => void
  readonly onLifecycle: (action: LifecycleAction, commandId: string) => void
  readonly onEdit: () => void
  readonly onEnvironment: () => void
  readonly onRemove: () => void
}

function CommandRow({ command, missing, state, loading, ui, selected, onSelect, onLifecycle, onEdit, onEnvironment, onRemove }: CommandRowProps): JSX.Element {
  const status = state?.status ?? 'idle'
  const now = useClock(status === 'running')
  const enabled = enabledActions(status, missing)

  return (
    <li className={`command${selected ? ' command-selected' : ''}`} data-testid="command" data-command-id={command.id} aria-current={selected ? 'true' : undefined} onFocus={onSelect} onClick={onSelect}>
      <div className="command-main">
        <span className="command-name">{command.name}</span>
        {command.execution.mode === 'shell' && (
          <span className="badge" data-testid="command-shell-label">
            Shell: {command.execution.shell}
          </span>
        )}
        <span className={`status status-${status}`} data-testid="command-status">
          {loading ? '…' : statusLabels[status]}
        </span>
        <CommandDetail state={state} now={now} />
        <span className="command-actions">
          {(['start', 'stop', 'restart'] as const).map((action) => (
            <button
              key={action}
              type="button"
              className="command-action"
              aria-label={`${actionLabels[action]} ${command.name}`}
              disabled={loading || ui.pending !== null || !enabled[action]}
              onClick={() => onLifecycle(action, command.id)}
            >
              {actionLabels[action]}
            </button>
          ))}
          <button type="button" className="command-action" aria-label={`Edit ${command.name}`} onClick={onEdit}>
            Edit
          </button>
          <button type="button" className="command-action" aria-label={`Environment of ${command.name}`} onClick={onEnvironment}>
            Env
          </button>
          <button type="button" className="command-action" aria-label={`Remove ${command.name}`} onClick={onRemove}>
            Remove
          </button>
        </span>
      </div>
      <code className="command-line" data-testid="command-line">
        {describeExecution(command.execution)}
      </code>
      {state?.status === 'exited' && state.error !== null && (
        <p className="command-problem" role="alert" data-testid="command-stop-error">
          {state.error}
        </p>
      )}
      {state !== undefined && state.survivors.length > 0 && (
        <p className="command-problem" role="alert" data-testid="command-survivors">
          {describeSurvivors(state.survivors)}
        </p>
      )}
      {ui.error !== null && (
        <p className="command-problem" role="alert" data-testid="command-action-error">
          {`${actionLabels[ui.error.action]} failed: ${ui.error.message}`}
        </p>
      )}
    </li>
  )
}

function CommandDetail({ state, now }: { state: CommandProcessState | undefined; now: number }): JSX.Element | null {
  if (state === undefined) return null
  let text: string | null = null
  switch (state.status) {
    case 'running':
      text = `PID ${state.pid ?? '?'} · up ${formatUptime(now - (state.startedAt ?? now))}`
      break
    case 'stopping':
      text = state.pid === null ? 'Stopping remaining processes…' : `Stopping PID ${state.pid}…`
      break
    case 'exited':
      text = describeExit(state.exit)
      break
    case 'failed':
      text = state.error ?? 'Could not start'
      break
    default:
      text = null
  }
  if (text === null) return null
  return (
    <span className={`command-detail${state.status === 'failed' ? ' command-detail-error' : ''}`} data-testid="command-detail">
      {text}
    </span>
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
