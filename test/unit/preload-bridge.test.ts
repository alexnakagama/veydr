import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { contract, contractEntries, internalChannels, internalContract } from '../../src/shared/api'

type Listener = (event: unknown, payload: unknown) => void

// The preload runs against a fake Electron: it records what is exposed and every IPC call.
const electron = vi.hoisted(() => {
  const exposed = new Map<string, unknown>()
  const listeners = new Map<string, Set<Listener>>()
  const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(() => Promise.resolve({ ok: true, value: null }))
  return {
    exposed,
    listeners,
    invoke,
    module: {
      contextBridge: { exposeInMainWorld: (key: string, value: unknown) => exposed.set(key, value) },
      ipcRenderer: {
        invoke,
        on: (channel: string, listener: Listener) => {
          const set = listeners.get(channel) ?? new Set()
          set.add(listener)
          listeners.set(channel, set)
        },
        removeListener: (channel: string, listener: Listener) => listeners.get(channel)?.delete(listener),
      },
    },
  }
})
vi.mock('electron', () => electron.module)

// A fresh page per test: earlier preload instances keep their pagehide listeners on the old one.
let pageEvents = new EventTarget()
type Api = Record<string, Record<string, (...args: unknown[]) => unknown>>

async function loadPreload(): Promise<Api> {
  vi.resetModules()
  electron.exposed.clear()
  electron.listeners.clear()
  electron.invoke.mockClear()
  await import('../../src/preload/index')
  return electron.exposed.get('veydr') as Api
}

const emit = (channel: string, payload: unknown): void => {
  for (const listener of electron.listeners.get(channel) ?? []) listener({ sender: 'ipc-renderer' }, payload)
}

const subscriptionCalls = (channel: string) =>
  electron.invoke.mock.calls.filter(([c]) => c === channel).map(([, payload]) => payload as { topic: string; token: string })

