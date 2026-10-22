import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createDiagnosticLog } from '../../src/main/app/diagnostics'
import { watchWindowHealth } from '../../src/main/app/health'

function setup() {
  const emitter = new EventEmitter()
  const log = createDiagnosticLog(() => undefined)
  const onFatal = vi.fn()
  watchWindowHealth(emitter, log, onFatal)
  return { emitter, log, onFatal }
}

describe('watchWindowHealth', () => {
  it('reports a failed main-frame load once and records it', () => {
    const { emitter, log, onFatal } = setup()
    emitter.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'app://veydr/index.html', true)
    emitter.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'app://veydr/index.html', true)
    expect(onFatal).toHaveBeenCalledTimes(1)
    expect(onFatal.mock.calls[0]?.[0]).toContain('ERR_NAME_NOT_RESOLVED')
    expect(log.entries().some((e) => e.event === 'window.load-failed')).toBe(true)
  })

  it('ignores subframe failures and deliberately cancelled navigations', () => {
    const { emitter, onFatal } = setup()
    emitter.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://x/', false)
    emitter.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://x/', true)
    expect(onFatal).not.toHaveBeenCalled()
  })

  it('reports a dead renderer but not a clean exit', () => {
    const { emitter, log, onFatal } = setup()
    emitter.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
    expect(onFatal).not.toHaveBeenCalled()
    emitter.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 })
    expect(onFatal).toHaveBeenCalledTimes(1)
    expect(log.entries().find((e) => e.event === 'window.renderer-gone')?.detail).toEqual({ reason: 'crashed', exitCode: 139 })
  })
})
