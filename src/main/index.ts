import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog, ipcMain, Menu, protocol, session, shell, type BrowserWindow } from 'electron'
import { channels, type AppInfo } from '../shared/api'
import { devContentSecurityPolicy } from './app/csp'
import { resolveDevServerUrl } from './app/devserver'
import { createDiagnosticLog } from './app/diagnostics'
import { watchWindowHealth } from './app/health'
import { createNoticeCenter, noticeFromConfig } from './app/notices'
import { APP_ENTRY_URL, APP_ORIGIN, APP_SCHEME, createAppProtocolHandler } from './app/protocol'
import { createQuitOrchestrator, SIGNAL_DEADLINE_MS, type QuitChoice } from './app/quit'
import { hardenSession, hardenWebContents } from './app/security'
import { createMainWindow, preloadPathFor, rendererRootFor } from './app/window'
import { createConfigStore } from './config'
import { createEventHub } from './ipc/events'
import { createOperationHandlers } from './ipc/handlers'
import { registerEventSubscriptions, registerOperations } from './ipc/operations'
import { createIpcRegistry, originOf } from './ipc/register'
import { createLogService } from './logs/service'
import { selectPlatform } from './platform'
import { createPortService } from './ports/service'
import { runNetworkProbe } from './probe'
import { createDesktopActions } from './projects/desktop'
import { createEnvironmentService } from './projects/environment'
import { findCommand } from './projects/lookup'
import { createProjectService } from './projects/service'
import { createRunLedger } from './supervisor/ledger'
import { createPlanner } from './supervisor/plan'
import { createCrashRecovery } from './supervisor/recovery'
import { createProcessStateRegistry } from './supervisor/state'
import { createSupervisor } from './supervisor/supervisor'
import type { Survivor } from './platform/types'

// Composition root. A second instance must exit before touching any state,
// so the lock is the very first thing that happens.
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  start()
}

