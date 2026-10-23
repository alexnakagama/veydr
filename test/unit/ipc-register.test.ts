import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createDiagnosticLog } from '../../src/main/app/diagnostics'
import type { EventSubscriber } from '../../src/main/ipc/events'
import { NotImplementedError, UnsupportedPlatformError } from '../../src/main/platform/errors'
import {
  createIpcRegistry,
  isTrustedSender,
  originOf,
  type InvokeEvent,
  type SenderFrame,
} from '../../src/main/ipc/register'

type Listener = (event: InvokeEvent, ...args: unknown[]) => unknown

const sender: EventSubscriber = { id: 1, isDestroyed: () => false, send: () => undefined }
const from = (senderFrame: SenderFrame | null): InvokeEvent => ({ senderFrame, sender })
const anything = z.unknown()

function setup() {
  const listeners = new Map<string, Listener>()
  const mainFrame: SenderFrame = { url: 'app://veydr/index.html' }
  const log = createDiagnosticLog(() => undefined)
  const registry = createIpcRegistry({
    ipcMain: { handle: (channel, listener) => listeners.set(channel, listener) },
    mainFrame: () => mainFrame,
    trustedOrigin: 'app://veydr',
    log,
  })
  const invoke = (channel: string, event: InvokeEvent, ...args: unknown[]): Promise<unknown> => {
    const listener = listeners.get(channel)
    if (listener === undefined) throw new Error(`no handler for ${channel}`)
    return Promise.resolve(listener(event, ...args))
  }
  return { registry, invoke, mainFrame, log }
}

const payload = z.strictObject({ name: z.string().min(1) })

