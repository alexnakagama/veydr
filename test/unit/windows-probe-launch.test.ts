import { type ChildProcess, type SpawnOptions, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { CHECKS, PROBE_AREAS } from '../../scripts/windows-probe/checks.mjs'
import {
  type ContextMeasurement,
  type ProbeDirectory,
  DriverUsageError,
  checkProbeDirectory,
  contextAnswers,
  contextResult,
  contextIds,
  jobLimitNames,
  parseDriverArgs,
  runDriver,
} from '../../scripts/windows-probe/driver.mjs'
import { LaunchUsageError, isResultLine, launch, parseLaunchArgs } from '../../scripts/windows-probe/launch-detached.mjs'
import {
  type HelperRun,
  AREA,
  CATALOG,
  EXIT_ID,
  HELPER_PATH,
  HELPER_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  OUTPUT_ID,
  helperAnswers,
  runHelperPorts,
  runPortsStandardUser,
} from '../../scripts/windows-probe/ports-standard-user.mjs'
import { MAX_PORTS_OUTPUT_BYTES } from '../../src/main/platform/windows/protocol'

// The execution contexts of the Windows probes (tasks 3.1–3.2, design D9): the launcher that starts
// every driver without a console, and the driver runtime that reports the context checks first.
// context.ps1 and standard-user.ps1 need Windows PowerShell 5.1 and an administrator; they run in the
// windows-probe workflow, and their measurement is fed in here as data.

const root = join(__dirname, '../..')
const DRIVER_PID = 4242

/** What context.ps1 prints for a console-less driver inside a job, as the standard user, with `overrides`. */
const measured = (overrides: Record<string, unknown> = {}, pid = DRIVER_PID): ContextMeasurement => ({
  targetPid: pid,
  parentPid: pid,
  console: { attached: false, lastError: 6, window: 0 },
  job: { driverInJob: true, helperInJob: true, limitFlags: 0x2c00, limitsError: null },
  token: { user: 'RUNNER\\veydr-probe', elevated: false, elevationType: 'default', administrators: 'absent' },
  hkcu: { environment: 'present', environmentValues: 2 },
  helper: 'detached',
  ...overrides,
})

const answers = (user: 'admin' | 'standard', measurement: ContextMeasurement, probeDir: ProbeDirectory = { usable: true }) =>
  Object.fromEntries(contextAnswers({ user, measurement, driverPid: DRIVER_PID, probeDir }).map((a) => [a.id, a]))

describe('context checks (driver.mjs)', () => {
  it('reports ctx-no-console and ctx-job first for every driver, and ctx-standard-user for the standard user', () => {
    expect(contextIds('admin')).toEqual(['ctx-no-console', 'ctx-job'])
    expect(contextIds('standard')).toEqual(['ctx-no-console', 'ctx-job', 'ctx-standard-user'])
    // The catalog's context checks are exactly these: a new one needs an answer here.
    const context = CHECKS.filter((c) => c.kind === 'check' && c.area === 'context').map((c) => c.id)
    expect(context.sort()).toEqual(['ctx-job', 'ctx-no-console', 'ctx-standard-user'])
  })

  it('answers ctx-no-console from AttachConsole(ATTACH_PARENT_PROCESS) on the driver', () => {
    expect(answers('admin', measured())['ctx-no-console']).toMatchObject({ answer: 'yes', data: { attachParent: 'failed with error 6', consoleWindow: '0x0', contextHelper: 'detached' } })
    // The negative control: the driver shares the shell's console.
    const attached = answers('admin', measured({ console: { attached: true, lastError: 0, window: 0x1a2b } }))['ctx-no-console']
    expect(attached).toMatchObject({ answer: 'no', data: { attachParent: 'succeeded', consoleWindow: '0x1a2b' } })
    expect(attached?.detail).toContain('the driver has a console')
    // Anything that does not show the driver's console is no answer.
    const unknown = [
      measured({ console: { attached: false, lastError: 31, window: 0 } }),
      measured({ console: { attached: false, lastError: 6, window: 0x10 } }),
      measured({ parentPid: 1 }),
      measured({ console: { error: 'Access is denied' } }),
      measured({ console: { attached: 'no', lastError: 6, window: 0 } }),
      measured({ console: undefined }),
    ]
    for (const m of unknown) {
      const line = answers('admin', m)['ctx-no-console']
      expect(line?.answer, JSON.stringify(m)).toBeNull()
      expect(line?.detail, JSON.stringify(m)).not.toBe('')
    }
    expect(answers('admin', measured({ parentPid: 1 }))['ctx-no-console']?.detail).toContain('not the driver')
  })

  it('answers ctx-job with the membership and the job limits in data', () => {
    const inside = answers('admin', measured())['ctx-job']
    expect(inside).toMatchObject({ answer: 'no', data: { inJob: true, limitFlags: '0x2c00', limits: ['DIE_ON_UNHANDLED_EXCEPTION', 'BREAKAWAY_OK', 'KILL_ON_JOB_CLOSE'] } })
    expect(inside?.detail).toBe('the driver is inside a Job Object, with limits DIE_ON_UNHANDLED_EXCEPTION BREAKAWAY_OK KILL_ON_JOB_CLOSE')
    const unreadable = answers('admin', measured({ job: { driverInJob: true, helperInJob: false, limitFlags: null, limitsError: 'silent breakaway' } }))['ctx-job']
    expect(unreadable).toMatchObject({ answer: 'no', data: { inJob: true, limitsUnreadable: 'silent breakaway' } })
    expect(unreadable?.detail).toContain('whose limits could not be read')
    expect(answers('admin', measured({ job: { driverInJob: false, helperInJob: false, limitFlags: null, limitsError: null } }))['ctx-job']).toMatchObject({
      answer: 'yes',
      detail: '',
      data: { inJob: false },
    })
    const denied = answers('admin', measured({ job: { error: 'Access is denied' } }))['ctx-job']
    expect(denied?.answer).toBeNull()
    expect(denied?.detail).toContain('Access is denied')
    expect(answers('admin', measured({ job: { driverInJob: true, limitFlags: '0x0' } }))['ctx-job']?.answer).toBeNull()
    // Starting context.ps1 attached is itself what puts the driver in libuv's job.
    const attached = answers('admin', measured({ helper: 'attached', job: { driverInJob: true, helperInJob: true, limitFlags: null, limitsError: 'attached' } }))['ctx-job']
    expect(attached).toMatchObject({ answer: null, data: { inJob: true } })
    expect(attached?.detail).toContain('hides whether the runner has one')
    expect(jobLimitNames(0)).toEqual([])
    expect(jobLimitNames(0x1000 | 0x80000)).toEqual(['SILENT_BREAKAWAY_OK', '0x80000'])
  })

  it('answers ctx-standard-user yes only for an unelevated token outside Administrators, with its registry hive loaded and the probe directory usable', () => {
    expect(answers('standard', measured())['ctx-standard-user']).toMatchObject({
      answer: 'yes',
      detail: '',
      data: { account: 'RUNNER\\veydr-probe', elevated: false, administrators: 'absent', hkcu: 'loaded', hkcuEnvironment: 'present', hkcuEnvironmentValues: 2, probeDirectory: 'usable' },
    })
    // A new profile's hive may hold no Environment key: the hive is loaded all the same.
    expect(answers('standard', measured({ hkcu: { environment: 'absent', environmentValues: 0 } }))['ctx-standard-user']).toMatchObject({
      answer: 'yes',
      data: { hkcu: 'loaded', hkcuEnvironment: 'absent' },
    })
    const token = { user: 'RUNNER\\runneradmin', elevated: false, elevationType: 'limited', administrators: 'absent' }
    const no: [Record<string, unknown>, string][] = [
      [{ token: { ...token, elevated: true, elevationType: 'full', administrators: 'enabled' } }, 'the token is elevated; the token holds Administrators (enabled)'],
      // An administrator's filtered token still holds the group, for deny only.
      [{ token: { ...token, administrators: 'deny-only' } }, 'the token holds Administrators (deny-only)'],
      [{ hkcu: { error: "HKCU\\Software does not exist, so the user's registry hive is not loaded" } }, "the user's registry hive is not readable"],
      [{ hkcu: { environment: 'present' } }, "the user's registry hive is not readable: context.ps1 reported a malformed hkcu section"],
    ]
    for (const [overrides, detail] of no) {
      const line = answers('standard', measured(overrides))['ctx-standard-user']
      expect(line?.answer, detail).toBe('no')
      expect(line?.detail, detail).toContain(detail)
    }
    const unusable = answers('standard', measured(), { usable: false, error: 'C:\\veydr-probe-std: EPERM' })['ctx-standard-user']
    expect(unusable).toMatchObject({ answer: 'no', detail: 'the probe directory is not usable: C:\\veydr-probe-std: EPERM', data: { probeDirectory: 'unusable' } })
    expect(answers('standard', measured({ token: { error: 'Access is denied' } }))['ctx-standard-user']?.answer).toBeNull()
  })

  it('answers nothing, with the reason, when context.ps1 gave no measurement', () => {
    for (const measurement of [{ error: 'context.ps1 runs only on Windows' }, null, []] as unknown as ContextMeasurement[]) {
      for (const line of contextAnswers({ user: 'standard', measurement, driverPid: DRIVER_PID })) {
        expect(line.answer, line.id).toBeNull()
        expect(line.detail, line.id).toMatch(/^context\.ps1 /)
      }
    }
  })

  it('takes the measurement from context.ps1\'s result file, and says why there is none', () => {
    const json = JSON.stringify(measured())
    expect(contextResult({ code: 0, signal: null, fileText: json })).toEqual(measured())
    expect(contextResult({ code: 0, signal: null, fileText: `﻿${json}` })).toEqual(measured())
    const cases: [Parameters<typeof contextResult>[0], string][] = [
      // What the first windows-probe runs saw through stdout: a detached run that left no trace.
      [{ code: 0, signal: null, fileText: undefined }, 'context.ps1 wrote no result file (exited with 0; stdout empty; stderr empty)'],
      [{ code: 1, signal: null, fileText: undefined, stderr: 'Add-Type:\r\n  error' }, 'context.ps1 wrote no result file (exited with 1; stdout empty; stderr "Add-Type: error")'],
      [{ code: null, signal: 'SIGTERM', fileText: undefined }, 'context.ps1 wrote no result file (was stopped after 60 s; stdout empty; stderr empty)'],
      [{ code: 1, signal: null, fileText: '{"error":"context.ps1: cannot compile its P/Invoke helper: CS0246"}' }, 'context.ps1: cannot compile its P/Invoke helper: CS0246 (exited with 1; stdout empty; stderr empty)'],
      [{ code: 0, signal: null, fileText: '{"targ' }, "context.ps1's result file is not JSON"],
      [{ code: 0, signal: null, fileText: '[]' }, "context.ps1's result file holds no JSON object"],
      [{ code: 1, signal: null, fileText: json }, 'context.ps1 wrote a result but exited with 1'],
    ]
    for (const [run, error] of cases) {
      const result = contextResult(run)
      expect('error' in result ? result.error : result, error).toContain(error)
    }
  })

  it('records an attached fallback and why the detached run failed', () => {
    const line = answers('admin', measured({ helper: 'attached', detachedError: 'context.ps1 wrote no result file (exited with 0; stdout empty; stderr empty)' }))['ctx-no-console']
    expect(line?.data).toMatchObject({ contextHelper: 'attached', contextHelperDetachedError: 'context.ps1 wrote no result file (exited with 0; stdout empty; stderr empty)' })
  })
})

describe('runDriver (driver.mjs)', () => {
  const ids = ['pt-control', 'pt-identity']
  const run = async (options: Partial<Parameters<typeof runDriver>[0]> = {}) => {
    const lines: string[] = []
    const error = await runDriver({
      area: 'process-tree',
      user: 'admin',
      ids,
      probe: (report) => {
        report('pt-control', 'yes')
        report('pt-identity', 'no', 'creation time changed', { pids: [1] })
      },
      measure: (pid) => Promise.resolve(measured({}, pid)),
      write: (line) => lines.push(line),
      ...options,
    }).then(
      () => undefined,
      (e: unknown) => e,
    )
    return { lines: lines.map((l) => JSON.parse(l) as { id: string; answer: unknown; detail: string; data: Record<string, unknown> }), error }
  }

  it('reports the context checks first, then the probe, each with the context it was started for', async () => {
    const { lines, error } = await run()
    expect(error).toBeUndefined()
    expect(lines.map((l) => [l.id, l.answer])).toEqual([
      ['ctx-no-console', 'yes'],
      ['ctx-job', 'no'],
      ['pt-control', 'yes'],
      ['pt-identity', 'no'],
    ])
    for (const line of lines) expect(line.data['context'], line.id).toEqual({ user: 'admin', console: 'none' })
    expect(lines[3]?.data).toEqual({ pids: [1], context: { user: 'admin', console: 'none' } })
  })

  it('checks the probe directory for the standard user only', async () => {
    let checked = 0
    const probeDirectory = () => {
      checked++
      return { usable: true } as const
    }
    await run({ probeDirectory })
    expect(checked).toBe(0)
    const { lines } = await run({ user: 'standard', ids: ['pt-control-std'], probe: (report) => report('pt-control-std', 'yes'), probeDirectory })
    expect(checked).toBe(1)
    expect(lines.map((l) => l.id)).toEqual(['ctx-no-console', 'ctx-job', 'ctx-standard-user', 'pt-control-std'])
    expect(lines.every((l) => (l.data['context'] as { user: string }).user === 'standard')).toBe(true)
  })

  it('refuses checks of another area or account, before measuring anything', async () => {
    let measuredCount = 0
    const measure = (pid: number) => {
      measuredCount++
      return Promise.resolve(measured({}, pid))
    }
    for (const options of [{ ids: ['port-ps'] }, { ids: ['pt-control-std'] }, { ids: ['ctx-job'] }, { ids: [] }, { area: 'context' }, { user: 'root' as 'admin' }]) {
      const { lines, error } = await run({ ...options, measure })
      expect(error, JSON.stringify(options)).toBeInstanceOf(DriverUsageError)
      expect(lines).toEqual([])
    }
    expect(measuredCount).toBe(0)
  })

  it('fails on an invalid or missing report, keeping the lines written until then', async () => {
    const cases: [Parameters<typeof runDriver>[0]['probe'], string][] = [
      [(report) => report('port-ps', 'yes'), 'port-ps is not a check this driver reports'],
      [(report) => report('ctx-job', 'yes'), 'ctx-job reported twice'],
      [(report) => report('pt-control', 'maybe' as 'yes'), 'answer must be'],
      [(report) => report('pt-control', 'no'), 'needs a detail'],
      [(report) => report('pt-control', null, '  '), 'needs a detail'],
      [(report) => report('pt-control', 'yes', '', [] as unknown as Record<string, unknown>), 'data must be an object'],
      [(report) => report('pt-control', 'yes'), 'the probe did not report pt-identity'],
      [
        () => {
          throw new Error('probe crashed')
        },
        'probe crashed',
      ],
    ]
    for (const [probe, message] of cases) {
      const { lines, error } = await run({ probe })
      expect((error as Error | undefined)?.message, message).toContain(message)
      expect(lines.slice(0, 2).map((l) => l.id), message).toEqual(['ctx-no-console', 'ctx-job'])
    }
  })

  it('answers every check with the reason when the standard user is unavailable, without measuring or probing', async () => {
    let probed = false
    const { lines, error } = await run({
      user: 'standard',
      ids: ['pt-control-std', 'pt-job-terminate-std'],
      unavailable: 'cannot create the account veydr-probe: the password does not meet the requirements',
      measure: () => Promise.reject(new Error('measured')),
      probe: () => {
        probed = true
      },
    })
    expect(error).toBeUndefined()
    expect(probed).toBe(false)
    expect(lines.map((l) => l.id)).toEqual(['ctx-no-console', 'ctx-job', 'ctx-standard-user', 'pt-control-std', 'pt-job-terminate-std'])
    for (const line of lines) {
      expect(line.answer, line.id).toBeNull()
      expect(line.detail, line.id).toBe('the standard user could not be used: cannot create the account veydr-probe: the password does not meet the requirements')
      expect(line.data, line.id).toEqual({ unavailable: true, context: { user: 'standard', console: 'none' } })
    }
  })

  it('parses the driver command line', () => {
    expect(parseDriverArgs(['ports', '--user', 'standard'])).toEqual({ user: 'standard', unavailable: undefined, positional: ['ports'] })
    expect(parseDriverArgs(['--user', 'standard', '--unavailable', 'no seclogon', 'ports'])).toEqual({ user: 'standard', unavailable: 'no seclogon', positional: ['ports'] })
    for (const args of [[], ['--user'], ['--user', 'root'], ['--user', 'admin', '--user', 'admin'], ['--user', 'admin', '--unavailable', ' '], ['--user', 'admin', '--verbose']]) {
      expect(() => parseDriverArgs(args), args.join(' ')).toThrow(DriverUsageError)
    }
  })
})

describe('checkProbeDirectory (driver.mjs)', () => {
  it('creates, reads and removes a file, and reports a directory it cannot use', () => {
    const dir = mkdtempSync(join(tmpdir(), 'veydr-probe-dir-'))
    try {
      expect(checkProbeDirectory(dir)).toEqual({ usable: true })
      // Nothing is left behind.
      expect(readdirSync(dir)).toEqual([])
      const missing = checkProbeDirectory(join(dir, 'missing'))
      expect(missing.usable).toBe(false)
      expect(missing.usable ? '' : missing.error).toContain(join(dir, 'missing'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('launch-detached.mjs', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'veydr-probe-launch-'))
    dirs.push(dir)
    return dir
  }
  /** A driver script in a fresh directory, and the results file next to it. */
  const driver = (body: string) => {
    const dir = tempDir()
    const file = join(dir, 'driver.mjs')
    writeFileSync(file, body)
    return { dir, file, out: join(dir, 'results.jsonl') }
  }
  const line = (id: string) => JSON.stringify({ id, answer: 'yes', detail: '', data: { context: { user: 'admin', console: 'none' } } })
  /** Whether a process is still running, polling for up to 10 s: Windows ends a tree asynchronously. */
  const gone = async (pid: number): Promise<boolean> => {
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(pid, 0)
      } catch {
        return true
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  }

  it('appends the result lines a driver writes, and its stderr goes to the log', async () => {
    const { file, out } = driver(`process.stdout.write(${JSON.stringify(`${line('a')}\n\n${line('b')}\r\n`)}); process.stdout.write(${JSON.stringify(line('c'))}); console.error('diagnostic', process.argv.slice(2).join(' '))`)
    writeFileSync(out, '{"identity":{}}\n')
    const log: string[] = []
    const result = await launch({ driver: file, driverArgs: ['ports', '--user', 'admin'], out, timeoutMs: 30_000, log: (t) => log.push(t) })
    expect(result).toEqual({ ok: true, lines: 3, problems: [] })
    expect(readFileSync(out, 'utf8')).toBe(`{"identity":{}}\n${line('a')}\n${line('b')}\n${line('c')}\n`)
    expect(log.join('')).toBe('diagnostic ports --user admin\n')
  })

  it('reports a driver that exits with another code as a failed run, keeping its lines', async () => {
    const { file, out } = driver(`console.log(${JSON.stringify(line('a'))}); process.exitCode = 3`)
    const result = await launch({ driver: file, out, timeoutMs: 30_000, log: () => {} })
    expect(result).toEqual({ ok: false, lines: 1, problems: ['the driver exited with code 3'] })
    expect(readFileSync(out, 'utf8')).toBe(`${line('a')}\n`)
  })

  it('reports a driver that exits 0 without writing a result line as a failed run', async () => {
    // As a driver that does not run its main code would, e.g. when it wrongly thinks it was imported.
    const { file, out } = driver('')
    const result = await launch({ driver: file, out, timeoutMs: 30_000, log: () => {} })
    expect(result).toEqual({ ok: false, lines: 0, problems: ['the driver wrote no result lines'] })
    expect(existsSync(out)).toBe(false)
  })

  it('leaves a line that is not a result line out of the results, and fails the run', async () => {
    const { file, out } = driver(`console.log('hello'); console.log('{"answer":"yes"}'); console.log(${JSON.stringify(line('a'))})`)
    const result = await launch({ driver: file, out, timeoutMs: 30_000, log: () => {} })
    expect(result.ok).toBe(false)
    expect(result.lines).toBe(1)
    expect(result.problems).toEqual([
      'the driver wrote a line that is not a result line, left out of the results: hello',
      'the driver wrote a line that is not a result line, left out of the results: {"answer":"yes"}',
    ])
    expect(readFileSync(out, 'utf8')).toBe(`${line('a')}\n`)
  })

  it('stops a driver that does not finish, with its descendants, and keeps the lines it wrote', async () => {
    const pidFile = join(tempDir(), 'pid')
    const { file, out } = driver(
      [
        "import { spawn } from 'node:child_process'",
        "import { writeFileSync } from 'node:fs'",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
        `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))`,
        `console.log(${JSON.stringify(line('a'))})`,
        'setInterval(() => {}, 1000)',
      ].join('\n'),
    )
    const result = await launch({ driver: file, out, timeoutMs: 3_000, log: () => {}, drainMs: 2_000 })
    expect(result).toEqual({ ok: false, lines: 1, problems: ['the driver did not finish within 3 s, so it was stopped with its process tree'] })
    expect(readFileSync(out, 'utf8')).toBe(`${line('a')}\n`)
    expect(existsSync(pidFile)).toBe(true)
    expect(await gone(Number(readFileSync(pidFile, 'utf8')))).toBe(true)
  }, 30_000)

  it('stops reading when a descendant still holds the output after the driver exited', async () => {
    const holder = join(tempDir(), 'pid')
    const { file, out } = driver(
      [
        "import { spawn } from 'node:child_process'",
        "import { writeFileSync } from 'node:fs'",
        "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true })",
        `writeFileSync(${JSON.stringify(holder)}, String(child.pid))`,
        'child.unref()',
        `console.log(${JSON.stringify(line('a'))})`,
      ].join('\n'),
    )
    const log: string[] = []
    try {
      const result = await launch({ driver: file, out, timeoutMs: 30_000, log: (t) => log.push(t), drainMs: 500 })
      expect(result).toEqual({ ok: true, lines: 1, problems: [] })
      expect(log.join('')).toContain("the driver's output was still open 0.5 s after it exited")
    } finally {
      try {
        process.kill(Number(readFileSync(holder, 'utf8')))
      } catch {
        // Already gone.
      }
    }
  }, 30_000)

  it('reports a driver that cannot start', async () => {
    const dir = tempDir()
    const result = await launch({ driver: join(dir, 'missing.mjs'), out: join(dir, 'results.jsonl'), timeoutMs: 30_000, log: () => {} })
    expect(result.ok).toBe(false)
    expect(result.lines).toBe(0)
    // Node itself starts, and exits with 1 for the missing module.
    expect(result.problems).toEqual(['the driver exited with code 1'])
  })

  it('parses its command line, and NEGATIVE_CONTROL for the negative control', () => {
    const args = ['--timeout', '240', '--out', 'r.jsonl', '--', 'scripts/windows-probe/placeholder.mjs', 'ports', '--user', 'admin']
    expect(parseLaunchArgs(args)).toEqual({
      driver: 'scripts/windows-probe/placeholder.mjs',
      driverArgs: ['ports', '--user', 'admin'],
      out: 'r.jsonl',
      log: undefined,
      timeoutMs: 240_000,
      attached: false,
    })
    expect(parseLaunchArgs(args, { NEGATIVE_CONTROL: 'false' }).attached).toBe(false)
    expect(parseLaunchArgs(args, { NEGATIVE_CONTROL: 'true' }).attached).toBe(true)
    expect(parseLaunchArgs(['--log', 'l.log', ...args]).log).toBe('l.log')
    const bad: [string[], Record<string, string>?][] = [
      [args, { NEGATIVE_CONTROL: 'yes' }],
      [args.slice(2)],
      [args.slice(0, 2).concat(args.slice(4))],
      [['--timeout', '0', ...args.slice(2)]],
      [['--timeout', '3601', ...args.slice(2)]],
      [['--timeout', '1.5', ...args.slice(2)]],
      [['--out', 'x', ...args]],
      [['--verbose', 'x', ...args]],
      [args.slice(0, 5)],
      [[...args.slice(0, 5), 'driver.js']],
      [args.filter((a) => a !== '--')],
    ]
    for (const [a, env] of bad) expect(() => parseLaunchArgs(a, env), `${a.join(' ')} ${JSON.stringify(env)}`).toThrow(LaunchUsageError)
  })

  it('accepts as result lines only JSON objects with a check ID and an answer', () => {
    expect(isResultLine(line('a'))).toBe(true)
    for (const text of ['', 'hello', '[]', 'null', '{"id":"a"}', '{"id":"","answer":null}', '{"id":1,"answer":null}', '{"identity":{}}']) {
      expect(isResultLine(text), text).toBe(false)
    }
  })

  it('runs as a command, with its exit codes, writing its messages to --log', () => {
    const { dir, file, out } = driver(`console.log(${JSON.stringify(line('a'))})`)
    const logFile = join(dir, 'launcher.log')
    const script = join(root, 'scripts/windows-probe/launch-detached.mjs')
    const env = { ...process.env, NEGATIVE_CONTROL: 'false' }
    const ok = spawnSync(process.execPath, [script, '--timeout', '30', '--out', out, '--log', logFile, '--', file, 'x'], { encoding: 'utf8', env })
    expect(ok.status, ok.stderr).toBe(0)
    expect(ok.stdout).toBe('')
    expect(readFileSync(out, 'utf8')).toBe(`${line('a')}\n`)
    const log = readFileSync(logFile, 'utf8')
    expect(log).toContain(`starting ${file} x, detached, without a console`)
    expect(log).toContain(`1 result lines appended to ${out}`)

    const negative = spawnSync(process.execPath, [script, '--timeout', '30', '--out', out, '--', file], { encoding: 'utf8', env: { ...env, NEGATIVE_CONTROL: 'true' } })
    expect(negative.status, negative.stderr).toBe(0)
    expect(negative.stderr).toContain('attached to this console (negative control)')

    const usage = spawnSync(process.execPath, [script, '--out', out, '--', file], { encoding: 'utf8', env })
    expect(usage.status).toBe(2)
    expect(usage.stderr).toContain('--timeout <seconds> is required')
    expect(spawnSync(process.execPath, [script, '--timeout', '30', '--out', out, '--', join(dir, 'missing.mjs')], { encoding: 'utf8', env }).status).toBe(2)
    const failing = driver('process.exitCode = 1')
    expect(spawnSync(process.execPath, [script, '--timeout', '30', '--out', failing.out, '--', failing.file], { encoding: 'utf8', env }).status).toBe(1)
  })
})

// The standard user's port listing (add-windows-port-inspection task 4.1, design D7): the driver that
// runs the helper's `ports` as the temporary standard user, and the -Helper parameter that gives
// standard-user.ps1 the helper to copy for it. The real run is in test/integration/windows-ports.test.ts.

describe('ports-standard-user.mjs', () => {
  type Line = { id: string; answer: unknown; detail: string; data: Record<string, unknown> }
  const okRun = (stdout: string, overrides: Partial<HelperRun> = {}): HelperRun => ({ code: 0, signal: null, stdout: Buffer.from(stdout), stderr: '', ms: 12, ...overrides })
  const PORTS_LINE = '{"type":"ports","takenAt":"133000000000000000","listeners":[],"owners":[]}\n'
  const run = async (args: string[], runHelper: () => Promise<HelperRun> = () => Promise.resolve(okRun(PORTS_LINE))) => {
    const lines: string[] = []
    const error = await runPortsStandardUser(args, { runHelper, measure: (pid) => Promise.resolve(measured({}, pid)), probeDirectory: () => ({ usable: true }), write: (l) => lines.push(l) }).then(
      () => undefined,
      (e: unknown) => e,
    )
    return { lines: lines.map((l) => JSON.parse(l) as Line), error }
  }

  it('reports the context checks, ctx-standard-user among them, then the helper\'s exit code and its exact stdout', async () => {
    let ran = 0
    const { lines, error } = await run(['--user', 'standard'], () => {
      ran++
      return Promise.resolve(okRun(PORTS_LINE))
    })
    expect(error).toBeUndefined()
    expect(ran).toBe(1)
    expect(lines.map((l) => [l.id, l.answer])).toEqual([
      ['ctx-no-console', 'yes'],
      ['ctx-job', 'no'],
      ['ctx-standard-user', 'yes'],
      [EXIT_ID, 'yes'],
      [OUTPUT_ID, 'yes'],
    ])
    expect(lines[3]?.data).toEqual({ ms: 12, exitCode: 0, context: { user: 'standard', console: 'none' } })
    expect(lines[4]?.data).toEqual({ bytes: PORTS_LINE.length, stdout: PORTS_LINE, context: { user: 'standard', console: 'none' } })
  })

  it('accepts only `--user standard [--unavailable <reason>]`, refusing extra arguments before running anything', async () => {
    for (const args of [['extra', '--user', 'standard'], ['--user', 'standard', 'C:\\Windows\\System32\\cmd.exe'], ['--user', 'admin'], ['--user', 'standard', '--helper', 'x'], []]) {
      let ran = false
      const { lines, error } = await run(args, () => {
        ran = true
        return Promise.resolve(okRun(PORTS_LINE))
      })
      expect(error, args.join(' ')).toBeInstanceOf(DriverUsageError)
      expect(lines, args.join(' ')).toEqual([])
      expect(ran, args.join(' ')).toBe(false)
    }
  })

  it('answers every line with the reason when the standard user is unavailable, without running the helper', async () => {
    const { lines, error } = await run(['--user', 'standard', '--unavailable', 'cannot create the account veydr-probe'], () => Promise.reject(new Error('ran')))
    expect(error).toBeUndefined()
    expect(lines.map((l) => l.id)).toEqual(['ctx-no-console', 'ctx-job', 'ctx-standard-user', EXIT_ID, OUTPUT_ID])
    for (const line of lines) {
      expect(line.answer, line.id).toBeNull()
      expect(line.data['unavailable'], line.id).toBe(true)
    }
  })

  it('stays out of the probe registries: its area and lines are its own, which a probe driver cannot report', async () => {
    expect(PROBE_AREAS).not.toContain(AREA)
    expect(CHECKS.filter((c) => (c.area as string) === AREA || c.id === EXIT_ID || c.id === OUTPUT_ID)).toEqual([])
    for (const file of ['scripts/windows-probe/checks.mjs', 'scripts/windows-probe/summary.mjs', '.github/workflows/windows-probe.yml', 'test/unit/workflow-policy.test.ts', 'test/unit/windows-probe-summary.test.ts']) {
      expect(readFileSync(join(root, file), 'utf8'), file).not.toMatch(/ports-standard-user|ports-std-helper/)
    }
    // runDriver looks the area up in the catalog it is given, so the probe catalog refuses it, and its catalog refuses the probe areas and the context area.
    const write = () => undefined
    const measure = () => Promise.reject(new Error('measured'))
    await expect(runDriver({ area: AREA, user: 'standard', ids: [EXIT_ID], probe: () => undefined, measure, write })).rejects.toThrow(DriverUsageError)
    await expect(runDriver({ area: 'ports', user: 'standard', ids: ['port-ps-std'], catalog: CATALOG, probe: () => undefined, measure, write })).rejects.toThrow(DriverUsageError)
    await expect(runDriver({ area: 'context', user: 'standard', ids: ['ctx-job'], catalog: { areas: ['context'], checks: CHECKS }, probe: () => undefined, measure, write })).rejects.toThrow(DriverUsageError)
  })

  it('answers from the helper\'s run: exit code, a single line, and why there is none', () => {
    expect(helperAnswers(okRun(PORTS_LINE))).toMatchObject({ exit: { answer: 'yes' }, output: { answer: 'yes', data: { stdout: PORTS_LINE } } })
    const failed = helperAnswers(okRun('', { code: 1, stderr: 'veydr-helper: GetExtendedTcpTable failed\r\n' }))
    expect(failed.exit).toEqual({ answer: 'no', detail: 'the helper exited with 1: veydr-helper: GetExtendedTcpTable failed', data: { ms: 12, exitCode: 1, stderr: 'veydr-helper: GetExtendedTcpTable failed' } })
    expect(failed.output).toMatchObject({ answer: 'no', detail: 'the helper printed nothing' })
    for (const stdout of ['{"a":1}', '{"a":1}\n{"b":2}\n', '\n', ' \n', '{"a":1}\n\n']) {
      expect(helperAnswers(okRun(stdout)).output, JSON.stringify(stdout)).toMatchObject({ answer: 'no', detail: 'the helper did not print exactly one line ending in a line feed', data: { stdout } })
    }
    expect(helperAnswers(okRun('', { stdout: Buffer.from([0x7b, 0xff, 0x0a]) })).output).toEqual({ answer: 'no', detail: 'the helper\'s stdout is not UTF-8', data: { bytes: 3 } })
    expect(helperAnswers(okRun('', { code: null, signal: 'SIGKILL' })).exit).toMatchObject({ answer: 'no', detail: 'the helper exited with SIGKILL', data: { exitCode: null, signal: 'SIGKILL' } })
    for (const [overrides, detail] of [
      [{ code: null, error: 'spawn C:\\veydr-probe-std\\scripts\\windows-probe\\veydr-helper.exe ENOENT' }, 'the helper did not start: spawn'],
      [{ code: null, signal: 'SIGTERM', stopped: 'timeout' }, `did not finish within ${HELPER_TIMEOUT_MS / 1000} s`],
      [{ code: null, signal: 'SIGTERM', stopped: 'output' }, `more than ${MAX_OUTPUT_BYTES} bytes`],
    ] as const) {
      const answers = helperAnswers(okRun('', overrides))
      expect(answers.exit.answer, detail).toBeNull()
      expect(answers.output.answer, detail).toBeNull()
      expect(answers.exit.detail, detail).toContain(detail)
    }
  })

  it('runs exactly `veydr-helper.exe ports` from its own directory, with stdin closed, and stops it at its time and output limits', async () => {
    expect(HELPER_PATH).toBe(join(root, 'scripts', 'windows-probe', 'veydr-helper.exe'))
    // The limit Veydr itself accepts for a listing.
    expect(MAX_OUTPUT_BYTES).toBe(MAX_PORTS_OUTPUT_BYTES)

    type Fake = EventEmitter & { stdout: PassThrough; stderr: PassThrough; killed: number; kill: () => boolean }
    const calls: { file: string; args: readonly string[]; options: SpawnOptions }[] = []
    const fake = (behave: (child: Fake) => void) => (file: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
      calls.push({ file, args, options })
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), killed: 0 }) as Fake
      child.kill = () => {
        child.killed++
        setImmediate(() => child.emit('close', null, 'SIGTERM'))
        return true
      }
      setImmediate(() => behave(child))
      return child as unknown as ChildProcess
    }
    const helper = join(tmpdir(), 'probe-dir', 'veydr-helper.exe')

    const ok = await runHelperPorts(helper, {
      spawnImpl: fake((child) => {
        child.stdout.write(PORTS_LINE)
        child.stderr.write('note')
        setImmediate(() => child.emit('close', 0, null))
      }),
    })
    expect(calls[0]).toEqual({ file: helper, args: ['ports'], options: { cwd: join(tmpdir(), 'probe-dir'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false } })
    expect(ok).toMatchObject({ code: 0, signal: null, stderr: 'note' })
    expect(ok.stdout.toString('utf8')).toBe(PORTS_LINE)
    expect(ok.stopped).toBeUndefined()

    let hung: Fake | undefined
    const timedOut = await runHelperPorts(helper, { timeoutMs: 20, spawnImpl: fake((child) => (hung = child)) })
    expect(timedOut).toMatchObject({ stopped: 'timeout', code: null })
    expect(hung?.killed).toBe(1)

    let flooding: Fake | undefined
    const flooded = await runHelperPorts(helper, {
      maxOutputBytes: 8,
      spawnImpl: fake((child) => {
        flooding = child
        child.stdout.write('12345')
        child.stdout.write('6789')
        child.stdout.write('more')
      }),
    })
    expect(flooded).toMatchObject({ stopped: 'output' })
    expect(flooded.stdout.toString('utf8')).toBe('12345')
    expect(flooding?.killed).toBe(1)

    const missing = await runHelperPorts(helper, { spawnImpl: fake((child) => child.emit('error', new Error('spawn ENOENT'))) })
    expect(missing).toMatchObject({ code: null, error: 'spawn ENOENT' })
    const throwing = await runHelperPorts(helper, {
      spawnImpl: () => {
        throw new Error('EACCES')
      },
    })
    expect(throwing).toMatchObject({ code: null, error: 'EACCES' })
  })
})

describe('standard-user.ps1 -Helper', () => {
  const text = readFileSync(join(root, 'scripts/windows-probe/standard-user.ps1'), 'utf8')
  const lines = text.split(/\r?\n/)
  const at = (needle: string): number => {
    const found = lines.filter((l) => l.includes(needle))
    expect(found, needle).toHaveLength(1)
    return lines.findIndex((l) => l.includes(needle))
  }

  it('is an optional parameter of the Run mode only, checked case-sensitively for its name, as a full path to a regular file', () => {
    expect(text).toContain("  [Parameter(ParameterSetName = 'Run')] [string] $Helper,\n")
    expect(text).toContain("$HelperName = 'veydr-helper.exe'\n")
    const check = text.slice(text.indexOf('function Get-HelperProblem('), text.indexOf('\n}\n', text.indexOf('function Get-HelperProblem(')))
    expect(check).toContain('[System.IO.Path]::GetFileName($Path) -cne $HelperName')
    expect(check).toContain('$full -cne $Path')
    expect(check).toContain('Test-Path -LiteralPath $Path -PathType Leaf')
    expect(check).toContain('[System.IO.FileAttributes]::ReparsePoint')
    // Every directory above the file too, up to the drive: a junction on the way is refused.
    expect(check).toContain('for ($directory = [System.IO.Path]::GetDirectoryName($Path); -not [string]::IsNullOrEmpty($directory); $directory = [System.IO.Path]::GetDirectoryName($directory))')
    expect(check).toContain('return "must not lead through a link, but $directory is one"')
    // No case-insensitive comparison of the name anywhere: -eq, -ne, -like and -match ignore case in PowerShell.
    expect(text).not.toMatch(/\$HelperName\b[^\n]*-(?:i?eq|i?ne|i?like|i?notlike|i?match|i?notmatch)\b/)
    expect(text).not.toMatch(/-(?:i?eq|i?ne|i?like|i?notlike)\s+\$HelperName\b/)
  })

  it('accepts as fully qualified only a path from a drive letter, so a relative, rooted, UNC or device path is refused', () => {
    const source = /\$Path -notmatch '([^']+)'/.exec(text)?.[1]
    expect(source).toBe('^[A-Za-z]:\\\\[^\\\\]')
    const pattern = new RegExp(source ?? '$^')
    expect(pattern.test('C:\\a\\out-helper\\veydr-helper.exe')).toBe(true)
    for (const path of ['veydr-helper.exe', 'out-helper\\veydr-helper.exe', '.\\veydr-helper.exe', '\\out-helper\\veydr-helper.exe', 'C:veydr-helper.exe', 'C:\\\\veydr-helper.exe', '\\\\server\\share\\veydr-helper.exe', '\\\\?\\C:\\veydr-helper.exe', '']) {
      expect(pattern.test(path), path).toBe(false)
    }
  })

  it('is checked with the other arguments, before the results file and before the account exists, and copied only into the account\'s directory', () => {
    const driverCheck = at("if ($Driver -notmatch '^[a-z0-9-]+\\.mjs$'")
    const helperCheck = at('$problem = Get-HelperProblem $Helper')
    const results = at('$resultsPath = [System.IO.Path]::GetFullPath(')
    const password = at('$password = New-ProbePassword')
    const account = at('$account = New-LocalUser')
    expect(driverCheck).toBeLessThan(helperCheck)
    expect(helperCheck).toBeLessThan(results)
    expect(results).toBeLessThan(password)
    expect(password).toBeLessThan(account)
    // A refused -Helper exits before anything else runs.
    expect(lines.slice(helperCheck, helperCheck + 4).join('\n')).toMatch(/\[Console\]::Error\.WriteLine\("standard-user\.ps1: -Helper \$problem, not '\$Helper'"\)\n\s+exit 1/)

    // $Helper is read only to be checked and hashed; what is copied is the checked value, and only next to the drivers.
    const uses = lines.map((l, i) => [i, l] as const).filter(([, l]) => /\$Helper\b/i.test(l))
    expect(uses.map(([i]) => i).every((i) => i < results)).toBe(true)
    // Hashed once accepted, before the account exists.
    const hashed = at('$helperHash = (Get-FileHash -LiteralPath $Helper -Algorithm SHA256).Hash')
    expect(helperCheck).toBeLessThan(hashed)
    expect(hashed).toBeLessThan(results)
    const copy = at('Copy-Item -LiteralPath $helperSource -Destination $helperCopy -Force')
    expect(copy).toBe(at('Copy-Item -LiteralPath $PSScriptRoot') + 4)
    expect(lines.slice(copy - 2, copy + 3).map((l) => l.trim())).toEqual([
      'if ($null -ne $helperSource) {',
      '$helperCopy = Join-Path $stdScripts $HelperName',
      'Copy-Item -LiteralPath $helperSource -Destination $helperCopy -Force',
      'if ((Get-FileHash -LiteralPath $helperCopy -Algorithm SHA256).Hash -cne $helperHash) { throw "$helperSource changed after it was checked" }',
      '}',
    ])
    expect(lines.filter((l) => /\$helperSource\b/.test(l)).map((l) => l.trim())).toEqual([
      '$helperSource = $null',
      '$helperSource = $Helper',
      'if ($null -ne $helperSource) {',
      'Copy-Item -LiteralPath $helperSource -Destination $helperCopy -Force',
      'if ((Get-FileHash -LiteralPath $helperCopy -Algorithm SHA256).Hash -cne $helperHash) { throw "$helperSource changed after it was checked" }',
    ])
  })

  // The checks run before the account exists, so they need no administrator; the Windows unit lane
  // runs them. The results file never exists, so a -Helper that passed would fail on it instead.
  it.skipIf(process.platform !== 'win32')('[windows-only: Windows PowerShell 5.1] refuses a -Helper that is not a fully qualified veydr-helper.exe, before anything else', { timeout: 180_000 }, () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'veydr-probe-helper-')))
    try {
      const good = join(dir, 'good')
      const upper = join(dir, 'upper')
      for (const sub of [good, upper, join(dir, 'folder', 'veydr-helper.exe')]) mkdirSync(sub, { recursive: true })
      writeFileSync(join(good, 'veydr-helper.exe'), '')
      // A junction (no administrator needed) whose target holds a valid helper.
      const junction = join(dir, 'junction')
      symlinkSync(good, junction, 'junction')
      writeFileSync(join(upper, 'VEYDR-HELPER.EXE'), '')
      writeFileSync(join(good, 'other.exe'), '')
      const powershell = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const script = join(root, 'scripts/windows-probe/standard-user.ps1')
      const missingResults = join(dir, 'no-such-results.jsonl')
      const launch = (helper: string) =>
        spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Results', missingResults, '-Timeout', '60', '-Driver', 'ports-standard-user.mjs', '-Helper', helper], {
          encoding: 'utf8',
          windowsHide: true,
          cwd: good,
          timeout: 60_000,
        })
      const refused: [string, string][] = [
        [join(good, 'other.exe'), 'must name a file called exactly veydr-helper.exe'],
        [join(upper, 'VEYDR-HELPER.EXE'), 'must name a file called exactly veydr-helper.exe'],
        ['veydr-helper.exe', 'must be a fully qualified path'],
        ['.\\veydr-helper.exe', 'must be a fully qualified path'],
        [`${good}\\..\\good\\veydr-helper.exe`, 'must be a fully qualified path'],
        [join(good, 'veydr-helper.exe').replace(/\\/g, '/'), 'must be a fully qualified path'],
        [join(dir, 'missing', 'veydr-helper.exe'), 'must name an existing file'],
        [join(dir, 'folder', 'veydr-helper.exe'), 'must name an existing file'],
        [join(junction, 'veydr-helper.exe'), `must not lead through a link, but ${junction} is one`],
      ]
      for (const [helper, message] of refused) {
        const run = launch(helper)
        expect(run.status, `${helper}: ${run.stdout}${run.stderr}`).toBe(1)
        expect(run.stderr, helper).toContain(`standard-user.ps1: -Helper ${message}`)
        expect(run.stdout, helper).not.toContain('::add-mask::')
      }
      // Accepted: the run goes on to the next check, the results file, and stops there.
      const accepted = launch(join(good, 'veydr-helper.exe'))
      expect(accepted.status).toBe(1)
      expect(accepted.stderr).not.toContain('-Helper')
      expect(accepted.stderr).toContain('does not exist; identity.mjs writes its first line')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
