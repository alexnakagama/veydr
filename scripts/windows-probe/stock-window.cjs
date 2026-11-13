'use strict'
// The stock-Electron control of installer-standard-user.mjs (add-windows-packaging design D5): the
// stock electron.exe of node_modules/electron/dist loads this file as its app, as the temporary
// standard user, and opens a hidden window, as Veydr's --smoke-test does. Whether it can tells a
// failed smoke test of the installed app apart: if the stock binary cannot open a window for that
// account either, the runner's secondary logon is the cause, not the product or the installer.
//
// It writes `loaded` to the file named by VEYDR_STOCK_WINDOW_FILE once the window's page has loaded,
// and exits with 0. Every other outcome exits non-zero: the file, not a pipe, carries the result, so
// a GUI-subsystem program whose stdout does not reach a pipe is still read correctly. It loads a
// page from a data: URL and reads nothing else.
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')

const LOADED = 'loaded'
/** Within the driver's own limit for this run, so the exit code says why it ended. */
const LIMIT_MS = 60_000

const outFile = process.env.VEYDR_STOCK_WINDOW_FILE
if (typeof outFile !== 'string' || outFile === '') {
  process.stderr.write('stock-window.cjs: VEYDR_STOCK_WINDOW_FILE is not set\n')
  app.exit(2)
} else {
  const fail = (code, message) => {
    process.stderr.write(`stock-window.cjs: ${message}\n`)
    app.exit(code)
  }
  const limit = setTimeout(() => fail(3, `no window loaded within ${LIMIT_MS / 1000} s`), LIMIT_MS)
  app.whenReady().then(
    () => {
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      win.webContents.once('did-finish-load', () => {
        clearTimeout(limit)
        try {
          writeFileSync(outFile, LOADED, { flag: 'wx' })
        } catch (error) {
          fail(6, `cannot write ${outFile}: ${error instanceof Error ? error.message : String(error)}`)
          return
        }
        app.exit(0)
      })
      win.webContents.once('did-fail-load', (_event, code, description) => fail(4, `the page did not load: ${String(code)} ${String(description)}`))
      win.webContents.once('render-process-gone', (_event, details) => fail(5, `the renderer ended: ${String(details.reason)}`))
      win.loadURL('data:text/html,<title>veydr stock window</title>').catch(() => {
        // did-fail-load reports it.
      })
    },
    (error) => fail(7, `app.whenReady failed: ${error instanceof Error ? error.message : String(error)}`),
  )
}