function start(): void {
  const log = createDiagnosticLog()
  const platform = selectPlatform(process.platform, { log, inherited: process.env })
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
  // Runs whose processes may be alive, so a launch after a crash can find survivors (design D9).
  const ledger = createRunLedger({
    dir: configDir,
    log,
    onWriteError: (message) =>
      notices.add({
        kind: 'ledger-problem',
        severity: 'warning',
        message: `Veydr could not record its running commands (${message}). If Veydr ends unexpectedly, it may not find processes it started.`,
        files: [],
      }),
  })
  // The login environment is read on the first start or preview, not at launch (design D6).
  const environmentNotices: string[] = []
  const environment = createEnvironmentService({
    provider: platform.envProvider,
    // A resolution replaces the warnings of the previous one (e.g. a successful refresh withdraws them).
    onWarnings: (warnings) => {
      for (const id of environmentNotices.splice(0)) notices.withdraw(id)
      for (const message of warnings) environmentNotices.push(notices.add({ kind: 'environment', severity: 'warning', message, files: [] }).id)
    },
  })
  // Output of every run, in memory only (design D11). Live batches go to the subscribed window;
  // a newly subscribed document never acknowledges batches sent before it, so delivery restarts.
  const logs = createLogService({
    delivery: {
      active: () => hub.subscriberCount(channels.logs.onBatch) > 0,
      send: (batch) => hub.publish(channels.logs.onBatch, batch),
    },
  })
  hub.onSubscribe(channels.logs.onBatch, () => logs.resetDelivery())
  // Commands start only on an explicit user request (`processes.start`/`restart`); nothing is started here.
  const supervisor = createSupervisor({
    processTree: platform.processTree,
    states: processStates,
    lookup: (commandId) => findCommand(config.current(), commandId),
    plan: createPlanner({ resolver: platform.commandResolver, environment }),
    output: logs,
    ledger,
    log,
  })
  const recovery = createCrashRecovery({ processTree: platform.processTree, ledger, notices, log })
  // Read-only: the ports service gets the attribution sets, never the lifecycle actions (design D12).
  const ports = createPortService({ inspector: platform.portInspector, attribution: () => supervisor.attribution() })

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
  const projects = createProjectService({
    store: config,
    activeCommands: () => new Set(supervisor.active().map((run) => run.commandId)),
  })
  const desktop = createDesktopActions({
    config: () => config.current(),
    showDirectoryPicker: () => pickDirectory(mainWindow),
    openPath: (path) => shell.openPath(path),
    launcher: platform.processTree,
    resolver: platform.commandResolver,
    environment,
  })
  registerOperations(
    registry,
    createOperationHandlers({ info, config: () => config.current(), processStates, supervisor, recovery, projects, environment, desktop, logs, ports }),
  )

  // Quitting stops every running command first (design D10); see `app/quit.ts`.
  const orchestrator = createQuitOrchestrator({
    supervisor,
    ledger,
    processTree: platform.processTree,
    showProgress: () => notices.add({ kind: 'quitting', severity: 'info', message: 'Stopping running commands before quitting…', files: [] }),
    confirm: (survivors) => confirmQuit(mainWindow, survivors),
    log,
  })
  /** `running` until a quit starts; `done` once it may proceed (Electron then quits normally). */
  let quitState: 'running' | 'quitting' | 'done' = 'running'
  const exitAfter = (shutdown: Promise<void>, code: number): void => {
    void shutdown
      .catch((error: unknown) => log.record('error', 'quit.failed', { message: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        quitState = 'done'
        app.exit(code)
      })
  }

  app.on('before-quit', (event) => {
    if (quitState === 'done') return
    event.preventDefault()
    if (quitState === 'quitting') return
    quitState = 'quitting'
    void orchestrator
      .quit()
      .catch((error: unknown) => log.record('error', 'quit.failed', { message: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        quitState = 'done'
        app.quit()
      })
  })
  app.on('window-all-closed', () => app.quit())

  // Session logout, `kill`, Ctrl+C: the same stop-all, bounded, without questions (design D9).
  // Electron installs its own handlers for these signals (they call `app.quit()`, which would ask
  // questions) after this script has run; Node's handler, installed when the first listener is
  // added, replaces them, so the listeners are added once the app is ready. A signal before that
  // takes Electron's path, when nothing can be running yet.
  // Exits with the shell convention 128 + signal number; a second signal exits at once (what is
  // not verified as stopped stays in the ledger).
  let signalled = false
  const handleSignals = (): void => {
    for (const [signal, number] of [['SIGTERM', 15], ['SIGINT', 2], ['SIGHUP', 1]] as const) {
      process.on(signal, () => {
        if (quitState === 'done') return
        if (signalled) {
          log.record('warn', 'app.signal-repeated', { signal })
          app.exit(128 + number)
          return
        }
        signalled = true
        log.record('warn', 'app.signal', { signal })
        quitState = 'quitting'
        exitAfter(orchestrator.shutdown(SIGNAL_DEADLINE_MS), 128 + number)
      })
    }
  }

  // The bundled UI is unusable if it cannot load or its renderer dies: tell the user, stop what
  // is running (bounded like a signal), and exit.
  let failing = false
  const fatal = (message: string): void => {
    if (failing) return
    failing = true
    log.record('error', 'app.fatal', { message })
    // Started before the (blocking) error box, so commands are stopped while it is shown.
    const shutdown = orchestrator.shutdown(SIGNAL_DEADLINE_MS)
    dialog.showErrorBox('Veydr cannot continue', message)
    exitAfter(shutdown, 1)
  }
  // An uncaught exception leaves the main process in an undefined state.
  process.on('uncaughtException', (error) => fatal(`Unexpected error: ${error.message}`))
  process.on('unhandledRejection', (reason) =>
    log.record('error', 'app.unhandled-rejection', { reason: reason instanceof Error ? reason.message : String(reason) }),
  )

  app
    .whenReady()
    .then(async () => {
      handleSignals()
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
      // Processes of an earlier session that are still running are shown, never restarted.
      const recorded = await ledger.load()
      if (recorded.problem !== null) {
        notices.add({
          kind: 'ledger-problem',
          severity: 'warning',
          message: `Veydr could not read its record of running commands: ${recorded.problem}. Processes it started in an earlier session may still be running.`,
          files: [],
        })
      }
      await recovery.check(recorded.entries)
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
      // Closing the window quits; the window stays open (showing progress) until commands are stopped.
      mainWindow.on('close', (event) => {
        if (quitState === 'done') return
        event.preventDefault()
        app.quit()
      })
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

/** The native folder picker; `null` if cancelled. */
async function pickDirectory(window: BrowserWindow | null): Promise<string | null> {
  const options = { title: 'Choose a project folder', properties: ['openDirectory' as const] }
  const { canceled, filePaths } = window === null || window.isDestroyed() ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options)
  return canceled ? null : (filePaths[0] ?? null)
}

/** Lists what could not be stopped and asks the user to retry or quit anyway (design D10). */
async function confirmQuit(window: BrowserWindow | null, survivors: readonly Survivor[]): Promise<QuitChoice> {
  const detail =
    survivors.length === 0
      ? 'Veydr could not verify that every command stopped.'
      : survivors.map(({ info }) => `${info.name} (PID ${info.pid}): ${info.commandLine}`).join('\n')
  const options = {
    type: 'warning' as const,
    title: 'Veydr',
    message: 'Some processes could not be stopped.',
    detail: `${detail}\n\nIf you quit anyway, they keep running and Veydr lists them again the next time it starts.`,
    buttons: ['Retry', 'Quit anyway'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
  const { response } = window === null || window.isDestroyed() ? await dialog.showMessageBox(options) : await dialog.showMessageBox(window, options)
  return response === 1 ? 'quit' : 'retry'
}
