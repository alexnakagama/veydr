import { EventEmitter } from 'node:events'
import type { Session, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { createDiagnosticLog } from '../../src/main/app/diagnostics'
import { hardenSession, hardenWebContents } from '../../src/main/app/security'

function fakeContents() {
  const emitter = new EventEmitter()
  let openHandler: ((details: { url: string }) => { action: string }) | undefined
  const setWebRTCIPHandlingPolicy = vi.fn()
  const contents = Object.assign(emitter, {
    setWindowOpenHandler: (handler: typeof openHandler) => {
      openHandler = handler
    },
    setWebRTCIPHandlingPolicy,
  })
  const log = createDiagnosticLog(() => undefined)
  hardenWebContents(contents as unknown as WebContents, log)
  const fire = (name: string, ...args: unknown[]): { defaultPrevented: boolean } => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, isMainFrame: false, url: 'x' }
    Object.assign(event, args[0] ?? {})
    emitter.emit(name, event, ...args.slice(1))
    return event
  }
  return { fire, log, setWebRTCIPHandlingPolicy, open: (url: string) => openHandler?.({ url }) }
}

describe('hardenWebContents', () => {
  it('prevents navigation, redirects, subframe navigation, and webview attachment', () => {
    const { fire, log } = fakeContents()
    expect(fire('will-navigate', {}, 'https://example.com/').defaultPrevented).toBe(true)
    expect(fire('will-redirect', {}, 'https://example.com/').defaultPrevented).toBe(true)
    expect(fire('will-frame-navigate', { isMainFrame: false, url: 'https://example.com/' }).defaultPrevented).toBe(true)
    expect(fire('will-attach-webview').defaultPrevented).toBe(true)
    expect(log.entries().map((e) => e.event)).toEqual([
      'security.navigation-blocked',
      'security.redirect-blocked',
      'security.frame-navigation-blocked',
      'security.webview-blocked',
    ])
  })

  it('leaves main-frame frame-navigation to will-navigate', () => {
    const { fire } = fakeContents()
    expect(fire('will-frame-navigate', { isMainFrame: true }).defaultPrevented).toBe(false)
  })

  it('denies every window open and disables non-proxied WebRTC UDP', () => {
    const { open, setWebRTCIPHandlingPolicy } = fakeContents()
    expect(open('https://example.com/')).toEqual({ action: 'deny' })
    expect(open('app://veydr/index.html')).toEqual({ action: 'deny' })
    expect(setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp')
  })
})

describe('hardenSession', () => {
  it('denies permissions, devices, and display capture, and disables the spellchecker', () => {
    let requestHandler: ((c: unknown, p: string, cb: (granted: boolean) => void) => void) | undefined
    let checkHandler: (() => boolean) | undefined
    let deviceHandler: (() => boolean) | undefined
    let displayHandler: ((r: unknown, cb: (streams: object) => void) => void) | undefined
    const session = {
      setPermissionRequestHandler: (h: typeof requestHandler) => (requestHandler = h),
      setPermissionCheckHandler: (h: typeof checkHandler) => (checkHandler = h),
      setDevicePermissionHandler: (h: typeof deviceHandler) => (deviceHandler = h),
      setDisplayMediaRequestHandler: (h: typeof displayHandler) => (displayHandler = h),
      setSpellCheckerEnabled: vi.fn(),
      setSpellCheckerLanguages: vi.fn(),
    }
    const log = createDiagnosticLog(() => undefined)
    hardenSession(session as unknown as Session, log)

    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal']) {
      const callback = vi.fn()
      requestHandler?.({}, permission, callback)
      expect(callback).toHaveBeenCalledWith(false)
    }
    expect(checkHandler?.()).toBe(false)
    expect(deviceHandler?.()).toBe(false)
    const display = vi.fn()
    displayHandler?.({}, display)
    expect(display).toHaveBeenCalledWith({})
    expect(session.setSpellCheckerEnabled).toHaveBeenCalledWith(false)
    expect(session.setSpellCheckerLanguages).toHaveBeenCalledWith([])
  })
})
