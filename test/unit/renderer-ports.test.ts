import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createDiagnosticLog } from '../../src/main/app/diagnostics'
import { createIpcRegistry, type InvokeEvent } from '../../src/main/ipc/register'
import { createWindowsPlatform } from '../../src/main/platform/windows'
import { createPortService } from '../../src/main/ports/service'
import { PortsContent } from '../../src/renderer/src/PortsView'
import { createPortsPoller, pollWhileVisible, PORTS_POLL_INTERVAL_MS, type PollTimers, type PortsState } from '../../src/renderer/src/state/ports'
import type { ProjectsState } from '../../src/renderer/src/state/projects'
import { channels, contract, type ApiResult, type PortSnapshot, type ProjectView } from '../../src/shared/api'

// Task 8.3: the ports view (polling, managed and all listeners, restricted marker, refresh time,
// no actions on processes) and its Windows behavior.

const COMMAND = '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01'
const shop: ProjectView = {
  id: '7a2e9b5d-4d2f-4f66-8b8c-1e7e2a3c0b12',
  name: 'shop',
  path: '/home/dev/shop',
  missing: false,
  commands: [{ id: COMMAND, name: 'web', execution: { mode: 'direct', file: 'npm', args: [] }, cwd: '.', env: [], stopTimeoutMs: 5000 }],
}
const projects: ProjectsState = { status: 'ready', projects: [shop] }

const snapshot: PortSnapshot = {
  refreshedAt: Date.UTC(2026, 9, 25, 14, 3, 7),
  ports: [
    { family: 'ipv4', address: '127.0.0.1', port: 631, owner: { kind: 'restricted' } },
    { family: 'ipv4', address: '127.0.0.1', port: 5173, owner: { kind: 'known', pid: 4242, name: 'node', commandId: COMMAND } },
    { family: 'ipv6', address: '::', port: 8080, owner: { kind: 'known', pid: 777, name: '<b>python3</b>', commandId: null } },
    { family: 'ipv6', address: '::1', port: 9000, owner: { kind: 'unknown' } },
  ],
}

/** Manual timers: `fire()` runs the pending callback. */
function manualTimers(): PollTimers & { pending: number[]; fire(): void } {
  let next = 1
  const callbacks = new Map<number, () => void>()
  const timers = {
    pending: [] as number[],
    setTimeout: (callback: () => void, ms: number) => {
      const handle = next++
      callbacks.set(handle, callback)
      timers.pending.push(ms)
      return handle
    },
    clearTimeout: (handle: unknown) => {
      if (callbacks.delete(handle as number)) timers.pending.pop()
    },
    fire() {
      const [entry] = [...callbacks.entries()]
      if (entry === undefined) throw new Error('no timer pending')
      callbacks.delete(entry[0])
      timers.pending.pop()
      entry[1]()
    },
  }
  return timers
}

/** A ports API whose requests are answered by the test. */
function controlledApi() {
  const requests: ((result: ApiResult<PortSnapshot>) => void)[] = []
  return {
    requests,
    api: { list: () => new Promise<ApiResult<PortSnapshot>>((resolve) => requests.push(resolve)) },
    answer: async (result: ApiResult<PortSnapshot>): Promise<void> => {
      requests.shift()?.(result)
      await new Promise((done) => setTimeout(done, 0))
    },
  }
}

