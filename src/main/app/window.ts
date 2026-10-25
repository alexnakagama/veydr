import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import { buildWebPreferences } from './webPreferences'

export interface MainWindowOptions {
  readonly preloadPath: string
  readonly url: string
  readonly devTools: boolean
  /** Show the window once it is ready (default); the smoke test keeps it hidden. */
  readonly show?: boolean
  /** Called when `loadURL` rejects; navigation failures are also reported by `watchWindowHealth`. */
  readonly onLoadError: (error: unknown) => void
}

export function createMainWindow({ preloadPath, url, devTools, show = true, onLoadError }: MainWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Veydr',
    backgroundColor: '#111317',
    autoHideMenuBar: true,
    webPreferences: buildWebPreferences({ preloadPath, devTools }),
  })
  if (show) win.once('ready-to-show', () => win.show())
  win.loadURL(url).catch(onLoadError)
  return win
}

export function preloadPathFor(mainDir: string): string {
  return join(mainDir, '../preload/index.js')
}

export function rendererRootFor(mainDir: string): string {
  return join(mainDir, '../renderer')
}
