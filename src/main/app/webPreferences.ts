import type { WebPreferences } from 'electron'

export interface WebPreferencesOptions {
  readonly preloadPath: string
  /** DevTools are available only in unpackaged builds. */
  readonly devTools: boolean
}

/** Renderer isolation settings (design D2). Kept free of runtime Electron imports so it is unit-testable. */
export function buildWebPreferences({ preloadPath, devTools }: WebPreferencesOptions): WebPreferences {
  return {
    preload: preloadPath,
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
    devTools,
  }
}