describe('ports polling', () => {
  it('refreshes when shown, every 3 s after each answer while shown, and not after being hidden', async () => {
    const timers = manualTimers()
    const { api, requests, answer } = controlledApi()
    const poller = createPortsPoller(api, timers)
    expect(requests).toHaveLength(0)

    poller.start()
    expect(requests).toHaveLength(1)
    expect(poller.getState()).toMatchObject({ loading: true, snapshot: null })
    await answer({ ok: true, value: snapshot })
    expect(poller.getState()).toEqual({ snapshot, loading: false, error: null })
    expect(timers.pending).toEqual([PORTS_POLL_INTERVAL_MS])

    timers.fire()
    expect(requests).toHaveLength(1)
    await answer({ ok: true, value: snapshot })
    expect(timers.pending).toEqual([3_000])

    poller.stop()
    expect(timers.pending).toEqual([])
    poller.refresh()
    expect(requests).toHaveLength(0)
  })

  it('never overlaps requests: a refresh during a request runs right after it', async () => {
    const timers = manualTimers()
    const { api, requests, answer } = controlledApi()
    const poller = createPortsPoller(api, timers)
    poller.start()
    poller.refresh()
    poller.refresh()
    expect(requests).toHaveLength(1)
    await answer({ ok: true, value: snapshot })
    expect(requests).toHaveLength(1)
    expect(timers.pending).toEqual([])
    await answer({ ok: true, value: { ...snapshot, refreshedAt: snapshot.refreshedAt + 1 } })
    expect(poller.getState().snapshot?.refreshedAt).toBe(snapshot.refreshedAt + 1)
    expect(timers.pending).toEqual([3_000])

    // A manual refresh replaces the pending periodic one.
    poller.refresh()
    expect(timers.pending).toEqual([])
    expect(requests).toHaveLength(1)
  })

  it('keeps the last listing when a refresh fails, and reports an unreachable main process', async () => {
    const { api, answer } = controlledApi()
    const timers = manualTimers()
    const poller = createPortsPoller(api, timers)
    poller.start()
    await answer({ ok: true, value: snapshot })
    timers.fire()
    await answer({ ok: false, error: { code: 'internal', message: 'Could not read /proc/net/tcp' } })
    expect(poller.getState()).toEqual({ snapshot, loading: false, error: { code: 'internal', message: 'Could not read /proc/net/tcp' } })

    const unreachable = createPortsPoller({ list: () => Promise.reject(new Error('gone')) }, manualTimers())
    unreachable.start()
    await new Promise((done) => setTimeout(done, 0))
    expect(unreachable.getState().error).toEqual({ code: null, message: 'Could not reach the application.' })
  })
})

const render = (state: PortsState): string => renderToStaticMarkup(createElement(PortsContent, { state, projects, onRefresh: () => undefined }))

