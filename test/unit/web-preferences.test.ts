import { describe, expect, it } from 'vitest'
import { buildWebPreferences } from '../../src/main/app/webPreferences'

describe('window web preferences (design D2)', () => {
  const prefs = buildWebPreferences({ preloadPath: '/app/preload/index.js', devTools: false })

  it('enforces renderer isolation', () => {
    expect(prefs).toMatchObject({
      preload: '/app/preload/index.js',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      navigateOnDragDrop: false,
      spellcheck: false,
    })
  })

  it('exposes DevTools only when asked', () => {
    expect(prefs.devTools).toBe(false)
    expect(buildWebPreferences({ preloadPath: 'p', devTools: true }).devTools).toBe(true)
  })
})
