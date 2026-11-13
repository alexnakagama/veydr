import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Session, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { createDiagnosticLog } from '../../src/main/app/diagnostics'
import { disableProxyDiscovery, hardenSession, hardenWebContents } from '../../src/main/app/security'

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

describe('disableProxyDiscovery', () => {
  it('[spec:desktop-shell/no-outbound-connections] makes every connection direct, so Chromium never looks for a proxy (WPAD on Windows)', () => {
    const appendSwitch = vi.fn()
    disableProxyDiscovery({ appendSwitch })
    expect(appendSwitch.mock.calls).toEqual([['no-proxy-server']])
  })
})

// The documented limits of the archive validation on Windows (add-windows-packaging design D3, D8),
// as task 2.4 measured them in CI: both the changed index and the changed bytes are refused.
describe('archive validation on Windows, documented', () => {
  const root = join(__dirname, '../..')
  const baseline = readFileSync(join(root, 'docs/security-baseline.md'), 'utf8')
  /** The `* **<title>**` bullet of docs/security-baseline.md, on one line. */
  const bullet = (title: string): string => baseline.split('\n').find((line) => line.startsWith(`* **${title}**`)) ?? ''

  it('[spec:desktop-shell/archive-validation-limits-documented] states what the validation covers on Windows, what it does not, and that the application binary is unsigned', () => {
    const integrity = bullet('ASAR integrity on Windows')
    expect(integrity).not.toBe('')
    // What it covers: both modifications measured in task 2.4, by the test that measured them.
    expect(integrity).toContain('`test/packaging-windows/fuses.test.ts`')
    expect(integrity).toContain('What the validation covers: an archive whose index was changed is refused at startup')
    expect(integrity).toContain('a file whose bytes were changed with the index untouched is refused when it is read')
    expect(integrity).toContain('on Windows the bytes-only limit that the design predicted does not exist')
    const fuses = readFileSync(join(root, 'test/packaging-windows/fuses.test.ts'), 'utf8')
    expect(fuses).toMatch(/\bit\(\s*'\[spec:desktop-shell\/modified-archive-refused-on-windows\] refuses to start with an archive whose index was changed/)
    expect(fuses).toMatch(/\bit\(\s*'refuses to start with an archive whose file bytes alone changed, its index untouched/)
    // What it does not cover.
    expect(integrity).toContain('What it does not cover: `Veydr.exe` itself, which holds the expected hash')
    expect(integrity).toContain('files outside the archive (the helper, the uninstaller, and Electron\'s own libraries and resources)')
    expect(integrity).toContain('a file of the archive that is never read')
    // The application binary, and the other Windows executables, are unsigned.
    const unsigned = bullet('Unsigned Windows binaries')
    expect(unsigned).toContain('the installer, `Veydr.exe`, the uninstaller and the helper carry no Authenticode signature')
    expect(unsigned).toContain('nothing checks `Veydr.exe` or the helper when they start')
    expect(unsigned).toContain('(install-windows.md#download-and-verify)')
    // The Linux limitation stays stated separately, and the Windows bullets follow the Linux one.
    expect(bullet('ASAR integrity on Linux (limitation)')).toContain('on Linux a modified archive still loads')
    expect(baseline.indexOf('* **ASAR integrity on Linux')).toBeLessThan(baseline.indexOf('* **ASAR integrity on Windows**'))
    expect(bullet('Packaged Windows build')).toContain('the same six fuses are set in `Veydr.exe`')
  })
})
