import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createDiagnosticLog } from '../../src/main/app/diagnostics'
import { UnsupportedPlatformError } from '../../src/main/platform/errors'
import {
  createIpcRegistry,
  isTrustedSender,
  originOf,
  type InvokeEvent,
  type SenderFrame,
} from '../../src/main/ipc/register'

type Listener = (event: InvokeEvent, ...args: unknown[]) => unknown

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
    registry.handle('test:op', payload, handler)

    for (const bad of [undefined, null, 42, 'x', {}, { name: '' }, { name: 1 }, { name: 'ok', extra: true }]) {
      const result = await invoke('test:op', { senderFrame: mainFrame }, bad)
      expect(result).toMatchObject({ ok: false, error: { code: 'validation' } })
    }
    const tooMany = await invoke('test:op', { senderFrame: mainFrame }, { name: 'ok' }, 'second')
    expect(tooMany).toMatchObject({ ok: false, error: { code: 'validation' } })

    expect(handler).not.toHaveBeenCalled()
    expect(log.entries().filter((e) => e.event === 'ipc.rejected-payload')).toHaveLength(9)
  })

  it('[spec:desktop-shell/request-from-unexpected-origin-rejected] rejects foreign senders and records them in the diagnostic log', async () => {
    const { registry, invoke, log } = setup()
    const handler = vi.fn(() => 'done')
    registry.handle('test:op', payload, handler)

    const foreign: InvokeEvent[] = [
      { senderFrame: null },
      { senderFrame: { url: 'app://veydr/index.html' } }, // same URL, but not our main frame (e.g. a subframe)
      { senderFrame: { url: 'https://example.com/' } },
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
    registry.handle('test:op', z.undefined(), () => 'done')
    const listener = listeners.get('test:op')
    expect(await listener?.({ senderFrame: frame })).toMatchObject({ ok: false, error: { code: 'forbidden' } })

    frame.url = 'app://veydr/index.html'
    frame.detached = true
    expect(await listener?.({ senderFrame: frame })).toMatchObject({ ok: false, error: { code: 'forbidden' } })

    frame.detached = false
    expect(await listener?.({ senderFrame: frame })).toEqual({ ok: true, value: 'done' })
  })

  it('passes parsed input to the handler and wraps its value', async () => {
    const { registry, invoke, mainFrame } = setup()
    registry.handle('test:op', payload, ({ name }) => `hello ${name}`)
    expect(await invoke('test:op', { senderFrame: mainFrame }, { name: 'veydr' })).toEqual({
      ok: true,
      value: 'hello veydr',
    })
  })

  it('maps thrown errors to typed results without leaking messages', async () => {
    const { registry, invoke, mainFrame, log } = setup()
    registry.handle('test:unsupported', z.undefined(), () => {
      throw new UnsupportedPlatformError('win32', 'processTree.spawn')
    })
    registry.handle('test:boom', z.undefined(), () => Promise.reject(new Error('secret detail')))

    expect(await invoke('test:unsupported', { senderFrame: mainFrame })).toEqual({
      ok: false,
      error: { code: 'unsupported_platform', message: 'processTree.spawn is not supported on this platform (win32)' },
    })
    expect(await invoke('test:boom', { senderFrame: mainFrame })).toEqual({
      ok: false,
      error: { code: 'internal', message: 'Internal error' },
    })
    expect(log.entries().find((e) => e.event === 'ipc.handler-failed')?.detail).toMatchObject({
      message: 'secret detail',
    })
  })

  it('refuses to register a channel twice', () => {
    const { registry } = setup()
    registry.handle('test:op', z.undefined(), () => 1)
    expect(() => registry.handle('test:op', z.undefined(), () => 2)).toThrow(/registered twice/)
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
