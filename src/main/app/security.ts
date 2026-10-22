import type { Session, WebContents } from 'electron'
import type { DiagnosticLog } from './diagnostics'

/**
 * Blocks navigation, redirects, new windows, and webview attachment for a
 * webContents (design D2). Applied to every webContents the app creates.
 */
export function hardenWebContents(contents: WebContents, log: DiagnosticLog): void {
  contents.on('will-navigate', (event, url) => {
    event.preventDefault()
    log.record('warn', 'security.navigation-blocked', { url })
  })
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return // covered by will-navigate
    event.preventDefault()
    log.record('warn', 'security.frame-navigation-blocked', { url: event.url })
  })
  contents.on('will-redirect', (event, url) => {
    event.preventDefault()
    log.record('warn', 'security.redirect-blocked', { url })
  })
  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
    log.record('warn', 'security.webview-blocked', {})
  })
  // WebRTC (STUN/ICE) is not governed by CSP and would send UDP to remote hosts.
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  contents.setWindowOpenHandler(({ url }) => {
    log.record('warn', 'security.window-open-denied', { url })
    return { action: 'deny' }
  })
}

/** Denies every permission request and check for the session. */
export function hardenSession(session: Session, log: DiagnosticLog): void {
  session.setPermissionRequestHandler((_contents, permission, callback) => {
    log.record('warn', 'security.permission-denied', { permission })
    callback(false)
  })
  session.setPermissionCheckHandler(() => false)
  session.setDevicePermissionHandler(() => false)
  session.setDisplayMediaRequestHandler((_request, callback) => {
    log.record('warn', 'security.display-media-denied', {})
    callback({})
  })
  // The spellchecker downloads Hunspell dictionaries from a Google CDN; local-only
  // operation requires it off before the session initializes it.
  session.setSpellCheckerEnabled(false)
  session.setSpellCheckerLanguages([])
}
