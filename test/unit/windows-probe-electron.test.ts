import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHECKS } from '../../scripts/windows-probe/checks.mjs'
import { deriveStatus } from '../../scripts/windows-probe/summary.mjs'
import { type ContextMeasurement, type ProgramResult, contextIds } from '../../scripts/windows-probe/driver.mjs'
import { type ElectronMeasurements, KOFFI_NOT_APPROVED, consoleAnswer, electronAnswers, playwrightAnswer, runElectron } from '../../scripts/windows-probe/electron.mjs'
import { type NsisBuild, type NsisInstall, INSTALL_DIRECTORY, builderArgs, builderEnv, installAnswer, installedPrograms, nsisAnswers, nsisBuildAnswer, runNsis } from '../../scripts/windows-probe/nsis.mjs'
import { placeholderIds } from '../../scripts/windows-probe/placeholder.mjs'
import { type SmokeReport, type SmokeRun, SMOKE_REPORT_PREFIX, appEnv, launchAnswer, outputTail, parseSmokeReport, reportAnswers, runSmoke, smokeAnswers, smokeIds } from '../../scripts/windows-probe/smoke-run.mjs'
import { SMOKE_REPORT_PREFIX as APP_PREFIX } from '../../src/main/app/smoke'

// The parts of the Electron and installer probes that can be checked anywhere: how runs become answers,
// and how the drivers are wired. What the app does on Windows is measured by the windows-probe workflow.

const root = join(__dirname, '../..')
const ran = (overrides: Partial<ProgramResult> = {}): ProgramResult => ({ code: 0, signal: null, stdout: '', stderr: '', ...overrides })
const electronIds = placeholderIds('electron', 'admin')
const nsisIds = placeholderIds('nsis', 'admin')

const unpackaged: SmokeReport = {
  result: 'fail',
  packaged: false,
  checks: [
    { name: 'process-sandbox', ok: true, detail: 'no --no-sandbox switch' },
    { name: 'config-dir-writable', ok: true, detail: 'C:\\Users\\x' },
    { name: 'platform', ok: false, detail: 'no platform implementation for windows' },
    { name: 'ui-loaded', ok: true, detail: 'app://veydr/' },
    { name: 'preload-bridge', ok: true, detail: 'app' },
    { name: 'renderer-isolation', ok: true, detail: 'on' },
  ],
}
const packaged: SmokeReport = { ...unpackaged, packaged: true, checks: [...unpackaged.checks, { name: 'devtools-disabled', ok: true, detail: 'did not open' }] }
const reported = (report: SmokeReport, overrides: Partial<SmokeRun> = {}): SmokeRun => ({ run: ran({ code: 1 }), report, reportVia: 'pipe', ...overrides })
const noReport: SmokeRun = { run: ran({ code: 1, stdout: 'out', stderr: 'err' }), problem: 'the app printed no smoke report', reportVia: null }
const line = (value: unknown): string => `${SMOKE_REPORT_PREFIX}${JSON.stringify(value)}`

describe('smoke report', () => {
  it('uses the prefix smoke.ts writes', () => {
    expect(SMOKE_REPORT_PREFIX).toBe(APP_PREFIX)
  })

  it('finds the report among other output, whatever the line ending', () => {
    expect(parseSmokeReport(`noise\r\n${line(unpackaged)}\r\nmore\r\n`)).toEqual({ report: unpackaged })
  })

  it('reads a report whose text is not ASCII, from the bytes runProgram keeps as Latin-1', () => {
    const report = { ...unpackaged, appPath: 'C:\\Übung' }
    expect(parseSmokeReport(Buffer.from(line(report), 'utf8').toString('latin1'))).toEqual({ report })
  })

  it('gives a reason for no report, two reports, and a report it cannot use', () => {
    expect(parseSmokeReport('nothing')).toEqual({ problem: 'the app printed no smoke report' })
    expect(parseSmokeReport(`${line(unpackaged)}\n${line(unpackaged)}`)).toEqual({ problem: 'the app printed 2 smoke reports' })
    expect(parseSmokeReport(`${SMOKE_REPORT_PREFIX}{`)).toEqual({ problem: 'the smoke report is not JSON' })
    for (const bad of [{}, { ...unpackaged, result: 'maybe' }, { ...unpackaged, packaged: 'no' }, { ...unpackaged, checks: [{ name: 'x' }] }, { ...unpackaged, checks: [unpackaged.checks[0], unpackaged.checks[0]] }]) {
      expect(parseSmokeReport(line(bad)), JSON.stringify(bad)).toEqual({ problem: 'the smoke report is malformed' })
    }
  })

  it('starts Electron without what changes its mode, on any spelling Windows allows', () => {
    expect(appEnv({ PATH: 'p', ELECTRON_RUN_AS_NODE: '1', electron_no_asar: '1', NODE_OPTIONS: '-r x', Node_Options: '-r y', NODE_PATH: 'n' })).toEqual({ PATH: 'p', NODE_PATH: 'n' })
  })

  it('keeps the end of a long output, where a tool says why it failed', () => {
    expect(outputTail(`${'a'.repeat(1000)}  the\n reason `).endsWith('a the reason')).toBe(true)
    expect(outputTail('x'.repeat(1000))).toHaveLength(500)
  })
})

