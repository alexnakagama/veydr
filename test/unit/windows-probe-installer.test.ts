import { readFileSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHECKS, PROBE_AREAS } from '../../scripts/windows-probe/checks.mjs'
import { type ContextMeasurement, type ProgramResult, DriverUsageError, runDriver } from '../../scripts/windows-probe/driver.mjs'
import type { AclReport } from '../../scripts/windows-probe/install-acl.mjs'
import {
  type ControlRun,
  type HelperOutcome,
  type InstallerSteps,
  type InstallState,
  AREA,
  CATALOG,
  HELPER_ID,
  INSTALL_ID,
  INSTALLER_ID,
  PERMISSIONS_ID,
  PROTOCOL_VERSION,
  SMOKE_CASES,
  SMOKE_CHECKS,
  SMOKE_ID,
  STEP_IDS,
  UNINSTALL_ID,
  parseInstallerArgs,
  runInstallerStandardUser,
} from '../../scripts/windows-probe/installer-standard-user.mjs'
import type { SmokeRun } from '../../scripts/windows-probe/smoke-run.mjs'
import { PROTOCOL_VERSION as VEYDR_PROTOCOL_VERSION } from '../../src/main/platform/windows/protocol'

// The standard user's installation (add-windows-packaging task 4.2, design D5): the driver that
// installs, inspects, runs and uninstalls Veydr as the temporary standard user. Each step's outcome
// is injected here; the real run is test/packaging-windows/standard-user-install.test.ts in CI.

const root = join(__dirname, '../..')
const SHA = 'a'.repeat(64)
const NAME = 'Veydr-0.1.0-rc.1-x64-setup.exe'
const ELECTRON = 'D:\\a\\veydr\\veydr\\node_modules\\electron\\dist\\electron.exe'
const ARGS = [NAME, SHA, ELECTRON, '--user', 'standard']
const PROFILE = 'C:\\Users\\veydr-probe'
const LOCAL = `${PROFILE}\\AppData\\Local`
const INSTALL_DIR = `${LOCAL}\\Programs\\veydr`
const USER_SID = 'S-1-5-21-1-2-3-1001'

/** What context.ps1 prints for a console-less driver as the standard user. */
const measured = (pid: number): ContextMeasurement => ({
  targetPid: pid,
  parentPid: pid,
  console: { attached: false, lastError: 6, window: 0 },
  job: { driverInJob: false, helperInJob: false, limitFlags: null, limitsError: null },
  token: { user: 'RUNNER\\veydr-probe', elevated: false, elevationType: 'default', administrators: 'absent' },
  hkcu: { environment: 'absent', environmentValues: 0 },
  helper: 'detached',
})

const program = (overrides: Partial<ProgramResult> = {}): ProgramResult => ({ code: 0, signal: null, stdout: '', stderr: '', ...overrides })