describe('ports view', () => {
  const html = render({ snapshot, loading: false, error: null })
  const rows = (table: string): string[] => html.split(`data-testid="${table}"`)[1]?.split('</table>')[0]?.match(/<tr data-testid="port-row".*?<\/tr>/g) ?? []

  it('[spec:port-inspection/dev-server-port-shown] shows the ports of running commands with the command, address, and PID', () => {
    const managed = rows('ports-managed-table')
    expect(managed).toHaveLength(1)
    expect(managed[0]).toContain('data-port="5173"')
    expect(managed[0]).toContain('shop › web')
    expect(managed[0]).toContain('127.0.0.1')
    expect(managed[0]).toContain('PID 4242')
  })

  it('lists every listening port, unmanaged ones with PID and name, restricted and unknown owners marked distinctly', () => {
    const all = rows('ports-all-table')
    expect(all.map((row) => /data-port="(\d+)"/.exec(row)?.[1])).toEqual(['631', '5173', '8080', '9000'])
    expect(all[2]).toContain('data-managed="false"')
    expect(all[2]).toContain('PID 777')
    expect(all[2]).toContain('Not managed')
    // Process names are text, never markup.
    expect(all[2]).toContain('&lt;b&gt;python3&lt;/b&gt;')
    expect(all[0]).toContain('data-owner="restricted"')
    expect(all[0]).toContain('>Restricted<')
    expect(all[3]).toContain('data-owner="unknown"')
    expect(all[3]).toContain('>Unknown<')
    expect(html).toContain('the port belongs to another user or to the system')
  })

  it('[spec:port-inspection/no-actions-on-unrelated-processes] offers no action on any listed process', () => {
    for (const row of [...rows('ports-managed-table'), ...rows('ports-all-table')]) {
      expect(row).not.toMatch(/<button|<a |<input|<select|onclick/i)
    }
    // The only control is Refresh.
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).toContain('>Refresh</button>')
  })

  it('renders every socket of a shared address and port (SO_REUSEPORT) as its own row (review L7-03)', () => {
    const worker = (pid: number) => ({ family: 'ipv4' as const, address: '0.0.0.0', port: 8443, owner: { kind: 'known' as const, pid, name: 'nginx', commandId: null } })
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => errors.push(args)
    try {
      const shared = render({ snapshot: { refreshedAt: 0, ports: [worker(10), worker(10), worker(11)] }, loading: false, error: null })
      expect(shared.match(/data-port="8443"/g)).toHaveLength(3)
    } finally {
      console.error = original
    }
    expect(errors).toEqual([])
  })

  it('shows when the list was refreshed', () => {
    expect(html).toContain('Last refreshed')
    expect(html).toContain('dateTime="2026-10-25T14:03:07.000Z"')
    expect(html).toContain('refreshed every 3 s while this view is open')
  })

  it('says when nothing listens, and shows read errors next to the last listing', () => {
    const empty = render({ snapshot: { refreshedAt: 0, ports: [] }, loading: false, error: null })
    expect(empty).toContain('No running command is listening on a TCP port.')
    expect(empty).toContain('Nothing is listening on a TCP port.')
    const failed = render({ snapshot, loading: false, error: { code: 'internal', message: 'Could not read /proc/net/tcp' } })
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('Ports could not be read: Could not read /proc/net/tcp')
    expect(failed).toContain('data-port="5173"')
    expect(render({ snapshot: null, loading: true, error: null })).toContain('Reading listening ports…')
  })

  it('[spec:port-inspection/ports-on-windows] shows that port inspection is not yet available on Windows', async () => {
    // Main: the Windows port inspector is unsupported, and IPC turns that into a typed error.
    const listeners = new Map<string, (event: InvokeEvent, ...args: unknown[]) => unknown>()
    const frame = { url: 'app://veydr/index.html' }
    const registry = createIpcRegistry({
      ipcMain: { handle: (channel, listener) => listeners.set(channel, listener) },
      mainFrame: () => frame,
      trustedOrigin: 'app://veydr',
      log: createDiagnosticLog(() => undefined),
    })
    const service = createPortService({ inspector: createWindowsPlatform().portInspector, attribution: () => Promise.resolve([]) })
    registry.handle(channels.ports.list, contract.ports.list.request, contract.ports.list.response, () => service.list())
    const sender = { id: 1, isDestroyed: () => false, send: () => undefined }
    const result = (await listeners.get(channels.ports.list)?.({ senderFrame: frame, sender })) as ApiResult<PortSnapshot>
    expect(result).toEqual({ ok: false, error: { code: 'unsupported_platform', message: 'portInspector.list is not supported on this platform (win32)' } })

    // Renderer: the view shows it instead of a list, without a Refresh button.
    const poller = createPortsPoller({ list: () => Promise.resolve(result) }, manualTimers())
    poller.start()
    await new Promise((done) => setTimeout(done, 0))
    const view = render(poller.getState())
    expect(view).toContain('Port inspection is not yet available on this platform.')
    expect(view).toContain('role="alert"')
    expect(view).not.toContain('<button')
    expect(view).not.toContain('<table')
  })
})

describe('polling follows the window visibility', () => {
  it('polls while visible, stops while hidden, and stops for good when the view closes', () => {
    const calls: string[] = []
    const listeners = new Set<() => void>()
    const source = {
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: (_type: 'visibilitychange', listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: 'visibilitychange', listener: () => void) => listeners.delete(listener),
    }
    const change = (state: DocumentVisibilityState): void => {
      source.visibilityState = state
      for (const listener of listeners) listener()
    }
    const close = pollWhileVisible({ start: () => calls.push('start'), stop: () => calls.push('stop') }, source)
    change('hidden')
    change('visible')
    close()
    expect(calls).toEqual(['start', 'stop', 'start', 'stop'])
    expect(listeners.size).toBe(0)

    calls.length = 0
    source.visibilityState = 'hidden'
    pollWhileVisible({ start: () => calls.push('start'), stop: () => calls.push('stop') }, source)
    expect(calls).toEqual(['stop'])
  })
})
