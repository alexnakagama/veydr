import { describe, it } from 'vitest'

// The installer run by a temporary standard user through the W0 launcher, in CI only
// (add-windows-packaging design D5). Task 4.3 implements this file; the tags keep
// `npm run spec-coverage` at zero unmapped scenarios until then.

describe.skipIf(process.platform !== 'win32')('[windows-only: Windows accounts] installation as a standard user', () => {
  it.todo('[spec:desktop-shell/silent-installation-as-a-standard-user] installs silently below the standard user\'s profile, and the installed helper answers and lists ports (task 4.3)')
  it.todo('[spec:quality-gates/windows-installer-tested-as-a-standard-user] installs, exercises the helper and uninstalls as a standard user, and fails when the account cannot be set up (task 4.3)')
})