const installedState = (overrides: Partial<InstallState> = {}): InstallState => ({
  directory: true,
  programs: ['Veydr.exe', 'Uninstall Veydr.exe'],
  resources: ['veydr-helper.exe', 'app.asar'],
  startMenu: { path: `${PROFILE}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Veydr.lnk`, target: `${INSTALL_DIR}\\Veydr.exe` },
  uninstall: [{ key: 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{guid}', displayName: 'Veydr 0.1.0-rc.1', uninstallString: `"${INSTALL_DIR}\\Uninstall Veydr.exe" /currentuser`, installLocation: '' }],
  processes: [],
  ...overrides,
})
const goneState: InstallState = { directory: false, programs: [], resources: [], startMenu: null, uninstall: [], processes: [] }

const aclOf = (path: string, access: AclReport['paths'][number]['access'] = [
  { sid: 'S-1-5-18', type: 'Allow', rights: 0x1f01ff, inherited: true },
  { sid: 'S-1-5-32-544', type: 'Allow', rights: 0x1f01ff, inherited: true },
  { sid: USER_SID, type: 'Allow', rights: 0x1f01ff, inherited: true },
]) => ({ path, owner: USER_SID, access })
const acls = (extra: AclReport['paths'][number]['access'] = []): AclReport => ({
  user: USER_SID,
  paths: [INSTALL_DIR, `${INSTALL_DIR}\\Veydr.exe`, `${INSTALL_DIR}\\resources\\app.asar`, `${INSTALL_DIR}\\resources\\veydr-helper.exe`].map((p, i) => (i === 3 ? aclOf(p, [...aclOf(p).access, ...extra]) : aclOf(p))),
})

const LISTENER = { port: 50123, pid: 4321 }
const portsLine = (listeners: unknown[], owners: unknown[]) => `${JSON.stringify({ type: 'ports', takenAt: '133000000000000000', listeners, owners })}\n`
const helperOk = (overrides: Partial<HelperOutcome> = {}): HelperOutcome => ({
  version: program({ stdout: `${PROTOCOL_VERSION}\r\n` }),
  ports: {
    code: 0,
    signal: null,
    stdout: Buffer.from(portsLine([{ family: 'ipv4', address: '7f000001', port: LISTENER.port, pid: LISTENER.pid }], [{ pid: LISTENER.pid, state: 'known', created: '132000000000000000', image: 'C:\\node\\node.exe' }])),
    stderr: '',
    ms: 40,
  },
  listener: LISTENER,
  ...overrides,
})

const smokeReport = (overrides: Record<string, unknown> = {}) => ({
  result: 'pass' as const,
  packaged: true,
  appPath: `${INSTALL_DIR}\\resources\\app.asar`,
  checks: SMOKE_CHECKS.map((name) => ({ name, ok: true, detail: name === 'platform' ? 'windows: 40 environment variables, 12 listening sockets readable' : '' })),
  ...overrides,
})
const smokePassed: SmokeRun = { run: program(), report: smokeReport(), reportVia: 'pipe' }
/** Electron as a secondary-logon account without a desktop: STATUS_DLL_INIT_FAILED. */
const smokeNoDesktop: SmokeRun = { run: program({ code: -1073741502 }), problem: 'the app printed no smoke report, on a pipe or in a file', reportVia: null, fileRun: program({ code: -1073741502 }) }
const controlOpened: ControlRun = { version: program({ stdout: 'v44.9.3\n' }), window: program(), loaded: true }
const controlNoWindow: ControlRun = { version: program({ code: -1073741502 }), window: program({ code: -1073741502 }), loaded: false }

interface Line {
  id: string
  answer: 'yes' | 'no' | null
  detail: string
  data: Record<string, unknown>
}

/** Steps that all succeed; each test replaces what it is about, and the calls are recorded. */
function fakeSteps(overrides: Partial<InstallerSteps> = {}): { steps: InstallerSteps; calls: string[] } {
  const calls: string[] = []
  let installed = false
  const call = <T>(name: string, value: T): T => {
    calls.push(name)
    return value
  }
  const steps: InstallerSteps = {
    environment: () => ({ localAppData: LOCAL, profile: PROFILE }),
    installerFile: (name) => `C:\\veydr-probe-std\\scripts\\windows-probe\\${name}`,
    hash: () => Promise.resolve(call('hash', SHA)),
    exists: (path) => (path === INSTALL_DIR || path === `${INSTALL_DIR}\\Uninstall Veydr.exe` ? installed : false),
    install: () => {
      installed = true
      return Promise.resolve(call('install', { ...program(), ms: 15_000 }))
    },
    inspect: () => Promise.resolve(call('inspect', installed ? installedState() : goneState)),
    watchProcesses: () => Promise.resolve(call('watchProcesses', [])),
    permissions: () => Promise.resolve(call('permissions', acls())),
    helper: () => Promise.resolve(call('helper', helperOk())),
    smoke: () => Promise.resolve(call('smoke', smokePassed)),
    control: () => Promise.resolve(call('control', controlOpened)),
    uninstall: () => {
      installed = false
      return Promise.resolve(call('uninstall', { ...program(), ms: 2_000 }))
    },
    waitUntilGone: () => Promise.resolve(call('waitUntilGone', false)),
    tempDir: () => call('tempDir', 'C:\\Users\\veydr-probe\\AppData\\Local\\Temp\\veydr-install-std-1'),
    removeDir: () => {
      calls.push('removeDir')
    },
    ...overrides,
  }
  return { steps, calls }
}

async function drive(steps: InstallerSteps, args: readonly string[] = ARGS) {
  const lines: string[] = []
  const error = await runInstallerStandardUser(args, { steps, measure: (pid) => Promise.resolve(measured(pid)), probeDirectory: () => ({ usable: true }), write: (l) => lines.push(l) }).then(
    () => undefined,
    (e: unknown) => e,
  )
  const parsed = lines.map((l) => JSON.parse(l) as Line)
  return { lines: parsed, byId: new Map(parsed.map((l) => [l.id, l])), error }
}

const CONTEXT = ['ctx-no-console', 'ctx-job', 'ctx-standard-user']

describe('installer-standard-user.mjs', () => {
  it('reports the context checks, then one line per step, all passing, with the installer as SHA256SUMS names it', async () => {
    const { steps, calls } = fakeSteps()
    const { lines, byId, error } = await drive(steps)
    expect(error).toBeUndefined()
    expect(lines.map((l) => [l.id, l.answer])).toEqual([...CONTEXT, ...STEP_IDS].map((id) => [id, 'yes']))
    expect(byId.get(INSTALLER_ID)?.data).toMatchObject({ installer: `${SHA}  ${NAME}`, expected: SHA, context: { user: 'standard', console: 'none' } })
    expect(byId.get(INSTALL_ID)?.data).toMatchObject({ installDir: INSTALL_DIR, code: 0 })
    expect(byId.get(PERMISSIONS_ID)?.data).toMatchObject({ user: USER_SID, checked: 4 })
    expect(byId.get(HELPER_ID)?.data).toMatchObject({ ownerState: 'known', listener: LISTENER })
    expect(byId.get(SMOKE_ID)?.data).toMatchObject({ smokeCase: 'passed', control: { outcome: 'opened' } })
    expect(byId.get(UNINSTALL_ID)?.data).toMatchObject({ code: 0 })
    // The order of the steps, the control always run, and the uninstall last.
    expect(calls).toEqual(['hash', 'install', 'inspect', 'watchProcesses', 'permissions', 'helper', 'tempDir', 'smoke', 'control', 'removeDir', 'uninstall', 'waitUntilGone', 'inspect'])
  })

  it('accepts only `<installer name> <sha256> <electron.exe> --user standard [--unavailable <reason>]`, refusing anything else before running anything', async () => {
    expect(parseInstallerArgs(ARGS)).toEqual({ installerName: NAME, sha256: SHA, electron: ELECTRON, unavailable: undefined })
    const refused: string[][] = [
      [],
      ['--user', 'standard'],
      [NAME, SHA, ELECTRON, '--user', 'admin'],
      [NAME, SHA, ELECTRON, 'extra', '--user', 'standard'],
      [NAME, SHA, '--user', 'standard'],
      ['veydr-0.1.0-rc.1-x64-setup.exe', SHA, ELECTRON, '--user', 'standard'],
      ['Veydr-1.2.3+b-x64-setup.exe', SHA, ELECTRON, '--user', 'standard'],
      ['..\\Veydr-1.2.3-x64-setup.exe', SHA, ELECTRON, '--user', 'standard'],
      [NAME, SHA.toUpperCase(), ELECTRON, '--user', 'standard'],
      [NAME, SHA.slice(1), ELECTRON, '--user', 'standard'],
      [NAME, SHA, 'electron.exe', '--user', 'standard'],
      [NAME, SHA, 'C:\\Windows\\System32\\cmd.exe', '--user', 'standard'],
      [NAME, SHA, 'D:\\a\\veydr\\veydr\\node_modules\\electron\\dist\\..\\..\\..\\evil\\node_modules\\electron\\dist\\electron.exe', '--user', 'standard'],
      [NAME, SHA, 'D:/a/veydr/node_modules/electron/dist/electron.exe', '--user', 'standard'],
      [NAME, SHA, '\\\\server\\share\\node_modules\\electron\\dist\\electron.exe', '--user', 'standard'],
      [NAME, SHA, ELECTRON, '--user', 'standard', '--helper', 'x'],
    ]
    for (const args of refused) {
      const { steps, calls } = fakeSteps()
      const { lines, error } = await drive(steps, args)
      expect(error, args.join(' ')).toBeInstanceOf(DriverUsageError)
      expect(lines, args.join(' ')).toEqual([])
      expect(calls, args.join(' ')).toEqual([])
    }
  })

  it('answers every line with the reason when the standard user is unavailable, without running anything', async () => {
    const { steps, calls } = fakeSteps()
    const { lines, error } = await drive(steps, [...ARGS, '--unavailable', 'cannot create the account veydr-probe'])
    expect(error).toBeUndefined()
    expect(lines.map((l) => l.id)).toEqual([...CONTEXT, ...STEP_IDS])
    for (const line of lines) {
      expect(line.answer, line.id).toBeNull()
      expect(line.data['unavailable'], line.id).toBe(true)
      expect(line.detail, line.id).toContain('cannot create the account veydr-probe')
    }
    expect(calls).toEqual([])
  })

  it('never runs an installer copy whose SHA-256 differs from the one the launcher checked', async () => {
    const other = 'b'.repeat(64)
    const { steps, calls } = fakeSteps({ hash: () => Promise.resolve(other) })
    const { lines, byId } = await drive(steps)
    expect(byId.get(INSTALLER_ID)).toMatchObject({ answer: 'no', data: { installer: `${other}  ${NAME}`, expected: SHA } })
    expect(lines.slice(CONTEXT.length + 1).map((l) => [l.id, l.answer, l.detail])).toEqual(STEP_IDS.slice(1).map((id) => [id, null, 'not run: the installer copy was not the one the launcher checked']))
    expect(calls).toEqual([])
  })

  it('install fails: no step needing the installation runs, and an uninstaller it left is still run', async () => {
    // A failed install that still left its uninstaller (and nothing else that counts).
    let uninstallerLeft = false
    const failing = fakeSteps({
      install: () => {
        uninstallerLeft = true
        return Promise.resolve({ ...program({ code: 2, stderr: 'NSIS error' }), ms: 900 })
      },
      exists: (path) => uninstallerLeft && path === `${INSTALL_DIR}\\Uninstall Veydr.exe`,
      inspect: () => Promise.resolve(goneState),
      uninstall: () => {
        uninstallerLeft = false
        return Promise.resolve(program())
      },
    })
    const { byId, lines } = await drive(failing.steps)
    expect(byId.get(INSTALL_ID)).toMatchObject({ answer: 'no', detail: expect.stringContaining('the silent install exited with 2') as string })
    for (const id of [PERMISSIONS_ID, HELPER_ID, SMOKE_ID]) expect(byId.get(id), id).toMatchObject({ answer: null, detail: 'not run: the install failed' })
    expect(byId.get(UNINSTALL_ID)?.answer).toBe('yes')
    expect(uninstallerLeft).toBe(false)
    expect(lines.map((l) => l.id)).toEqual([...CONTEXT, ...STEP_IDS])
    expect(failing.calls).not.toContain('permissions')

    // An install that left nothing: the uninstall is not run either.
    const nothing = fakeSteps({ install: () => Promise.resolve(program({ code: null, signal: 'SIGTERM' })), exists: () => false })
    const result = await drive(nothing.steps)
    expect(result.byId.get(INSTALL_ID)).toMatchObject({ answer: null, detail: 'the installer did not finish within 180 s' })
    expect(result.byId.get(UNINSTALL_ID)).toMatchObject({ answer: null, detail: expect.stringContaining('does not exist') as string })
    expect(nothing.calls).not.toContain('uninstall')
  })

  it('install succeeds but leaves the wrong things: each is named', async () => {
    const cases: [Partial<InstallState>, string][] = [
      [{ startMenu: null }, 'there is no Start menu entry Veydr.lnk'],
      [{ startMenu: { path: 'x.lnk', target: 'C:\\other\\Veydr.exe' } }, 'the Start menu entry points at'],
      [{ uninstall: [] }, 'there are 0 uninstall entries of Veydr under HKCU, not one'],
      [{ programs: ['Veydr.exe', 'Uninstall Veydr.exe', 'elevate.exe'] }, 'not Veydr.exe and one uninstaller'],
      [{ resources: ['app.asar'] }, 'resources\\ holds ["app.asar"]'],
      [{ directory: false }, 'does not exist'],
    ]
    for (const [state, detail] of cases) {
      const { steps } = fakeSteps({ inspect: () => Promise.resolve(installedState(state)) })
      const { byId } = await drive(steps)
      expect(byId.get(INSTALL_ID), detail).toMatchObject({ answer: 'no', detail: expect.stringContaining(detail) as string })
    }
    // A Veydr.exe from the install directory (or one whose path cannot be read) running afterwards.
    for (const processes of [[{ pid: 77, path: `${INSTALL_DIR}\\Veydr.exe` }], [{ pid: 78, path: null }]]) {
      const { steps } = fakeSteps({ watchProcesses: () => Promise.resolve(processes) })
      expect((await drive(steps)).byId.get(INSTALL_ID)).toMatchObject({ answer: 'no', detail: expect.stringContaining('Veydr.exe is running after the silent install') as string })
    }
    // Not below the account's own profile.
    const { steps } = fakeSteps({ environment: () => ({ localAppData: LOCAL, profile: 'C:\\Users\\someone-else' }) })
    expect((await drive(steps)).byId.get(INSTALL_ID)).toMatchObject({ answer: 'no', detail: expect.stringContaining('is not below the account\'s profile') as string })
  })

  it('a permission entry is rejected: Users with write access on the helper', async () => {
    const { steps } = fakeSteps({ permissions: () => Promise.resolve(acls([{ sid: 'S-1-5-32-545', type: 'Allow', rights: 0x2, inherited: false }])) })
    const { byId } = await drive(steps)
    const line = byId.get(PERMISSIONS_ID)
    expect(line).toMatchObject({ answer: 'no', detail: `${INSTALL_DIR}\\resources\\veydr-helper.exe: S-1-5-32-545 Allow WriteData` })
    expect(line?.data['violations']).toEqual([{ path: `${INSTALL_DIR}\\resources\\veydr-helper.exe`, sid: 'S-1-5-32-545', problem: 'Allow WriteData' }])
    // The steps after it still run.
    expect(byId.get(HELPER_ID)?.answer).toBe('yes')
    expect(byId.get(UNINSTALL_ID)?.answer).toBe('yes')

    // A report that misses one of the named paths, or whose user is no account SID, is not a pass.
    const partial = fakeSteps({ permissions: () => Promise.resolve({ user: USER_SID, paths: acls().paths.slice(0, 3) }) })
    expect((await drive(partial.steps)).byId.get(PERMISSIONS_ID)).toMatchObject({ answer: 'no', detail: expect.stringContaining('the ACL report misses') as string })
    const group = fakeSteps({ permissions: () => Promise.resolve({ ...acls(), user: 'S-1-1-0' }) })
    expect((await drive(group.steps)).byId.get(PERMISSIONS_ID)).toMatchObject({ answer: 'no', detail: expect.stringContaining('cannot be judged') as string })
  })

  it('the helper\'s version differs, or its `version` fails', async () => {
    const differs = fakeSteps({ helper: () => Promise.resolve(helperOk({ version: program({ stdout: '2\r\n' }) })) })
    expect((await drive(differs.steps)).byId.get(HELPER_ID)).toMatchObject({ answer: 'no', detail: `the helper's \`version\` printed "2", not the protocol version ${PROTOCOL_VERSION}` })
    const failed = fakeSteps({ helper: () => Promise.resolve(helperOk({ version: program({ code: 1, stderr: 'boom' }) })) })
    expect((await drive(failed.steps)).byId.get(HELPER_ID)).toMatchObject({ answer: 'no', detail: expect.stringContaining('exited with 1') as string })
    const missing = fakeSteps({ helper: () => Promise.resolve(helperOk({ version: program({ code: null, error: 'spawn ENOENT' }) })) })
    expect((await drive(missing.steps)).byId.get(HELPER_ID)).toMatchObject({ answer: null, detail: 'the helper\'s `version` did not start: spawn ENOENT' })
  })

  it('the listener is missing from the port listing, listed for another PID, or its owner is not readable', async () => {
    const ok = helperOk()
    const listing = (listeners: unknown[], owners: unknown[]) => ({ ...ok.ports, stdout: Buffer.from(portsLine(listeners, owners)) })
    const cases: [HelperOutcome['ports'], string][] = [
      [listing([], []), `does not list the driver's listener on 127.0.0.1:${LISTENER.port}`],
      [listing([{ family: 'ipv4', address: '7f000001', port: LISTENER.port + 1, pid: LISTENER.pid }], [{ pid: LISTENER.pid, state: 'known', created: '1', image: 'x' }]), 'does not list the driver\'s listener'],
      [listing([{ family: 'ipv4', address: '7f000001', port: LISTENER.port, pid: 99 }], [{ pid: 99, state: 'known', created: '1', image: 'x' }]), 'not the driver\'s 4321'],
      [listing([{ family: 'ipv4', address: '7f000001', port: LISTENER.port, pid: LISTENER.pid }], [{ pid: LISTENER.pid, state: 'restricted' }]), 'listed as "restricted", not known'],
      [{ ...ok.ports, stdout: Buffer.from('{"type":"ports"}\n{"x":1}\n') }, 'printed no port listing'],
      [{ ...ok.ports, code: 1, stderr: 'GetExtendedTcpTable failed' }, 'exited with 1: GetExtendedTcpTable failed'],
    ]
    for (const [ports, detail] of cases) {
      const { steps } = fakeSteps({ helper: () => Promise.resolve({ ...ok, ports }) })
      expect((await drive(steps)).byId.get(HELPER_ID), detail).toMatchObject({ answer: 'no', detail: expect.stringContaining(detail) as string })
    }
    const stopped = fakeSteps({ helper: () => Promise.resolve({ ...ok, ports: { ...ok.ports, code: null, signal: 'SIGTERM', stopped: 'timeout' } }) })
    expect((await drive(stopped.steps)).byId.get(HELPER_ID)?.answer).toBeNull()
  })

  it('the uninstall leaves the directory, the Start menu entry or the uninstall entry, or fails', async () => {
    const left = fakeSteps({ waitUntilGone: () => Promise.resolve(true), inspect: () => Promise.resolve(installedState()) })
    const line = (await drive(left.steps)).byId.get(UNINSTALL_ID)
    expect(line).toMatchObject({ answer: 'no' })
    expect(line?.detail).toContain(`the directory ${INSTALL_DIR}`)
    expect(line?.detail).toContain('the Start menu entry')
    expect(line?.detail).toContain('the uninstall entry HKEY_CURRENT_USER')
    const failed = fakeSteps({ uninstall: () => Promise.resolve(program({ code: 5 })) })
    expect((await drive(failed.steps)).byId.get(UNINSTALL_ID)).toMatchObject({ answer: 'no', detail: expect.stringContaining('the silent uninstall exited with 5') as string })
  })

  describe('the smoke step, by the rule of design D5', () => {
    it('passed: the installed app passed its smoke test', async () => {
      const { steps } = fakeSteps()
      expect((await drive(steps)).byId.get(SMOKE_ID)).toMatchObject({ answer: 'yes', data: { smokeCase: 'passed', reportVia: 'pipe', code: 0, appPath: `${INSTALL_DIR}\\resources\\app.asar` } })
    })

    it('not testable: it failed, and the stock binary could not open a window for the account either', async () => {
      const { steps } = fakeSteps({ smoke: () => Promise.resolve(smokeNoDesktop), control: () => Promise.resolve(controlNoWindow) })
      const line = (await drive(steps)).byId.get(SMOKE_ID)
      expect(line).toMatchObject({ answer: null, data: { smokeCase: 'not-testable', control: { outcome: 'failed', windowCode: -1073741502 } } })
      expect(line?.detail).toMatch(/^not testable: the installed app's smoke test failed \(the app printed no smoke report, on a pipe or in a file\), and the stock Electron binary could not open a window/)
      // A control that hung, or ran without loading its window, counts the same.
      for (const control of [{ ...controlOpened, window: program({ code: null, signal: 'SIGTERM' }), loaded: false }, { ...controlOpened, loaded: false }]) {
        const hung = fakeSteps({ smoke: () => Promise.resolve(smokeNoDesktop), control: () => Promise.resolve(control) })
        expect((await drive(hung.steps)).byId.get(SMOKE_ID)?.data).toMatchObject({ smokeCase: 'not-testable' })
      }
    })

    it('failed: it failed while the stock binary opened its window, or the control did not start at all', async () => {
      const report = smokeReport({ result: 'fail', checks: SMOKE_CHECKS.map((name) => ({ name, ok: name !== 'platform', detail: name === 'platform' ? 'the helper cannot be started' : '' })) })
      const { steps } = fakeSteps({ smoke: () => Promise.resolve({ run: program({ code: 1 }), report, reportVia: 'pipe' }), control: () => Promise.resolve(controlOpened) })
      const line = (await drive(steps)).byId.get(SMOKE_ID)
      expect(line).toMatchObject({ answer: 'no', data: { smokeCase: 'failed', control: { outcome: 'opened' } } })
      expect(line?.detail).toBe('the installed app\'s smoke test failed: failed checks: platform: the helper cannot be started; the stock Electron binary opened a window for this account')
      const notStarted = fakeSteps({ smoke: () => Promise.resolve(smokeNoDesktop), control: () => Promise.resolve({ ...controlNoWindow, window: program({ code: null, error: 'spawn EACCES' }) }) })
      expect((await drive(notStarted.steps)).byId.get(SMOKE_ID)).toMatchObject({ answer: 'no', data: { smokeCase: 'failed', control: { outcome: 'not-started' } } })
    })

    it('a report that passed is still checked: all seven checks, packaged, from the installed archive, sockets readable, exit code 0', async () => {
      const cases: [SmokeRun, string][] = [
        [{ ...smokePassed, report: smokeReport({ checks: smokeReport().checks.slice(0, 6) }) }, 'not the seven of a packaged build'],
        [{ ...smokePassed, report: smokeReport({ packaged: false }) }, 'packaged false'],
        [{ ...smokePassed, report: smokeReport({ appPath: 'D:\\a\\veydr\\veydr\\dist\\win-unpacked\\resources\\app.asar' }) }, 'not the installed app.asar'],
        [{ ...smokePassed, report: smokeReport({ checks: smokeReport().checks.map((c) => (c.name === 'platform' ? { ...c, detail: 'windows: 40 environment variables, ports not read' } : c)) }) }, 'not readable listening sockets'],
        [{ ...smokePassed, run: program({ code: 3 }) }, 'although its report passed'],
      ]
      for (const [smoke, detail] of cases) {
        const { steps } = fakeSteps({ smoke: () => Promise.resolve(smoke) })
        expect((await drive(steps)).byId.get(SMOKE_ID), detail).toMatchObject({ answer: 'no', detail: expect.stringContaining(detail) as string, data: { smokeCase: 'failed' } })
      }
      // A report that reached only a file, from a run that ended as it says, passes: the pipe is not what this step asks.
      const viaFile = fakeSteps({ smoke: () => Promise.resolve({ run: program({ code: 0 }), report: smokeReport(), reportVia: 'file', fileRun: program({ code: 0 }) }) })
      expect((await drive(viaFile.steps)).byId.get(SMOKE_ID)).toMatchObject({ answer: 'yes', data: { reportVia: 'file' } })
      expect(SMOKE_CASES).toEqual(['passed', 'not-testable', 'failed'])
    })
  })

  it('a step that throws answers null with the error, and the uninstall still runs', async () => {
    const { steps, calls } = fakeSteps({
      permissions: () => Promise.reject(new Error('Get-Acl: access denied')),
      smoke: () => Promise.reject(new Error('spawn failed')),
    })
    const { byId, error } = await drive(steps)
    expect(error).toBeUndefined()
    expect(byId.get(PERMISSIONS_ID)).toMatchObject({ answer: null, detail: 'the step failed: Get-Acl: access denied' })
    expect(byId.get(SMOKE_ID)).toMatchObject({ answer: null, detail: 'the step failed: spawn failed' })
    expect(byId.get(UNINSTALL_ID)?.answer).toBe('yes')
    // The temporary directory is removed even when the smoke step threw.
    expect(calls.filter((c) => c === 'tempDir' || c === 'removeDir')).toEqual(['tempDir', 'removeDir'])
  })

  it('refuses to install over an existing installation, and over relative profile paths', async () => {
    const existing = fakeSteps({ exists: (path) => path === INSTALL_DIR })
    const { lines } = await drive(existing.steps)
    expect(lines.slice(CONTEXT.length + 1).map((l) => [l.id, l.answer])).toEqual(STEP_IDS.slice(1).map((id) => [id, null]))
    expect(lines[CONTEXT.length + 1]?.detail).toBe(`not run: ${INSTALL_DIR} exists before the install`)
    expect(existing.calls).toEqual(['hash'])
    const relative = fakeSteps({ environment: () => ({ localAppData: 'AppData\\Local', profile: PROFILE }) })
    expect((await drive(relative.steps)).byId.get(INSTALL_ID)?.detail).toContain('must be absolute paths')
    expect(relative.calls).toEqual(['hash'])
  })

  it('stays out of the probe registries: its area and lines are its own, which a probe driver cannot report', async () => {
    expect(PROBE_AREAS).not.toContain(AREA)
    expect(CHECKS.filter((c) => (c.area as string) === AREA || STEP_IDS.includes(c.id))).toEqual([])
    for (const file of ['scripts/windows-probe/checks.mjs', 'scripts/windows-probe/summary.mjs', '.github/workflows/windows-probe.yml', 'test/windows-probe/predictions.json', 'test/unit/windows-probe-summary.test.ts']) {
      expect(readFileSync(join(root, file), 'utf8'), file).not.toMatch(/installer-standard-user|install-std-/)
    }
    const write = () => undefined
    const measure = () => Promise.reject(new Error('measured'))
    await expect(runDriver({ area: AREA, user: 'standard', ids: [INSTALLER_ID], probe: () => undefined, measure, write })).rejects.toThrow(DriverUsageError)
    await expect(runDriver({ area: 'nsis', user: 'admin', ids: ['nsis-install'], catalog: CATALOG, probe: () => undefined, measure, write })).rejects.toThrow(DriverUsageError)
  })

  it('expects the protocol version Veydr needs, and runs the stock window script from its own directory', () => {
    expect(PROTOCOL_VERSION).toBe(VEYDR_PROTOCOL_VERSION)
    const source = readFileSync(join(root, 'scripts/windows-probe/installer-standard-user.mjs'), 'utf8')
    // Imports only from its own directory, which the launcher copies for the account.
    const imports = [...source.matchAll(/^import .* from '([^']+)'$/gm)].map((m) => m[1] ?? '')
    expect(imports.filter((s) => !s.startsWith('node:') && !/^\.\/[a-z-]+\.mjs$/.test(s))).toEqual([])
    expect(source).toContain("const STOCK_WINDOW_SCRIPT = fileURLToPath(new URL('./stock-window.cjs', import.meta.url))")
    const window = readFileSync(join(root, 'scripts/windows-probe/stock-window.cjs'), 'utf8')
    expect(window).toContain("writeFileSync(outFile, LOADED, { flag: 'wx' })")
    expect(window).toContain('new BrowserWindow({ show: false')
    expect(win32.isAbsolute(ELECTRON)).toBe(true)
  })
})
