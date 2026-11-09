'use strict'
// Test-only: loaded with `-r` into every Electron the end-to-end tests start. Keeps Veydr's
// configuration directory below the test's own `XDG_CONFIG_HOME` on every system: Electron derives
// `userData` from it on Linux only, and on Windows would use the runner's %APPDATA%\Veydr, which
// every test would share (its configuration, ledger, and single-instance lock).
//
// On Linux this changes nothing: `appData` already is `XDG_CONFIG_HOME` there. Only `appData` is
// set: a `-r` preload runs before Electron's own initialization, which then derives `userData` as
// `<appData>/<app name>` (`Veydr`), unless `userData` was overridden already (here the name would
// still be "Electron"), so setting `userData` too would pin the wrong directory. The path is set,
// not created; Veydr creates its directory as usual. Without `XDG_CONFIG_HOME` the test harness is
// broken, so the launch fails instead of falling back to the user's real configuration.
const { app } = require('electron')

const home = process.env.XDG_CONFIG_HOME
if (home === undefined || home === '') throw new Error('config-home.cjs: XDG_CONFIG_HOME must name the test configuration home')
app.setPath('appData', home)
