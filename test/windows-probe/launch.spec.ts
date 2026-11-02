import { resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

// The electron-playwright probe (assess-windows-platform design D3): it uses only Playwright's Electron
// launcher, since the e2e harness builds on the /proc helpers. Making that harness portable is W1's work.

const repoRoot = resolve(__dirname, '../..')

/** This environment, minus anything that changes Electron's mode. */
const appEnv = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !/^(?:ELECTRON_|NODE_OPTIONS$)/i.test(entry[0])))

test('the window renders and shows windows in the unsupported-platform state', async () => {
  test.skip(process.platform !== 'win32', '[windows-only: what the app shows on Windows]')
  // Playwright defaults to --no-sandbox for Electron; Veydr refuses to run without the sandbox.
  const app = await electron.launch({ chromiumSandbox: true, args: [repoRoot], env: appEnv() })
  try {
    const window = await app.firstWindow()
    await expect(window).toHaveTitle('Veydr')
    await expect(window.getByTestId('app-info-summary')).toHaveText(/ · windows$/)
    await expect(window.getByRole('alert')).toContainText('Process features are not available on this platform.')
  } finally {
    await app.close()
  }
})