describe('smoke run', () => {
  const script = (body: string): string[] => ['-e', body]
  const inTemp = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'veydr-smoke-run-'))
    try {
      return await run(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('takes a report from the pipe without a second run', async () => {
    const body = `console.log(${JSON.stringify(line(unpackaged))}); process.exit(1)`
    const smoke = await inTemp((dir) => runSmoke(process.execPath, script(body), { dir, env: appEnv() }))
    expect(smoke).toMatchObject({ reportVia: 'pipe', report: unpackaged })
    expect(smoke.run.code).toBe(1)
    expect(smoke.fileRun).toBeUndefined()
  })

  it('repeats a run with no report on the pipe with stdout in a file, and says so', async () => {
    // Writes the report only when stdout is a file, as a report lost on a pipe would look.
    const body = `if (require('node:fs').fstatSync(1).isFile()) console.log(${JSON.stringify(line(unpackaged))}); process.exit(1)`
    const smoke = await inTemp((dir) => runSmoke(process.execPath, script(body), { dir, env: appEnv() }))
    expect(smoke).toMatchObject({ reportVia: 'file', report: unpackaged })
    expect(launchAnswer(smoke)).toMatchObject({ answer: 'no', detail: expect.stringContaining('wrote one to a file') as string })
  })

  it('does not take a report from a repeated run that ended otherwise than it says', async () => {
    const body = `if (require('node:fs').fstatSync(1).isFile()) console.log(${JSON.stringify(line(unpackaged))}); process.exit(7)`
    const smoke = await inTemp((dir) => runSmoke(process.execPath, script(body), { dir, env: appEnv() }))
    expect(smoke).toMatchObject({ reportVia: null, problem: 'the run with stdout in a file exited with 7, but its report says fail' })
    expect(smoke.report).toBeUndefined()
  })

  it('does not repeat a run whose report a file would not change', async () => {
    const smoke = await inTemp((dir) => runSmoke(process.execPath, script(`console.log(${JSON.stringify(`${SMOKE_REPORT_PREFIX}{`)})`), { dir, env: appEnv() }))
    expect(smoke).toMatchObject({ reportVia: null, problem: 'the smoke report is not JSON' })
    expect(smoke.fileRun).toBeUndefined()
  })

  it('reports a run with no report at all, and does not repeat one that did not start', async () => {
    const silent = await inTemp((dir) => runSmoke(process.execPath, script('process.exit(3)'), { dir, env: appEnv() }))
    expect(silent).toMatchObject({ reportVia: null, problem: 'the app printed no smoke report, on a pipe or in a file' })
    expect(silent.fileRun?.code).toBe(3)
    const missing = await inTemp((dir) => runSmoke(join(dir, 'missing.exe'), [], { dir, env: appEnv() }))
    expect(missing.fileRun).toBeUndefined()
    expect(launchAnswer(missing).answer).toBeNull()
  })
})

describe('launch and smoke answers', () => {
  it('answers yes for a report on a pipe, whatever the report says', () => {
    expect(launchAnswer(reported(unpackaged))).toEqual({ answer: 'yes', detail: '' })
  })

  it('answers no with the output for an app that printed no report', () => {
    const { answer, detail } = launchAnswer(noReport)
    expect(answer).toBe('no')
    expect(detail).toContain('stdout: out; stderr: err')
  })

  it('answers each check from the report, with the platform\'s failure as a no', () => {
    const { answers, unknown } = smokeAnswers({ prefix: 'electron', ids: smokeIds(electronIds, 'electron'), smoke: reported(unpackaged), packaged: false })
    expect(unknown).toEqual([])
    expect(answers['electron-smoke-platform']).toMatchObject({ answer: 'no', detail: 'no platform implementation for windows' })
    expect(answers['electron-smoke-ui-loaded']).toMatchObject({ answer: 'yes', detail: '', data: { reportVia: 'pipe', runCode: 1, runSignal: null } })
    expect(answers['electron-smoke-timeout']).toMatchObject({ answer: 'yes' })
  })

  it('answers no for a timeout entry, and null for a check the report leaves out', () => {
    const cut: SmokeReport = { ...unpackaged, checks: [unpackaged.checks[0] as SmokeReport['checks'][number], { name: 'timeout', ok: false, detail: 'not finished within 30000 ms' }] }
    const { answers } = smokeAnswers({ prefix: 'electron', ids: smokeIds(electronIds, 'electron'), smoke: reported(cut), packaged: false })
    expect(answers['electron-smoke-timeout']).toMatchObject({ answer: 'no', detail: 'not finished within 30000 ms' })
    expect(answers['electron-smoke-ui-loaded']).toMatchObject({ answer: null, detail: 'the report has no ui-loaded check' })
  })

  it('needs a detail for a no even when the report gives none', () => {
    const empty: SmokeReport = { ...unpackaged, checks: [{ name: 'platform', ok: false, detail: '' }] }
    expect(smokeAnswers({ prefix: 'electron', ids: ['electron-smoke-platform'], smoke: reported(empty), packaged: false }).answers['electron-smoke-platform']?.detail).toBe('reported as failed')
  })

  it('answers null for every check without a usable report', () => {
    const ids = smokeIds(nsisIds, 'nsis')
    for (const [smoke, reason] of [[noReport, 'the app printed no smoke report'], [reported(unpackaged), 'the report says packaged false']] as const) {
      const { answers, unknown } = smokeAnswers({ prefix: 'nsis', ids, smoke, packaged: true })
      expect(unknown).toEqual([])
      for (const id of ids) expect(answers[id], id).toMatchObject({ answer: null, detail: reason })
    }
  })

  it('keeps a report\'s check without an ID apart, so the driver can reject it (design D4)', () => {
    const extra: SmokeReport = { ...unpackaged, checks: [...unpackaged.checks, { name: 'new-check', ok: true, detail: '' }] }
    expect(smokeAnswers({ prefix: 'electron', ids: smokeIds(electronIds, 'electron'), smoke: reported(extra), packaged: false }).unknown).toEqual(['new-check'])
  })

  it('reports every answer before rejecting an unknown check, so the evidence stays', () => {
    const seen: string[] = []
    expect(() => reportAnswers((id) => seen.push(id), ['a', 'b'], { answers: { a: { answer: 'yes', detail: '' } }, unknown: ['new-check'] })).toThrow('not in checks.mjs: new-check')
    expect(seen).toEqual(['a', 'b'])
  })
})

describe('electron answers', () => {
  const stats = (overrides = {}): string => JSON.stringify({ stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0, ...overrides } })
  const noConsole = (pid: number): ContextMeasurement => ({
    targetPid: pid,
    parentPid: pid,
    console: { attached: false, lastError: 6, window: 0 },
    job: { error: 'n/a' },
    token: { error: 'n/a' },
    hkcu: { error: 'n/a' },
  })
  const measured = (overrides: Partial<ElectronMeasurements> = {}): ElectronMeasurements => ({
    smoke: reported(unpackaged),
    playwright: ran({ stdout: stats() }),
    mainConsole: { pid: 77, measurement: noConsole(77) },
    ...overrides,
  })

  it('answers yes only if the one test passed: a skipped test also exits with 0', () => {
    expect(playwrightAnswer(ran({ stdout: stats() }))).toEqual({ answer: 'yes', detail: '' })
    expect(playwrightAnswer(ran({ stdout: stats({ expected: 0, skipped: 1 }) })).answer).toBe('no')
    expect(playwrightAnswer(ran({ stdout: stats({ expected: 2 }) })).answer).toBe('no')
    expect(playwrightAnswer(ran({ stdout: stats({ flaky: 1 }) })).answer).toBe('no')
  })

  it('carries the failing test\'s message, without colour codes', () => {
    const report = { stats: { expected: 0, unexpected: 1 }, suites: [{ specs: [{ tests: [{ results: [{ errors: [{ message: '\u001b[31mwindow did not render\u001b[39m' }] }] }] }] }] }
    const { answer, detail } = playwrightAnswer(ran({ code: 1, stdout: JSON.stringify(report) }))
    expect(answer).toBe('no')
    expect(detail).toContain('window did not render')
    expect(detail).not.toContain('\u001b')
  })

  it('tells a Playwright that failed before reporting from one that could not be read', () => {
    expect(playwrightAnswer(ran({ code: 1, stderr: 'Error: no config' }))).toMatchObject({ answer: 'no', detail: expect.stringContaining('no config') as string })
    expect(playwrightAnswer(ran({ stdout: 'not json' })).answer).toBeNull()
    expect(playwrightAnswer(ran({ code: null, signal: 'SIGTERM' })).answer).toBeNull()
    expect(playwrightAnswer(ran({ code: null, error: 'ENOENT' })).answer).toBeNull()
  })

  it('reads the console of Electron\'s own process only', () => {
    expect(consoleAnswer({ pid: 77, measurement: noConsole(77) })).toMatchObject({ answer: 'yes', data: { electronPid: 77 } })
    expect(consoleAnswer({ pid: 78, measurement: noConsole(77) }).answer).toBeNull()
    expect(consoleAnswer({ pid: 77, measurement: { ...noConsole(77), console: { attached: true, lastError: 0, window: 5 } } }).answer).toBe('no')
    expect(consoleAnswer({ pid: 77, measurement: { error: 'no result' } })).toMatchObject({ answer: null, detail: 'context.ps1 failed: no result' })
  })

  it('answers every check of the area, with the koffi check not approved (design D6)', () => {
    const { answers } = electronAnswers({ ids: electronIds, ...measured() })
    expect(Object.keys(answers).sort()).toEqual([...electronIds].sort())
    expect(answers['ffi-koffi-electron']).toEqual({ answer: null, detail: KOFFI_NOT_APPROVED, data: {} })
    expect(KOFFI_NOT_APPROVED).toBe('not approved')
    expect(deriveStatus('yes', null)).toBe('NOT-TESTABLE')
  })

  const collect = async (run: (write: (line: string) => void) => Promise<void>): Promise<{ id: string; answer: unknown; data: Record<string, unknown> }[]> => {
    const lines: { id: string; answer: unknown; data: Record<string, unknown> }[] = []
    await run((text) => lines.push(JSON.parse(text) as (typeof lines)[number]))
    return lines
  }
  const context = { measure: () => Promise.resolve({ error: 'not measured' }), probeDirectory: () => ({ usable: true as const }) }

  it('reports each check once, after the context checks', async () => {
    const lines = await collect((write) => runElectron(['--user', 'admin'], { ...context, write, measureArea: () => Promise.resolve(measured()) }))
    expect(lines.map((l) => l.id).sort()).toEqual([...contextIds('admin'), ...electronIds].sort())
    expect(lines.slice(0, contextIds('admin').length).map((l) => l.id)).toEqual(contextIds('admin'))
    for (const entry of lines) expect(entry.data['context'], entry.id).toEqual({ user: 'admin', console: 'none' })
  })

  it('answers null for every check if the measurements failed, and fails a run with an unknown smoke check', async () => {
    const lines = await collect((write) => runElectron(['--user', 'admin'], { ...context, write, measureArea: () => Promise.reject(new Error('boom')) }))
    for (const entry of lines.filter((l) => !l.id.startsWith('ctx-') || l.id === 'ctx-electron-no-console')) expect(entry.answer, entry.id).toBeNull()
    const extra: SmokeReport = { ...unpackaged, checks: [...unpackaged.checks, { name: 'new-check', ok: true, detail: '' }] }
    const written: string[] = []
    await expect(runElectron(['--user', 'admin'], { ...context, write: (text) => written.push(text), measureArea: () => Promise.resolve(measured({ smoke: reported(extra) })) })).rejects.toThrow('new-check')
    expect(written).toHaveLength(contextIds('admin').length + electronIds.length)
  })

  it('takes no positional arguments, and runs only as administrator', async () => {
    await expect(runElectron(['x', '--user', 'admin'], context)).rejects.toThrow('expected no positional arguments')
    await expect(runElectron(['--user', 'standard'], context)).rejects.toThrow('has no checks that run as standard')
  })

  it('keeps Playwright, which deletes its output directory when it starts, away from the results file', () => {
    const config = readFileSync(join(root, 'test/windows-probe/playwright.config.ts'), 'utf8')
    const outputDir = /outputDir: '([^']+)'/.exec(config)?.[1]
    expect(outputDir).toBeDefined()
    const resolved = resolve(root, 'test/windows-probe', outputDir ?? '')
    expect(resolved).toBe(join(root, 'test-results/windows-probe-playwright'))
    expect(join(root, 'test-results/windows-probe/results/electron.jsonl').startsWith(`${resolved}${sep}`)).toBe(false)
  })

  it('does not put the probe\'s spec in the e2e suite, which reads only test/e2e', () => {
    expect(readFileSync(join(root, 'playwright.config.ts'), 'utf8')).toContain("testDir: 'test/e2e'")
    const spec = readFileSync(join(root, 'test/windows-probe/launch.spec.ts'), 'utf8')
    expect(spec.match(/from '[^']+'/g)).toEqual(["from 'node:path'", "from '@playwright/test'"])
  })
})