describe('IPC registration helper', () => {
  it('[spec:desktop-shell/malformed-request-rejected] rejects a malformed payload without calling the handler', async () => {
    const { registry, invoke, mainFrame, log } = setup()
    const handler = vi.fn(() => 'done')
    registry.handle('test:op', payload, anything, handler)

    for (const bad of [undefined, null, 42, 'x', {}, { name: '' }, { name: 1 }, { name: 'ok', extra: true }]) {
      const result = await invoke('test:op', from(mainFrame), bad)
      expect(result).toMatchObject({ ok: false, error: { code: 'validation' } })
    }
    const tooMany = await invoke('test:op', from(mainFrame), { name: 'ok' }, 'second')
    expect(tooMany).toMatchObject({ ok: false, error: { code: 'validation' } })

    expect(handler).not.toHaveBeenCalled()
    expect(log.entries().filter((e) => e.event === 'ipc.rejected-payload')).toHaveLength(9)
  })

  it('[spec:desktop-shell/request-from-unexpected-origin-rejected] rejects foreign senders and records them in the diagnostic log', async () => {
    const { registry, invoke, log } = setup()
    const handler = vi.fn(() => 'done')
    registry.handle('test:op', payload, anything, handler)

    const foreign: InvokeEvent[] = [
      from(null),
      from({ url: 'app://veydr/index.html' }), // same URL, but not our main frame (e.g. a subframe)
      from({ url: 'https://example.com/' }),
    ]
    for (const event of foreign) {
      const result = await invoke('test:op', event, { name: 'ok' })
      expect(result).toEqual({ ok: false, error: { code: 'forbidden', message: 'Request rejected: unexpected sender' } })
    }
    expect(handler).not.toHaveBeenCalled()
    const rejected = log.entries().filter((e) => e.event === 'ipc.rejected-sender')
    expect(rejected).toHaveLength(3)
    expect(rejected[2]?.detail).toEqual({ channel: 'test:op', url: 'https://example.com/' })
  })

  it('rejects the main frame once it shows foreign content or is detached', async () => {
    const listeners = new Map<string, Listener>()
    const frame = { url: 'https://example.com/', detached: false }
    const registry = createIpcRegistry({
      ipcMain: { handle: (channel, listener) => listeners.set(channel, listener) },
      mainFrame: () => frame,
      trustedOrigin: 'app://veydr',
      log: createDiagnosticLog(() => undefined),
    })
    registry.handle('test:op', z.undefined(), anything, () => 'done')
    const listener = listeners.get('test:op')
    expect(await listener?.(from(frame))).toMatchObject({ ok: false, error: { code: 'forbidden' } })

    frame.url = 'app://veydr/index.html'
    frame.detached = true
    expect(await listener?.(from(frame))).toMatchObject({ ok: false, error: { code: 'forbidden' } })

    frame.detached = false
    expect(await listener?.(from(frame))).toEqual({ ok: true, value: 'done' })
  })

  it('passes parsed input to the handler and wraps its value', async () => {
    const { registry, invoke, mainFrame } = setup()
    registry.handle('test:op', payload, anything, ({ name }) => `hello ${name}`)
    expect(await invoke('test:op', from(mainFrame), { name: 'veydr' })).toEqual({
      ok: true,
      value: 'hello veydr',
    })
  })

  it('maps thrown errors to typed results without leaking messages', async () => {
    const { registry, invoke, mainFrame, log } = setup()
    registry.handle('test:unsupported', z.undefined(), anything, () => {
      throw new UnsupportedPlatformError('win32', 'processTree.spawn')
    })
    registry.handle('test:boom', z.undefined(), anything, () => Promise.reject(new Error('secret detail')))

    expect(await invoke('test:unsupported', from(mainFrame))).toEqual({
      ok: false,
      error: { code: 'unsupported_platform', message: 'processTree.spawn is not supported on this platform (win32)' },
    })
    expect(await invoke('test:boom', from(mainFrame))).toEqual({
      ok: false,
      error: { code: 'internal', message: 'Internal error' },
    })
    expect(log.entries().find((e) => e.event === 'ipc.handler-failed')?.detail).toMatchObject({
      message: 'secret detail',
    })
  })

  it('maps not-yet-implemented operations to a typed not_implemented error', async () => {
    const { registry, invoke, mainFrame, log } = setup()
    registry.handle('test:later', z.undefined(), anything, () => {
      throw new NotImplementedError('projects.add')
    })
    expect(await invoke('test:later', from(mainFrame))).toEqual({
      ok: false,
      error: { code: 'not_implemented', message: 'projects.add is not implemented yet' },
    })
    expect(log.entries().filter((e) => e.event === 'ipc.handler-failed')).toHaveLength(0)
  })

  it('validates the response: undeclared fields never reach the renderer, and their values are not logged', async () => {
    const { registry, invoke, mainFrame, log } = setup()
    const view = z.strictObject({ key: z.string(), value: z.null() })
    registry.handle('test:leak', z.undefined(), view, () => ({ key: 'TOKEN', value: 'hunter2-secret' }) as never)
    registry.handle('test:extra', z.undefined(), view, () => ({ key: 'TOKEN', value: null, raw: 'hunter2-secret' }) as never)
    registry.handle('test:good', z.undefined(), view, () => ({ key: 'TOKEN', value: null }))

    for (const channel of ['test:leak', 'test:extra']) {
      expect(await invoke(channel, from(mainFrame))).toEqual({ ok: false, error: { code: 'internal', message: 'Internal error' } })
    }
    expect(await invoke('test:good', from(mainFrame))).toEqual({ ok: true, value: { key: 'TOKEN', value: null } })
    const invalid = log.entries().filter((e) => e.event === 'ipc.invalid-response')
    expect(invalid).toHaveLength(2)
    expect(JSON.stringify(log.entries())).not.toContain('hunter2-secret')
  })

  it('returns the parsed response value (transforms applied, unknown keys of non-strict schemas stripped)', async () => {
    const { registry, invoke, mainFrame } = setup()
    registry.handle('test:shape', z.undefined(), z.object({ n: z.number() }), () => ({ n: 1, extra: true }))
    expect(await invoke('test:shape', from(mainFrame))).toEqual({ ok: true, value: { n: 1 } })
  })

  it('gives the handler the sending webContents', async () => {
    const { registry, invoke, mainFrame } = setup()
    const handler = vi.fn((_input: undefined, context: { sender: EventSubscriber }) => context.sender.id)
    registry.handle('test:who', z.undefined(), anything, handler)
    expect(await invoke('test:who', from(mainFrame))).toEqual({ ok: true, value: 1 })
    expect(handler.mock.calls[0]?.[1].sender).toBe(sender)
  })

  it('refuses to register a channel twice', () => {
    const { registry } = setup()
    registry.handle('test:op', z.undefined(), anything, () => 1)
    expect(() => registry.handle('test:op', z.undefined(), anything, () => 2)).toThrow(/registered twice/)
    expect(registry.channels).toEqual(['test:op'])
  })
})

describe('sender origin checks', () => {
  it('derives origins for custom and special schemes', () => {
    expect(originOf('app://veydr/index.html')).toBe('app://veydr')
    expect(originOf('http://localhost:5173/')).toBe('http://localhost:5173')
    expect(originOf('file:///etc/passwd')).toBeNull()
    expect(originOf('not a url')).toBeNull()
  })

  it('accepts only the main frame at the trusted origin', () => {
    const main = { url: 'app://veydr/index.html' }
    expect(isTrustedSender(main, main, 'app://veydr')).toBe(true)
    expect(isTrustedSender(main, null, 'app://veydr')).toBe(false)
    expect(isTrustedSender({ url: 'app://veydr.evil/index.html' }, null, 'app://veydr')).toBe(false)
    const lookalike = { url: 'app://veydr.evil/index.html' }
    expect(isTrustedSender(lookalike, lookalike, 'app://veydr')).toBe(false)
  })
})
