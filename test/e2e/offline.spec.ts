import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { killTagged, taggedProcesses } from '../support/proc'
import { expect, expectNoOutboundConnections, launchVeydr, repoRoot, test } from './support/fixtures'
import { fullSession, pickDirectoryPath } from './support/session'

// Spec desktop-shell "Offline operation": the outer test runs this file again inside a new
// network namespace that has only a loopback interface (no route anywhere), where the inner
// test drives a full session. Host-dependent: it needs unprivileged user and network namespaces
// (refused e.g. under Ubuntu 24.04's AppArmor restriction) and `ip` (iproute2). Where they are
// missing it fails with that reason; VEYDR_ALLOW_SKIP_OFFLINE=1 turns that failure into a skip,
// so the scenario is never passed without having run.

const INNER = process.env['VEYDR_OFFLINE_INNER'] === '1'

/** Interfaces of this network namespace (`/sys/class/net` shows the namespace sysfs was mounted in). */
const interfaces = (): string[] =>
  readFileSync('/proc/self/net/dev', 'utf8')
    .split('\n')
    .slice(2)
    .map((line) => line.split(':')[0]?.trim() ?? '')
    .filter(Boolean)

/** Resolves how connecting to TEST-NET-1 fails (`ENETUNREACH` without any route). */
function unreachable(): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host: '192.0.2.1', port: 80 })
    socket.setTimeout(3000, () => {
      socket.destroy()
      resolve('timeout')
    })
    socket.once('connect', () => {
      socket.destroy()
      resolve('connected')
    })
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message))
  })
}

test.describe('offline', () => {
  test.skip(!INNER, 'runs inside the network namespace started by the outer test')

  test('[spec:desktop-shell/offline-operation] every feature works with no network connectivity', async () => {
    // The namespace really is offline: loopback only, and no route to any other address.
    expect(interfaces()).toEqual(['lo'])
    expect(await unreachable()).toBe('ENETUNREACH')

    const work = mkdtempSync(join(tmpdir(), 'veydr-e2e-offline-'))
    const project = join(work, 'shop')
    mkdirSync(project)
    const pickFile = join(work, 'pick.txt')
    writeFileSync(pickFile, project)
    const tag = crypto.randomUUID()
    const veydr = await launchVeydr({ preloads: [pickDirectoryPath], env: { VEYDR_TEST_PICK_FILE: pickFile } })
    try {
      await fullSession(veydr.window, { project, ledger: join(work, 'ledger.jsonl'), tag })
      await expect(veydr.window.getByTestId('notice')).toHaveCount(0)
      expectNoOutboundConnections(await veydr.close())
      expect(taggedProcesses(tag)).toEqual([])
    } finally {
      await veydr.app.close().catch(() => undefined)
      killTagged(tag)
      rmSync(veydr.workDir, { recursive: true, force: true })
      rmSync(work, { recursive: true, force: true })
    }
  })
})

test.describe('offline runner', () => {
  test.skip(INNER, 'the outer test only')

  test('[spec:desktop-shell/offline-operation] runs the offline session in a network namespace without connectivity', () => {
    test.setTimeout(180_000)
    const output = mkdtempSync(join(tmpdir(), 'veydr-e2e-offline-run-'))
    const uid = process.getuid?.() ?? 0
    const gid = process.getgid?.() ?? 0
    const env = { ...process.env, PATH: `${process.env['PATH'] ?? ''}:/usr/sbin:/sbin`, VEYDR_OFFLINE_INNER: '1', VEYDR_UID: String(uid), VEYDR_GID: String(gid) }
    // Probe the namespaces this needs, so an unsuitable host is reported as such.
    const probe = spawnSync('unshare', ['--user', '--map-root-user', '--net', '--', 'sh', '-c', 'ip link set lo up && unshare --user --map-user="$VEYDR_UID" --map-group="$VEYDR_GID" -- true'], { env, encoding: 'utf8' })
    if (probe.status !== 0) {
      const reason = `offline-operation cannot be verified on this host: ${(probe.error?.message ?? probe.stderr).trim() || `exit ${String(probe.status)}`}`
      test.skip(process.env['VEYDR_ALLOW_SKIP_OFFLINE'] === '1', reason)
      throw new Error(reason)
    }
    try {
      // Outer namespace: root there may bring loopback up. Inner namespace: back to the user's own
      // IDs (Chromium refuses to run as root), keeping the offline network namespace.
      const playwright = join(repoRoot, 'node_modules/@playwright/test/cli.js')
      const inner = [process.execPath, playwright, 'test', '-c', 'playwright.config.ts', 'test/e2e/offline.spec.ts', '--output', output]
      const script = 'ip link set lo up && exec unshare --user --map-user="$VEYDR_UID" --map-group="$VEYDR_GID" -- "$@"'
      const run = spawnSync('unshare', ['--user', '--map-root-user', '--net', '--', 'sh', '-c', script, 'sh', ...inner], {
        cwd: repoRoot,
        env,
        encoding: 'utf8',
        timeout: 170_000,
      })
      const report = `${run.stdout}\n${run.stderr}`
      expect(run.status, report).toBe(0)
      expect(report).toContain('1 passed')
      expect(report).toContain('1 skipped')
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  })
})
