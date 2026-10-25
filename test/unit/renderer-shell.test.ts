import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Shell, type InfoState, type ShellProps } from '../../src/renderer/src/App'
import type { ProjectActions } from '../../src/renderer/src/state/actions'
import { createLogViewStore } from '../../src/renderer/src/state/logs'
import type { ProcessesState } from '../../src/renderer/src/state/processes'
import type { AppInfo, CommandProcessState, Notice, ProjectView } from '../../src/shared/api'

const info = (overrides: Partial<AppInfo>): InfoState => ({
  status: 'ready',
  info: {
    name: 'Veydr',
    version: '0.0.0',
    platform: 'linux',
    platformSupported: true,
    versions: { electron: '44.9.3', chrome: '1', node: '24' },
    ...overrides,
  },
})

/** Project actions that fail; rendering never calls them. */
const noActions = new Proxy({} as ProjectActions, { get: () => () => Promise.resolve({ ok: false, message: 'unused' }) })

const noProcesses: ProcessesState = { status: 'ready', error: null, liveError: null, commands: new Map() }

const render = (state: InfoState, overrides: Partial<ShellProps> = {}): string =>
  renderToStaticMarkup(
    createElement(Shell, {
      info: state,
      notices: [],
      noticeError: null,
      onDismissNotice: () => undefined,
      onResolveSurvivors: () => Promise.resolve({ ok: true as const, remaining: [] }),
      projects: { status: 'ready', projects: [] },
      processes: noProcesses,
      onLifecycle: () => Promise.resolve(null),
      actions: noActions,
      logs: createLogViewStore({ read: () => new Promise(() => undefined), clear: () => new Promise(() => undefined) }),
      ...overrides,
    }),
  )

const commandId = '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01'
const shop: ProjectView = {
  id: '7a2e9b5d-4d2f-4f66-8b8c-1e7e2a3c0b12',
  name: 'shop',
  path: '/home/dev/shop',
  missing: false,
  commands: [
    {
      id: commandId,
      name: 'api <b>server</b>',
      execution: { mode: 'direct', file: 'npm', args: [] },
      cwd: '.',
      env: [{ key: 'TOKEN', secret: true, value: null }],
      stopTimeoutMs: 5000,
    },
  ],
}

