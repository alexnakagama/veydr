import { describe, it } from 'vitest'

// The installer run as the runner's administrator against the real profile, in CI only
// (add-windows-packaging design D3, D4). Group 3 implements this file; the tags keep
// `npm run spec-coverage` at zero unmapped scenarios until then.

describe.skipIf(process.platform !== 'win32')('[windows-only: the Windows installer] installation as the administrator', () => {
  it.todo('[spec:desktop-shell/installed-application-passes-its-self-check] the installed application passes all seven smoke checks, the platform check included (task 3.2)')
  it.todo('[spec:desktop-shell/no-start-at-logon] leaves no Run or RunOnce value and no Startup shortcut for Veydr (task 3.2)')
  it.todo('[spec:desktop-shell/command-started-through-the-installed-helper] starts a command tree through the installed helper, lists its listener, and ends the tree (task 3.3)')
  it.todo('[spec:desktop-shell/install-directory-not-writable-by-others] grants write rights on the install directory, Veydr.exe, app.asar and the helper to no SID outside the allowed set (task 3.4)')
  it.todo('[spec:desktop-shell/installing-over-an-existing-installation] installs over the existing installation, and the smoke test passes again (task 3.5)')
  it.todo('[spec:desktop-shell/silent-uninstallation] removes the install directory, the Start menu entry and the uninstall entry, and keeps the configuration (task 3.5)')
})
