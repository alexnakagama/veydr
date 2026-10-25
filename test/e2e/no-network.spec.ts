import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { killTagged, taggedProcesses } from '../support/proc'
import { expect, expectNoOutboundConnections, launchVeydr, repoRoot, test } from './support/fixtures'
import { fullSession, pickDirectoryPath } from './support/session'

const fsGuardPath = join(__dirname, 'support', 'fs-guard.cjs')

/**
 * Node `fs` calls that create, change, or remove something, or may. `open` counts on purpose (the
 * guard does not record its flags): Veydr has no reason to open a file in a project folder, so a
 * future read-by-open there should fail this test and be looked at.
 */
const MUTATING_FS = /^fs\.(promises\.)?(appendFile|chmod|chown|copyFile|cp|lchown|link|lutimes|mkdir|open|rename|rm|rmdir|symlink|truncate|unlink|utimes|writeFile|createWriteStream)(Sync)?$/

/** Every entry under `dir` (itself included) with its type, inode, mode, size, and times. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const add = (full: string): void => {
    const st = lstatSync(full)
    out[full.slice(dir.length) || '.'] = [st.isDirectory() ? 'd' : 'f', st.ino, st.mode, st.size, st.mtimeMs, st.ctimeMs].join(':')
    if (st.isDirectory()) for (const name of readdirSync(full)) add(join(full, name))
  }
  add(dir)
  return out
}

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

test('[spec:desktop-shell/no-outbound-connections] [spec:config-storage/project-directories-untouched] a full session opens no outbound connections and leaves the project folder untouched', async () => {
  const work = mkdtempSync(join(tmpdir(), 'veydr-e2e-session-'))
  const project = join(work, 'shop')
  mkdirSync(join(project, 'src'), { recursive: true })
  writeFileSync(join(project, 'package.json'), '{}\n')
  writeFileSync(join(project, 'src/index.js'), '// app\n')
  const pickFile = join(work, 'pick.txt')
  writeFileSync(pickFile, project)
  const guardLog = join(work, 'fs-guard.jsonl')
  const tag = crypto.randomUUID()
  const before = snapshot(project)
  const veydr = await launchVeydr({
    preloads: [pickDirectoryPath, fsGuardPath],
    env: { VEYDR_TEST_PICK_FILE: pickFile, VEYDR_FS_GUARD_DIR: project, VEYDR_FS_GUARD_LOG: guardLog },
  })
  try {
    await fullSession(veydr.window, { project, ledger: join(work, 'ledger.jsonl'), tag })
    expectNoOutboundConnections(await veydr.close())
    expect(taggedProcesses(tag)).toEqual([])

    // Nothing inside the project folder was created, changed, or removed, and Veydr made no
    // Node fs call there that could (it only looks: stat, access, realpath, and the like).
    // Limits: the guard sees the main process's Node fs only (Chromium's own file access and other
    // processes are covered by the snapshot alone); the snapshot ignores atime and cannot see a
    // file created and deleted again in between.
    expect(snapshot(project)).toEqual(before)
    expect(existsSync(guardLog)).toBe(true)
    const calls = readFileSync(guardLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { api: string; path: string | null })
    expect(calls[0]).toMatchObject({ api: 'guard', path: null })
    expect(calls.filter((c) => MUTATING_FS.test(c.api))).toEqual([])
    // The guard did see Veydr look at the folder (validation), so the empty list is not vacuous.
    expect(calls.some((c) => c.api === 'fs.promises.stat' && c.path === project)).toBe(true)
  } finally {
    await veydr.app.close().catch(() => undefined)
    killTagged(tag)
    rmSync(veydr.workDir, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})
