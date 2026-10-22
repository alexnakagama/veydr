import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Shell, type InfoState } from '../../src/renderer/src/App'
import type { AppInfo } from '../../src/shared/api'

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

const render = (state: InfoState): string => renderToStaticMarkup(createElement(Shell, { info: state }))

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
})