describe('nsis answers', () => {
  const build = (overrides: Partial<NsisBuild> = {}): NsisBuild => ({ run: ran(), installerSize: 90_000_000, configChanged: false, ...overrides })
  const programs = { app: 'Veydr.exe', uninstaller: 'Uninstall Veydr.exe' }
  const steps = (overrides: Partial<NsisInstall> = {}): NsisInstall & { install: ProgramResult } => ({
    install: ran(),
    directory: 'C:\\Users\\r\\AppData\\Local\\Programs\\veydr',
    programs,
    smoke: reported(packaged),
    uninstall: ran(),
    left: false,
    ...overrides,
  })

  it('builds per user and one-click from options, writing only to the given directory', () => {
    const args = builderArgs('C:\\t\\dist')
    expect(args.slice(0, 5)).toEqual(['--win', 'nsis', '--x64', '--publish', 'never'])
    expect(args).toContain('-c.directories.output=C:\\t\\dist')
    expect(args).toContain('-c.nsis.oneClick=true')
    expect(args).toContain('-c.nsis.perMachine=false')
    expect(args).toContain('-c.nsis.runAfterFinish=false')
    expect(args.some((a) => /--config\b|\.yml/.test(a))).toBe(false)
  })

  it('answers the build from its exit, its installer, and the configuration file', () => {
    expect(nsisBuildAnswer(build())).toEqual({ answer: 'yes', detail: '' })
    expect(nsisBuildAnswer(build({ run: ran({ code: 1, stderr: 'makensis failed' }) }))).toMatchObject({ answer: 'no', detail: expect.stringContaining('makensis failed') as string })
    expect(nsisBuildAnswer(build({ installerSize: undefined }))).toMatchObject({ answer: 'no', detail: expect.stringContaining('built no') as string })
    expect(nsisBuildAnswer(build({ configChanged: true }))).toMatchObject({ answer: 'no', detail: expect.stringContaining('changed') as string })
    expect(nsisBuildAnswer(build({ run: ran({ code: null, signal: 'SIGTERM' }) })).answer).toBeNull()
  })

  it('uses the build\'s own credentials-free environment, keeping the build tools\' settings', () => {
    const env = builderEnv({ PATH: 'p', ELECTRON_MIRROR: 'm', ELECTRON_BUILDER_CACHE: 'c', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: 'x', GH_TOKEN: 't', github_token: 't', CSC_LINK: 'l', CSC_KEY_PASSWORD: 'k', WIN_CSC_LINK: 'w' })
    expect(env).toEqual({ PATH: 'p', ELECTRON_MIRROR: 'm', ELECTRON_BUILDER_CACHE: 'c', CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
  })

  it('expects the install directory electron-builder names after the package', () => {
    expect((JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string }).name).toBe(INSTALL_DIRECTORY)
  })

  it('finds an install\'s programs, whatever their case', () => {
    expect(installedPrograms(['Veydr.exe', 'Uninstall Veydr.exe', 'ffmpeg.dll', 'resources'])).toEqual(programs)
    expect(installedPrograms(['VEYDR.EXE', 'UNINSTALL VEYDR.EXE'])).toEqual({ app: 'VEYDR.EXE', uninstaller: 'UNINSTALL VEYDR.EXE' })
    expect(installedPrograms(['a.exe', 'b.exe'])).toEqual({ app: undefined, uninstaller: undefined })
  })

  it('answers yes when install, smoke test and uninstall all worked, with a failing report as code 1', () => {
    expect(installAnswer(steps())).toEqual({ answer: 'yes', detail: '' })
  })

  it('answers no at the step that failed', () => {
    const cases: [Partial<NsisInstall>, string][] = [
      [{ install: ran({ code: 2, stderr: 'denied' }) }, 'denied'],
      [{ directory: undefined }, 'holds no veydr directory, only: nothing'],
      [{ directory: undefined, found: ['Veydr App', 'other'] }, 'only: Veydr App, other'],
      [{ programs: { app: undefined, uninstaller: 'u' } }, 'exactly one program'],
      [{ smoke: noReport }, 'printed no smoke report'],
      [{ smoke: reported(packaged, { reportVia: 'file' }) }, 'the install worked, and the uninstall was clean, but'],
      [{ smoke: reported(packaged, { run: ran({ code: 0 }) }) }, 'its report says fail'],
      [{ smoke: reported({ ...packaged, result: 'pass' }) }, 'its report says pass'],
      [{ programs: { app: 'v', uninstaller: undefined } }, 'exactly one uninstaller'],
      [{ uninstall: ran({ code: 1 }) }, 'silent uninstall'],
      [{ left: true }, 'still there'],
    ]
    for (const [overrides, reason] of cases) expect(installAnswer(steps(overrides)), reason).toMatchObject({ answer: 'no', detail: expect.stringContaining(reason) as string })
  })

  it('answers null for a step that gave no answer', () => {
    expect(installAnswer(steps({ install: ran({ code: null, signal: 'SIGTERM' }) })).answer).toBeNull()
    expect(installAnswer(steps({ uninstall: ran({ code: null, signal: 'SIGTERM' }) })).answer).toBeNull()
    expect(installAnswer(steps({ smoke: undefined })).answer).toBeNull()
  })

  it('answers every check, and null without an installer, the reason on each', () => {
    expect(Object.keys(nsisAnswers({ ids: nsisIds, build: build(), installed: steps() }).answers).sort()).toEqual([...nsisIds].sort())
    const { answers } = nsisAnswers({ ids: nsisIds, build: build({ run: ran({ code: 1 }) }), installed: { reason: 'no installer was built' } })
    expect(answers['nsis-build']?.answer).toBe('no')
    for (const id of nsisIds.filter((i) => i !== 'nsis-build')) expect(answers[id], id).toMatchObject({ answer: null, detail: 'no installer was built' })
  })

  it('reports each check once, after the context checks', async () => {
    const lines: { id: string }[] = []
    await runNsis(['--user', 'admin'], {
      measure: () => Promise.resolve({ error: 'not measured' }),
      write: (text) => lines.push(JSON.parse(text) as { id: string }),
      measureArea: () => Promise.resolve({ build: build(), installed: steps() }),
    })
    expect(lines.map((l) => l.id).sort()).toEqual([...contextIds('admin'), ...nsisIds].sort())
  })

  it('covers every check of the catalog\'s two areas', () => {
    const expected = CHECKS.filter((c) => c.kind === 'check' && ['electron', 'nsis'].includes(c.area)).map((c) => c.id)
    expect([...electronIds, ...nsisIds].sort()).toEqual(expected.sort())
  })
})
