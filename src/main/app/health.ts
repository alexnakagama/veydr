import type { DiagnosticLog } from './diagnostics'

/** The subset of `WebContents` the health watcher needs. */
export interface HealthSource {
  on(event: 'did-fail-load', listener: (event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => void): unknown
  on(event: 'render-process-gone', listener: (event: unknown, details: { reason: string; exitCode: number }) => void): unknown
}

/** Chromium reports `ERR_ABORTED` (-3) for navigations we cancel on purpose. */
const ERR_ABORTED = -3

/**
 * Watches the window's web contents for failures the user could not recover
 * from: the bundled UI failing to load, or the renderer process dying.
 * `onFatal` is invoked at most once.
 */
export function watchWindowHealth(source: HealthSource, log: DiagnosticLog, onFatal: (reason: string) => void): void {
  let reported = false
  const fatal = (reason: string): void => {
    if (reported) return
    reported = true
    onFatal(reason)
  }
  source.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === ERR_ABORTED) return
    log.record('error', 'window.load-failed', { code, description, url })
    fatal(`The application window failed to load (${description}).`)
  })
  source.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    log.record('error', 'window.renderer-gone', { reason: details.reason, exitCode: details.exitCode })
    fatal(`The application window stopped unexpectedly (${details.reason}).`)
  })
}
