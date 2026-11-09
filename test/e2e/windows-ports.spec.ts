import { expect, expectNoOutboundConnections, launchVeydr, test } from './support/fixtures'
import { removeDir } from './support/temp'

// The Ports view on Windows (add-windows-environment-and-commands design D6, D7): port inspection
// stays unsupported until W3, so the view says so instead of listing ports, and offers no refresh.
// The Linux behavior is in the Linux-only ports.spec.ts.

test.skip(process.platform !== 'win32', '[windows-only: no port inspection before W3]')

test('[windows-only: no port inspection before W3] the Ports view says that port inspection is not yet available, and is reachable by keyboard', async () => {
  const veydr = await launchVeydr()
  try {
    const { window } = veydr
    await expect(window.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible()
    await window.keyboard.press('Tab')
    await window.keyboard.press('Tab')
    await expect(window.getByRole('button', { name: 'Ports', exact: true })).toBeFocused()
    await window.keyboard.press('Enter')
    await expect(window.getByRole('heading', { level: 1, name: 'Ports' })).toBeVisible()

    const banner = window.getByTestId('ports-unsupported')
    await expect(banner).toHaveText('Port inspection is not yet available on this platform.')
    await expect(banner).toHaveAttribute('role', 'alert')
    // No refresh, no status line, and no table: nothing suggests ports could be listed.
    await expect(window.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0)
    await expect(window.getByTestId('ports-status')).toHaveCount(0)
    await expect(window.getByTestId('ports-all-table')).toHaveCount(0)
    // The API answers with a typed refusal, not a rejected promise.
    const listed = await window.evaluate(() => globalThis.window.veydr.ports.list())
    expect(listed).toMatchObject({ ok: false, error: { code: 'unsupported_platform' } })

    await window.keyboard.press('Tab')
    await expect(window.getByRole('button', { name: 'Settings', exact: true })).toBeFocused()
    expectNoOutboundConnections(await veydr.close())
  } finally {
    await veydr.app.close().catch(() => undefined)
    removeDir(veydr.workDir)
  }
})
