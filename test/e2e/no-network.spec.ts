import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, expectNoOutboundConnections, launchVeydr, repoRoot, test } from './support/fixtures'

/** The smoke flow F1 can exercise: load, read app info, switch views. */
async function smokeFlow(window: Page): Promise<void> {
  await expect(window.getByTestId('app-info-summary')).toHaveText(/Veydr/)
  await window.getByRole('button', { name: 'About' }).click()
  await expect(window.getByTestId('app-info')).toBeVisible()
  await window.getByRole('button', { name: 'Projects' }).click()
  await expect(window.getByTestId('empty-projects')).toBeVisible()
  // Give background Chromium services time to show any network activity.
  await window.waitForTimeout(5000)
}

test('the smoke flow opens no outbound connections', async () => {
  const veydr = await launchVeydr()
  try {
    await smokeFlow(veydr.window)
    expectNoOutboundConnections(await veydr.close())
  } finally {
    rmSync(veydr.workDir, { recursive: true, force: true })
  }
})

/** Probe kind → the observer that must see it (WebRTC is Chromium's network stack, not Node's). */
const probes = [
  { kind: 'node', source: 'node' },
  { kind: 'chromium', source: 'chromium' },
  { kind: 'webrtc', source: 'chromium' },
] as const

for (const { kind, source } of probes) {
  test(`the guard detects a deliberate ${kind} request in the probe build`, async () => {
    const veydr = await launchVeydr({ build: 'out-probe', env: { VEYDR_NET_PROBE: kind } })
    try {
      await smokeFlow(veydr.window)
      const report = await veydr.close()
      expect(report.guardInstalled).toBe(true)
      expect(report.netLogPresent).toBe(true)
      const hits = report.attempts.filter((a) => a.source === source && a.detail.includes('192.0.2.1'))
      expect(hits.length).toBeGreaterThan(0)
      expect(() => expectNoOutboundConnections(report)).toThrow()
    } finally {
      rmSync(veydr.workDir, { recursive: true, force: true })
    }
  })
}

test('the production build blocks WebRTC STUN traffic from the renderer', async () => {
  const veydr = await launchVeydr()
  try {
    // WebRTC is not governed by CSP; the window must have the UDP-disabling policy applied.
    const outcome = await veydr.window.evaluate(async () => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:192.0.2.1:3478' }] })
      pc.createDataChannel('probe')
      await pc.setLocalDescription(await pc.createOffer())
      await new Promise((r) => setTimeout(r, 2500))
      pc.close()
      return 'attempted'
    })
    expect(outcome).toBe('attempted')
    expectNoOutboundConnections(await veydr.close())
  } finally {
    rmSync(veydr.workDir, { recursive: true, force: true })
  }
})

test('the production build contains no network probe', () => {
  const main = readFileSync(join(repoRoot, 'out/main/index.js'), 'utf8')
  // Guards against a stale or empty bundle making the absence checks vacuous.
  expect(main).toContain('requestSingleInstanceLock')
  expect(main).not.toContain('192.0.2.1')
  expect(main).not.toContain('VEYDR_NET_PROBE')
  expect(main).not.toContain('runNetworkProbe')
  // The dev-server override is also compiled out of production builds.
  expect(main).not.toContain('ELECTRON_RENDERER_URL')
})