beforeEach(() => {
  pageEvents = new EventTarget()
  vi.stubGlobal('addEventListener', pageEvents.addEventListener.bind(pageEvents))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('preload bridge', () => {
  it('exposes only window.veydr', async () => {
    await loadPreload()
    expect([...electron.exposed.keys()]).toEqual(['veydr'])
  })

  it('exposes exactly the contract operations, and every request function uses a channel with registered schemas', async () => {
    const api = await loadPreload()
    expect(Object.keys(api).sort()).toEqual(Object.keys(contract).sort())

    for (const [group, operations] of Object.entries(api)) {
      const declared = contractEntries.filter((entry) => entry.group === group).map((entry) => entry.name)
      expect(Object.keys(operations).sort(), group).toEqual(declared.sort())
    }
    for (const { group, name, spec } of contractEntries) {
      const fn = api[group]?.[name]
      expect(typeof fn, `${group}.${name}`).toBe('function')
      if (spec.kind !== 'invoke') continue
      electron.invoke.mockClear()
      const request = { probe: true }
      await fn?.(request, 'ignored extra argument')
      expect(electron.invoke, `${group}.${name}`).toHaveBeenCalledTimes(1)
      const [channel, ...args] = electron.invoke.mock.calls[0] ?? []
      expect(channel).toBe(spec.channel)
      // At most one argument is forwarded; none for operations without a payload.
      expect(args).toEqual(spec.request.safeParse(undefined).success ? [] : [request])
    }
  })

  it('subscribes once per topic, forwards only the payload, and returns an idempotent unsubscribe', async () => {
    const api = await loadPreload()
    const topic = contract.processes.onState.channel
    const first = vi.fn()
    const second = vi.fn()

    const offFirst = api['processes']?.['onState']?.(first) as () => void
    const offSecond = api['processes']?.['onState']?.(second) as () => void
    expect(typeof offFirst).toBe('function')
    expect(subscriptionCalls(internalChannels.subscribe)).toEqual([{ topic, token: expect.any(String) as string }])
    expect(internalContract.subscribe.request.safeParse(subscriptionCalls(internalChannels.subscribe)[0]).success).toBe(true)

    emit(topic, { seq: 1 })
    expect(first).toHaveBeenCalledWith({ seq: 1 })
    expect(first.mock.calls[0]).toHaveLength(1)
    expect(second).toHaveBeenCalledWith({ seq: 1 })

    offFirst()
    offFirst()
    emit(topic, { seq: 2 })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
    expect(subscriptionCalls(internalChannels.unsubscribe)).toEqual([])

    offSecond()
    expect(electron.listeners.get(topic)?.size ?? 0).toBe(0)
    expect(subscriptionCalls(internalChannels.unsubscribe)).toEqual([{ topic, token: subscriptionCalls(internalChannels.subscribe)[0]?.token }])
  })

  it('keeps delivering to other listeners when one throws', async () => {
    const api = await loadPreload()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const good = vi.fn()
    api['app']?.['onNotice']?.(() => {
      throw new Error('listener bug')
    })
    api['app']?.['onNotice']?.(good)
    emit(contract.app.onNotice.channel, { id: 'notice-1' })
    expect(good).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('rejects a non-function listener', async () => {
    const api = await loadPreload()
    expect(() => api['logs']?.['onBatch']?.('not a function')).toThrow(TypeError)
    expect(subscriptionCalls(internalChannels.subscribe)).toEqual([])
  })

  it('uses one token per document and unsubscribes every active topic on pagehide', async () => {
    const api = await loadPreload()
    api['app']?.['onNotice']?.(vi.fn())
    api['processes']?.['onState']?.(vi.fn())
    const tokens = new Set(subscriptionCalls(internalChannels.subscribe).map((call) => call.token))
    expect(tokens.size).toBe(1)

    pageEvents.dispatchEvent(new Event('pagehide'))
    expect(subscriptionCalls(internalChannels.unsubscribe).map((call) => call.topic).sort()).toEqual(
      [contract.app.onNotice.channel, contract.processes.onState.channel].sort(),
    )

    const reloaded = await loadPreload()
    reloaded['app']?.['onNotice']?.(vi.fn())
    const [next] = subscriptionCalls(internalChannels.subscribe)
    expect(next?.token).not.toBe([...tokens][0])
  })

  it('retries a failed subscription once and reports a lasting failure to the listener’s error callback', async () => {
    const api = await loadPreload()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const refused = { ok: false, error: { code: 'forbidden', message: 'Request rejected: unexpected sender' } }
    electron.invoke.mockImplementation((channel) => Promise.resolve(channel === internalChannels.subscribe ? refused : { ok: true, value: null }))
    const onError = vi.fn()
    api['processes']?.['onState']?.(vi.fn(), onError)
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(subscriptionCalls(internalChannels.subscribe)).toHaveLength(2)
    expect(onError).toHaveBeenCalledWith(refused.error)

    // A rejected invoke (main unreachable) is reported the same way.
    const reachable = await loadPreload()
    electron.invoke.mockImplementation(() => Promise.reject(new Error('gone')))
    const onLost = vi.fn()
    reachable['app']?.['onNotice']?.(vi.fn(), onLost)
    await vi.waitFor(() => expect(onLost).toHaveBeenCalledWith({ code: 'internal', message: 'Could not reach the application.' }))
    electron.invoke.mockImplementation(() => Promise.resolve({ ok: true, value: null }))
    warn.mockRestore()
  })

  it('does not report a failure the retry recovered from, or one for a topic no longer wanted', async () => {
    const api = await loadPreload()
    let failures = 1
    electron.invoke.mockImplementation((channel) => {
      if (channel === internalChannels.subscribe && failures > 0) {
        failures -= 1
        return Promise.resolve({ ok: false, error: { code: 'internal', message: 'Internal error' } })
      }
      return Promise.resolve({ ok: true, value: null })
    })
    const onError = vi.fn()
    api['processes']?.['onState']?.(vi.fn(), onError)
    await vi.waitFor(() => expect(subscriptionCalls(internalChannels.subscribe)).toHaveLength(2))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onError).not.toHaveBeenCalled()

    const gone = await loadPreload()
    electron.invoke.mockImplementation((channel) =>
      Promise.resolve(channel === internalChannels.subscribe ? { ok: false, error: { code: 'internal', message: 'x' } } : { ok: true, value: null }),
    )
    const onGone = vi.fn()
    const off = gone['logs']?.['onBatch']?.(vi.fn(), onGone) as () => void
    off()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(subscriptionCalls(internalChannels.subscribe)).toHaveLength(1)
    expect(onGone).not.toHaveBeenCalled()
    electron.invoke.mockImplementation(() => Promise.resolve({ ok: true, value: null }))
  })

  it('rejects a non-function error callback', async () => {
    const api = await loadPreload()
    expect(() => api['logs']?.['onBatch']?.(vi.fn(), 'nope')).toThrow(TypeError)
    expect(subscriptionCalls(internalChannels.subscribe)).toEqual([])
  })
})
