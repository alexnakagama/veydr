import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CHECKS } from '../../scripts/windows-probe/checks.mjs'
import {
  type ContextMeasurement,
  type ProbeDirectory,
  DriverUsageError,
  checkProbeDirectory,
  contextAnswers,
  contextIds,
  jobLimitNames,
  parseDriverArgs,
  runDriver,
} from '../../scripts/windows-probe/driver.mjs'
import { LaunchUsageError, isResultLine, launch, parseLaunchArgs } from '../../scripts/windows-probe/launch-detached.mjs'

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

  it('records an attached fallback and why the detached run failed', () => {
    const line = answers('admin', measured({ helper: 'attached', detachedError: 'context.ps1 exited with 1' }))['ctx-no-console']
    expect(line?.data).toMatchObject({ contextHelper: 'attached', contextHelperDetachedError: 'context.ps1 exited with 1' })
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
