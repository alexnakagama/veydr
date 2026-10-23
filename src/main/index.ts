import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog, ipcMain, Menu, protocol, session, type BrowserWindow } from 'electron'
import { channels, type AppInfo } from '../shared/api'
import { devContentSecurityPolicy } from './app/csp'
import { resolveDevServerUrl } from './app/devserver'
import { createDiagnosticLog } from './app/diagnostics'
import { watchWindowHealth } from './app/health'
import { createNoticeCenter, noticeFromConfig } from './app/notices'
import { APP_ENTRY_URL, APP_ORIGIN, APP_SCHEME, createAppProtocolHandler } from './app/protocol'
import { hardenSession, hardenWebContents } from './app/security'
import { createMainWindow, preloadPathFor, rendererRootFor } from './app/window'
import { createConfigStore } from './config'
import { createEventHub } from './ipc/events'
import { createOperationHandlers } from './ipc/handlers'
import { registerEventSubscriptions, registerOperations } from './ipc/operations'
import { createIpcRegistry, originOf } from './ipc/register'
import { selectPlatform } from './platform'
import { runNetworkProbe } from './probe'
import { createProcessStateRegistry } from './supervisor/state'

// Composition root. A second instance must exit before touching any state,
// so the lock is the very first thing that happens.
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  start()
}

function start(): void {
  const log = createDiagnosticLog()
  const platform = selectPlatform()
  // `userData` honors XDG_CONFIG_HOME on Linux (~/.config/Veydr by default). The single-instance
  // lock above makes this process the only configuration writer.
  const configDir = app.getPath('userData')
  const config = createConfigStore({ dir: configDir, log })

  // The Vite dev server is used only by `electron-vite dev` (the flag is
  // compiled out of every other build); built and packaged apps always load
  // bundled content from app://veydr/. Only loopback http URLs are accepted.
  const devUrl = __VEYDR_DEV__ && !app.isPackaged ? resolveDevServerUrl(process.env['ELECTRON_RENDERER_URL']) : undefined
  const devOrigin = devUrl === undefined ? null : originOf(devUrl)
  const trustedOrigin = devOrigin ?? APP_ORIGIN

  app.enableSandbox()
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false } },
  ])
  Menu.setApplicationMenu(null)

  let mainWindow: BrowserWindow | null = null

  app.on('second-instance', () => {
    if (mainWindow === null) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  const hub = createEventHub(log)
  const notices = createNoticeCenter(hub)
  const processStates = createProcessStateRegistry((event) => hub.publish(channels.processes.onState, event))

  app.on('web-contents-created', (_event, contents) => {
    hardenWebContents(contents, log)
    // Subscriptions end with their webContents or its renderer process (a reload is detected by the hub).
    const id = contents.id
    contents.once('destroyed', () => hub.drop(id))
    contents.on('render-process-gone', () => hub.drop(id))
  })
  // Must run at session creation: Chromium starts dictionary downloads before `ready`.
  app.on('session-created', (created) => hardenSession(created, log))

  const info: AppInfo = {
    name: app.getName(),
    version: app.getVersion(),
    platform: platform.name,
    platformSupported: platform.supported,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
  }

  const registry = createIpcRegistry({
    ipcMain,
    mainFrame: () => (mainWindow === null || mainWindow.isDestroyed() ? null : mainWindow.webContents.mainFrame),
    trustedOrigin,
    log,
  })
  registerEventSubscriptions(registry, hub)
  registerOperations(registry, createOperationHandlers({ info, config: () => config.current(), processStates }))

  app.on('window-all-closed', () => app.quit())

  // The bundled UI is unusable if it cannot load or its renderer dies: tell the user and exit.
  let failing = false
  const fatal = (message: string): void => {
    if (failing) return
    failing = true
    log.record('error', 'app.fatal', { message })
    dialog.showErrorBox('Veydr cannot continue', message)
    app.exit(1)
  }
  // An uncaught exception leaves the main process in an undefined state. Quit orchestration
  // for supervised processes (L4) must replace the bare exit here.
  process.on('uncaughtException', (error) => fatal(`Unexpected error: ${error.message}`))
  process.on('unhandledRejection', (reason) =>
    log.record('error', 'app.unhandled-rejection', { reason: reason instanceof Error ? reason.message : String(reason) }),
  )

  app
    .whenReady()
    .then(async () => {
      const rendererRoot = rendererRootFor(__dirname)
      // A missing UI file would otherwise be served as a 404 page, which Chromium does not report as a load failure.
      if (devOrigin === null && !existsSync(join(rendererRoot, 'index.html'))) {
        fatal('The application files are incomplete (renderer bundle missing). Please reinstall Veydr.')
        return
      }
      // Recovery and read-only notices reach the UI through `app.onNotice`; they are retained for the
      // session, so the window receives them when it subscribes.
      try {
        const loaded = await config.load()
        for (const notice of loaded.notices) notices.add(noticeFromConfig(notice))
      } catch (error) {
        fatal(`The configuration in ${configDir} could not be loaded: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      protocol.handle(APP_SCHEME, createAppProtocolHandler(rendererRoot))

      if (devOrigin !== null) {
        const csp = devContentSecurityPolicy(devOrigin)
        session.defaultSession.webRequest.onHeadersReceived({ urls: [`${devOrigin}/*`] }, (details, callback) => {
          callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
        })
      }

      mainWindow = createMainWindow({
        preloadPath: preloadPathFor(__dirname),
        url: devUrl ?? APP_ENTRY_URL,
        devTools: !app.isPackaged,
        onLoadError: (error) => log.record('error', 'window.load-rejected', { message: String(error) }),
      })
      watchWindowHealth(mainWindow.webContents, log, fatal)
      mainWindow.on('closed', () => {
        mainWindow = null
      })

      if (__VEYDR_PROBE__) {
        const contents = mainWindow.webContents
        contents.once('did-finish-load', () => runNetworkProbe(process.env['VEYDR_NET_PROBE'], contents))
      }
    })
    .catch((error: unknown) => fatal(`Startup failed: ${error instanceof Error ? error.message : String(error)}`))
}