describe('renderer shell', () => {
  it('[spec:desktop-shell/unsupported-platform-operation] tells the user when the platform is unsupported', () => {
    const html = render(info({ platform: 'unsupported', platformSupported: false }))
    expect(html).toContain('role="alert"')
    expect(html).toContain('Process features are not available on this platform.')
  })

  it('shows no alert on a supported platform', () => {
    expect(render(info({}))).not.toContain('role="alert"')
  })

  it('shows an alert when application info cannot be loaded', () => {
    const html = render({ status: 'error', message: 'Could not reach the application.' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('Could not reach the application.')
  })

  it('renders as text only: markup in values is escaped', () => {
    const html = render(info({ name: '<img src=x onerror=alert(1)>' }))
    expect(html).not.toContain('<img src=x')
  })

  it('shows notices; errors as alerts, others as status messages, with the files involved', () => {
    const notices: Notice[] = [
      { id: 'notice-1', kind: 'recovered-from-backup', severity: 'warning', message: 'Loaded the backup.', files: ['/c/config.corrupt-1.json'] },
      { id: 'notice-2', kind: 'reset-to-empty', severity: 'error', message: 'Started empty.', files: [] },
    ]
    const html = render(info({}), { notices })
    expect(html).toContain('role="status"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('Loaded the backup.')
    expect(html).toContain('/c/config.corrupt-1.json')
    expect(html.match(/Dismiss/g)).toHaveLength(2)
  })

  it('[spec:process-supervision/survivors-after-crash] lists survivors of an earlier session with name, PID, and command line, offering to terminate them', () => {
    const notices: Notice[] = [
      {
        id: 'notice-3',
        kind: 'crash-survivors',
        severity: 'warning',
        message: '2 processes started by Veydr in an earlier session are still running. Nothing was restarted.',
        files: [],
        processes: [
          { pid: 4242, name: 'node', commandLine: 'node server.js --port 3000' },
          { pid: 4243, name: '<b>x</b>', commandLine: '' },
        ],
      },
    ]
    const html = render(info({}), { notices })
    expect(html).toContain('2 processes started by Veydr in an earlier session are still running.')
    expect(html).toContain('PID 4242')
    expect(html).toContain('node server.js --port 3000')
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).toContain('(command line unavailable)')
    expect(html).toContain('>Terminate<')
    expect(html).toContain('>Leave running<')
    expect(html).not.toContain('Dismiss')
  })

  it('covers the window with a stopping overlay while quitting, listing the commands still being stopped', () => {
    const running = (status: CommandProcessState['status']): CommandProcessState => ({
      commandId,
      runId: '0b7c9f7e-2a64-4d1a-8f0e-5f7d8c9b1a22',
      seq: 3,
      status,
      pid: 1,
      startedAt: 1,
      exit: null,
      error: null,
      survivors: [],
    })
    const quitting: Notice = { id: 'notice-9', kind: 'quitting', severity: 'info', message: 'Stopping running commands before quitting…', files: [] }
    const html = render(info({}), {
      notices: [quitting],
      projects: { status: 'ready', projects: [shop] },
      processes: { status: 'ready', error: null, liveError: null, commands: new Map([[commandId, running('stopping')]]) },
    })
    expect(html).toContain('data-testid="quit-overlay"')
    expect(html).toContain('role="alertdialog"')
    expect(html).toMatch(/<div class="shell" inert="">/)
    expect(html).toMatch(/Commands being stopped.*api &lt;b&gt;server&lt;\/b&gt; <span class="muted">Stopping/)
    // The quitting notice is not shown as a banner.
    expect(html).not.toContain('data-kind="quitting"')
    expect(render(info({}))).not.toContain('quit-overlay')
  })

  it('lists projects and their commands with the state from the process store', () => {
    const processes: ProcessesState = {
      status: 'ready',
      error: null,
      liveError: null,
      commands: new Map([
        [
          commandId,
          {
            commandId,
            runId: '0b7c9f7e-2a64-4d1a-8f0e-5f7d8c9b1a22',
            seq: 2,
            status: 'running',
            pid: 4242,
            startedAt: 1,
            exit: null,
            error: null,
            survivors: [],
          },
        ],
      ]),
    }
    const html = render(info({}), { projects: { status: 'ready', projects: [shop] }, processes })
    expect(html).toContain('shop')
    expect(html).toContain('/home/dev/shop')
    expect(html).toContain('Running')
    expect(html).not.toContain('No projects yet')
    expect(html).toContain('api &lt;b&gt;server&lt;/b&gt;')
  })

  it('shows commands as idle when they have no state, and a placeholder while states load', () => {
    expect(render(info({}), { projects: { status: 'ready', projects: [shop] } })).toContain('Idle')
    const loading = render(info({}), {
      projects: { status: 'ready', projects: [shop] },
      processes: { status: 'loading', error: null, liveError: null, commands: new Map() },
    })
    expect(loading).not.toContain('Idle')
  })

  it('reports projects or process states that cannot be loaded', () => {
    const html = render(info({}), {
      projects: { status: 'error', message: 'Internal error' },
      processes: { status: 'error', error: 'Internal error', liveError: null, commands: new Map() },
    })
    expect(html).toContain('Projects could not be loaded: Internal error')
    expect(html).toContain('Process states could not be loaded: Internal error')
  })

  it('reports live updates and notices that cannot be received', () => {
    const html = render(info({}), {
      noticeError: 'Invalid request',
      processes: { status: 'ready', error: null, liveError: 'Could not reach the application.', commands: new Map() },
    })
    expect(html).toContain('Notices are unavailable: Invalid request')
    expect(html).toContain('Live process updates are unavailable, so states may be outdated: Could not reach the application.')
    expect(html.match(/role="alert"/g)).toHaveLength(2)
  })

  describe('command lifecycle', () => {
    const withState = (state: Partial<CommandProcessState>): string =>
      render(info({}), {
        projects: { status: 'ready', projects: [shop] },
        processes: {
          status: 'ready',
          error: null,
          liveError: null,
          commands: new Map([
            [
              commandId,
              {
                commandId,
                runId: '0b7c9f7e-2a64-4d1a-8f0e-5f7d8c9b1a22',
                seq: 1,
                status: 'idle',
                pid: null,
                startedAt: null,
                exit: null,
                error: null,
                survivors: [],
                ...state,
              },
            ],
          ]),
        },
      })

    /** The labelled lifecycle buttons and whether each is enabled. */
    const buttons = (html: string): Record<string, boolean> =>
      Object.fromEntries([...html.matchAll(/<button[^>]*aria-label="(Start|Stop|Restart) [^"]*"[^>]*>/g)].map((m) => [m[1] ?? '', !m[0].includes('disabled')]))

    it('offers start for an idle command, labelled with the command name', () => {
      const html = withState({})
      expect(buttons(html)).toEqual({ Start: true, Stop: false, Restart: false })
      expect(html).toContain('aria-label="Start api &lt;b&gt;server&lt;/b&gt;"')
    })

    it('[spec:process-supervision/running-state-details] shows state, PID, and uptime of a running command', () => {
      const html = withState({ status: 'running', pid: 4242, startedAt: Date.now() - 65_000 })
      expect(html).toContain('Running')
      expect(html).toMatch(/PID 4242 · up 1:0[5-6]/)
      expect(buttons(html)).toEqual({ Start: false, Stop: true, Restart: true })
    })

    it('[spec:process-supervision/exit-details] shows the exit code or signal and whether termination was forced', () => {
      expect(withState({ status: 'exited', exit: { code: 1, signal: null, forced: false } })).toContain('Exited with code 1')
      expect(withState({ status: 'exited', exit: { code: null, signal: 'SIGKILL', forced: true } })).toContain('Terminated by SIGKILL (forced after the stop timeout)')
      expect(buttons(withState({ status: 'exited', exit: { code: 0, signal: null, forced: false } }))).toEqual({ Start: true, Stop: false, Restart: false })
    })

    it('shows the reason of a failed start', () => {
      const html = withState({ status: 'failed', error: 'Executable not found: npm (searched PATH)' })
      expect(html).toContain('Failed')
      expect(html).toContain('Executable not found: npm (searched PATH)')
      expect(buttons(html)['Start']).toBe(true)
    })

    it('disables every action while a command is starting or stopping', () => {
      expect(buttons(withState({ status: 'starting' }))).toEqual({ Start: false, Stop: false, Restart: false })
      const stopping = withState({ status: 'stopping', pid: 7 })
      expect(buttons(stopping)).toEqual({ Start: false, Stop: false, Restart: false })
      expect(stopping).toContain('Stopping PID 7…')
      expect(withState({ status: 'stopping', pid: null })).toContain('Stopping remaining processes…')
    })

    it('shows a stop that could not be verified as an alert', () => {
      const html = withState({ status: 'exited', exit: { code: null, signal: null, forced: false }, error: 'Could not verify that the command stopped: EMFILE' })
      expect(html).toContain('data-testid="command-stop-error"')
      expect(html).toContain('Could not verify that the command stopped: EMFILE')
      expect(withState({ status: 'exited', exit: { code: 0, signal: null, forced: false } })).not.toContain('command-stop-error')
    })

    it('[spec:project-registry/directory-missing] shows a project whose folder is missing and disables starting its commands', () => {
      const html = render(info({}), { projects: { status: 'ready', projects: [{ ...shop, missing: true }] } })
      expect(html).toContain('data-testid="project-missing-badge"')
      expect(html).toContain('Folder missing')
      expect(buttons(html)).toEqual({ Start: false, Stop: false, Restart: false })
      expect(buttons(withState({}))).toEqual({ Start: true, Stop: false, Restart: false })
    })

    it('[spec:project-registry/shell-mode-labelled] labels a shell command with its shell in the command list', () => {
      const shellCommand = { ...shop.commands[0], execution: { mode: 'shell' as const, shell: '/bin/bash', script: 'npm run dev | tee log' } } as ProjectView['commands'][number]
      const html = render(info({}), { projects: { status: 'ready', projects: [{ ...shop, commands: [shellCommand] }] } })
      expect(html).toContain('data-testid="command-shell-label"')
      expect(html).toContain('Shell: /bin/bash')
      expect(html).toContain('npm run dev | tee log')
      expect(render(info({}), { projects: { status: 'ready', projects: [shop] } })).not.toContain('command-shell-label')
    })

    it('[spec:process-supervision/process-could-not-be-terminated] lists survivors with PID and name as an alert', () => {
      const html = withState({ status: 'exited', exit: { code: null, signal: null, forced: true }, survivors: [{ pid: 501, name: 'node' }] })
      expect(html).toContain('role="alert"')
      expect(html).toContain('Still running after the stop: PID 501 (node)')
    })
  })
})
