import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Shell, type InfoState, type ShellProps } from '../../src/renderer/src/App'
import type { ProcessesState } from '../../src/renderer/src/state/processes'
import type { AppInfo, Notice, ProjectView } from '../../src/shared/api'

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

const noProcesses: ProcessesState = { status: 'ready', error: null, liveError: null, commands: new Map() }

const render = (state: InfoState, overrides: Partial<ShellProps> = {}): string =>
  renderToStaticMarkup(
    createElement(Shell, {
      info: state,
      notices: [],
      noticeError: null,
      onDismissNotice: () => undefined,
      projects: { status: 'ready', projects: [] },
      processes: noProcesses,
      ...overrides,
    }),
  )

const commandId = '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01'
const shop: ProjectView = {
  id: '7a2e9b5d-4d2f-4f66-8b8c-1e7e2a3c0b12',
  name: 'shop',
  path: '/home/dev/shop',
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
})
