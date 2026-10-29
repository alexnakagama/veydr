import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CHECKS, PROBE_AREAS } from '../../scripts/windows-probe/checks.mjs'
import { IdentityError, identityLine } from '../../scripts/windows-probe/identity.mjs'
import { type ContextMeasurement, contextIds } from '../../scripts/windows-probe/driver.mjs'
import { NOT_IMPLEMENTED, placeholderIds, placeholderUsers, runPlaceholder } from '../../scripts/windows-probe/placeholder.mjs'
import { NO_RESULT, formatSummary, parseResults, summarize } from '../../scripts/windows-probe/summary.mjs'

// What every job of windows-probe.yml runs before and instead of a probe (tasks 2.3, 3.1–3.2): the
// identity line that starts its results file (design D4), and the placeholder driver, which answers
// the context checks and nothing else for an area whose probe is not implemented yet.

const root = join(__dirname, '../..')
const env = { ImageOS: 'win25', ImageVersion: '20261020.1.0', NEGATIVE_CONTROL: 'false' }
const identity = (overrides: Partial<Parameters<typeof identityLine>[0]> = {}): string =>
  identityLine({ area: 'ports', env, windowsBuild: '10.0.26100.6899', node: 'v24.11.1', ...overrides })

/** The problems IdentityError lists for these inputs, or [] if the line is accepted. */
const identityProblems = (overrides: Partial<Parameters<typeof identityLine>[0]>): readonly string[] => {
  try {
    identity(overrides)
    return []
  } catch (error) {
    expect(error).toBeInstanceOf(IdentityError)
    return (error as IdentityError).problems
  }
}

describe('identityLine', () => {
  it('writes the identity line summary.mjs reads', () => {
    const line = identity()
    expect(line).not.toContain('\n')
    expect(parseResults(`${line}\n`, 'ports.jsonl')?.identity).toEqual({
      area: 'ports',
      imageOS: 'win25',
      imageVersion: '20261020.1.0',
      windowsBuild: '10.0.26100.6899',
      node: 'v24.11.1',
      negativeControl: false,
    })
    expect(parseResults(identity({ env: { ...env, NEGATIVE_CONTROL: 'true' } }), 'ports.jsonl')?.identity.negativeControl).toBe(true)
    for (const area of PROBE_AREAS) expect(parseResults(identity({ area }), `${area}.jsonl`)?.identity.area).toBe(area)
  })

  it('refuses an identity the summary would reject, listing every problem', () => {
    expect(identityProblems({ area: 'context' })).toEqual([expect.stringContaining('area must be one of')])
    expect(identityProblems({ env: { NEGATIVE_CONTROL: 'false' } })).toEqual([expect.stringContaining('ImageOS must be set'), expect.stringContaining('ImageVersion must be set')])
    expect(identityProblems({ env: { ...env, ImageVersion: '2026 1' } })).toEqual([expect.stringContaining('ImageVersion must be set, without spaces')])
    for (const flag of [undefined, '', 'yes', 'TRUE', '1']) {
      expect(identityProblems({ env: { ...env, NEGATIVE_CONTROL: flag } }), String(flag)).toEqual([expect.stringContaining('NEGATIVE_CONTROL must be "true" or "false"')])
    }
    // PowerShell prints an empty UBR as a trailing dot when the registry value is missing.
    for (const build of ['', '10.0.26100', '10.0.26100.', '10.0.26100.0\r\n1']) {
      expect(identityProblems({ windowsBuild: build }), build).toEqual([expect.stringContaining('Windows build must be four numbers')])
    }
    expect(identityProblems({ node: '' })).toEqual([expect.stringContaining('Node version')])
    expect(identityProblems({ area: 'x', env: {}, windowsBuild: '', node: '' })).toHaveLength(6)
  })
})

/** What context.ps1 measures for a driver started by the launcher: no console, inside the runner's job. */
const consoleLess = (pid: number): ContextMeasurement => ({
  targetPid: pid,
  parentPid: pid,
  console: { attached: false, lastError: 6, window: 0 },
  job: { driverInJob: true, helperInJob: true, limitFlags: 0x2000, limitsError: null },
  token: { user: 'RUNNER\\veydr-probe', elevated: false, elevationType: 'default', administrators: 'absent' },
  hkcu: { environment: 'present', environmentValues: 2 },
  helper: 'detached',
})

/** The result lines the placeholder driver writes for `args`, measured by `measure`. */
const placeholderRun = async (args: string[], measure: (pid: number) => Promise<ContextMeasurement> = (pid) => Promise.resolve(consoleLess(pid))): Promise<string[]> => {
  const lines: string[] = []
  await runPlaceholder(args, { measure, probeDirectory: () => ({ usable: true }), write: (line) => lines.push(line) })
  return lines
}

/** Every area's results file, as a probe run writes it: the identity, then each account's driver. */
const runFiles = async (driverArgs: (area: string, user: string) => string[] = (area, user) => [area, '--user', user], measure?: (area: string, user: string) => (pid: number) => Promise<ContextMeasurement>, negativeControl = 'false') =>
  Promise.all(
    PROBE_AREAS.map(async (area) => {
      const lines = [identity({ area, env: { ...env, NEGATIVE_CONTROL: negativeControl } })]
      for (const user of placeholderUsers(area)) lines.push(...(await placeholderRun(driverArgs(area, user), measure?.(area, user))))
      return parseResults(lines.join('\n'), `${area}.jsonl`)
    }),
  )

/** The areas' own controls, answered with null by the placeholder, by area and account as the summary names them. */
const placeholderControls = [
  ['ports as admin', 'port-control'],
  ['ports as standard', 'port-control-std'],
  ['process-tree as admin', 'pt-control'],
  ['process-tree as standard', 'pt-control-std'],
] as const

const summarizeRun = (results: Awaited<ReturnType<typeof runFiles>>) =>
  summarize({ results, commit: 'a'.repeat(40), runId: '1', checksHash: 'b'.repeat(64), date: '2026-10-29T00:00:00.000Z' })

describe('placeholder driver', () => {
  it('answers the area\'s own checks for each account, after the context checks', async () => {
    for (const area of PROBE_AREAS) {
      for (const user of placeholderUsers(area)) {
        const lines = (await placeholderRun([area, '--user', user])).map((l) => JSON.parse(l) as { id: string; answer: unknown; detail: string; data: Record<string, unknown> })
        expect(lines.map((l) => l.id), `${area} ${user}`).toEqual([...contextIds(user), ...placeholderIds(area, user)])
        for (const line of lines.slice(contextIds(user).length)) {
          expect(line.answer, line.id).toBeNull()
          expect(line.detail, line.id).toBe(NOT_IMPLEMENTED)
          expect(line.data, line.id).toEqual({ placeholder: true, context: { user, console: 'none' } })
        }
      }
    }
    // The areas with -std checks run a standard-user driver too (design D9), and only those.
    expect(PROBE_AREAS.filter((area) => placeholderUsers(area).includes('standard'))).toEqual(['process-tree', 'helper', 'environment', 'ports'])
    expect(PROBE_AREAS.every((area) => placeholderUsers(area).includes('admin'))).toBe(true)
    expect(() => placeholderIds('context', 'admin')).toThrow('area must be one of')
    await expect(placeholderRun(['commands', '--user', 'standard'])).rejects.toThrow('has no checks that run as standard')
    await expect(placeholderRun(['--user', 'admin'])).rejects.toThrow('expected one area')
  })

  it('gives a normal run ctx-no-console PASS, ctx-job with the membership, and every other check a NOT-TESTABLE line', async () => {
    const summary = summarizeRun(await runFiles())
    expect(summary.lines.map((l) => l.id).sort()).toEqual(CHECKS.map((c) => c.id).sort())
    // Only the areas' own controls, which the placeholder does not answer, invalidate anything.
    expect(summary.invalid).toEqual(placeholderControls.map(([where, control]) => ({ where, reasons: [`control ${control} answered nothing`] })))
    expect(summary.lines.filter((l) => l.detail === NO_RESULT)).toEqual([])
    const status = Object.fromEntries(summary.lines.map((l) => [l.id, l]))
    expect(status['ctx-no-console']?.status).toBe('PASS')
    expect(status['ctx-standard-user']?.status).toBe('PASS')
    // Predicted no: the runner's steps run inside a job; the line names each driver's answer.
    expect(status['ctx-job']?.status).toBe('EXPECTED-FAIL')
    expect(status['ctx-job']?.detail).toContain('ports/standard: EXPECTED-FAIL the driver is inside a Job Object, with limits KILL_ON_JOB_CLOSE')
    for (const line of summary.lines.filter((l) => !l.id.startsWith('ctx-') && CHECKS.find((c) => c.id === l.id)?.kind === 'check')) {
      expect(line.status, line.id).toBe('NOT-TESTABLE')
      expect(line.detail, line.id).toContain(NOT_IMPLEMENTED)
      expect(line.detail, line.id).not.toContain('ctx-')
    }
    expect(summary.negativeControl).toBe(false)
  })

  it('turns the negative-control driver\'s area into NOT-TESTABLE naming the control, and marks the run', async () => {
    const attached = (pid: number): Promise<ContextMeasurement> => Promise.resolve({ ...consoleLess(pid), console: { attached: true, lastError: 0, window: 0x40a2c } })
    const results = await runFiles(undefined, (area, user) => (area === 'process-tree' && user === 'admin' ? attached : (pid) => Promise.resolve(consoleLess(pid))), 'true')
    const summary = summarizeRun(results)
    expect(summary.negativeControl).toBe(true)
    expect(summary.invalid).toEqual(
      placeholderControls.map(([where, control]) => ({
        where,
        reasons: where === 'process-tree as admin' ? ['control ctx-no-console answered no', `control ${control} answered nothing`] : [`control ${control} answered nothing`],
      })),
    )
    const status = Object.fromEntries(summary.lines.map((l) => [l.id, l]))
    expect(status['ctx-no-console']?.status).toBe('FAIL')
    expect(status['ctx-no-console']?.detail).toContain('process-tree/admin: FAIL the driver has a console')
    expect(status['pt-control']?.status).toBe('NOT-TESTABLE')
    expect(status['pt-control']?.detail).toContain('control ctx-no-console answered no in process-tree as admin')
    // The standard-user driver of the same area, and the other areas, were started without a console.
    expect(status['pt-control-std']?.detail).toBe(NOT_IMPLEMENTED)
    expect(status['port-control']?.detail).toBe(NOT_IMPLEMENTED)
    expect(status['cmd-pathext']?.detail).toBe(NOT_IMPLEMENTED)
    expect(formatSummary(summary)).toContain('# negative-control true\n')
  })

  it('makes every -std check NOT-TESTABLE with the error when the standard user is unavailable', async () => {
    const error = 'cannot start the Secondary Logon service (seclogon): Service is disabled'
    const summary = summarizeRun(await runFiles((area, user) => [area, '--user', user, ...(user === 'standard' ? ['--unavailable', error] : [])]))
    expect(summary.lines.filter((l) => l.detail === NO_RESULT)).toEqual([])
    for (const id of CHECKS.filter((c) => c.kind === 'check' && c.context.user === 'standard').map((c) => c.id)) {
      const line = summary.lines.find((l) => l.id === id)
      expect(line?.status, id).toBe('NOT-TESTABLE')
      expect(line?.detail, id).toContain(error)
    }
    expect(summary.lines.find((l) => l.id === 'ctx-standard-user')?.detail).toContain(`the standard user could not be used: ${error}`)
    for (const where of ['environment as standard', 'helper as standard', 'ports as standard', 'process-tree as standard']) {
      expect(summary.invalid.find((i) => i.where === where)?.reasons, where).toContain('control ctx-no-console answered nothing')
    }
  })
})

describe('command-line scripts', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'veydr-probe-jobs-'))
    dirs.push(dir)
    return dir
  }
  /**
   * Runs a script with `extra` replacing the test's variables of the same name; an `undefined` entry
   * removes the variable. Names are matched without case, as Windows does: the runner may hold
   * `ImageOS` under another spelling, which an exact `delete` would leave in place.
   */
  const node = (script: string, args: string[], extra: Record<string, string | undefined> = {}) => {
    const replaced = new Set(Object.keys(extra).map((name) => name.toUpperCase()))
    const childEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !replaced.has(name.toUpperCase())))
    for (const [name, value] of Object.entries(extra)) if (value !== undefined) childEnv[name] = value
    return spawnSync(process.execPath, [join(root, 'scripts/windows-probe', script), ...args], { encoding: 'utf8', env: childEnv })
  }

  it('identity.mjs refuses a missing identity before asking Windows, and writes nothing', () => {
    const out = join(tempDir(), 'results', 'ports.jsonl')
    const run = node('identity.mjs', ['ports', out], { ImageOS: undefined, ImageVersion: undefined, NEGATIVE_CONTROL: 'maybe' })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('ImageOS must be set')
    expect(run.stderr).toContain('NEGATIVE_CONTROL must be "true" or "false"')
    expect(existsSync(out)).toBe(false)
    expect(node('identity.mjs', ['nowhere', out], env).stderr).toContain('area must be one of')
    expect(node('identity.mjs', ['ports'], env).status).toBe(2)
    expect(node('identity.mjs', ['ports', out, 'extra'], env).status).toBe(2)
  })

  // Task 3.2: the standard user's passwords meet Windows Server's default complexity rules. The script
  // checks each generated password character by character, separately from the generator's own
  // check, and prints only counts. Needs no administrator, so the Windows CI lane runs it.
  it.skipIf(process.platform !== 'win32')('[windows-only: Windows PowerShell 5.1] standard-user.ps1 generates 1,000 distinct passwords that meet the complexity rules', { timeout: 300_000 }, () => {
    const powershell = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const script = join(root, 'scripts/windows-probe/standard-user.ps1')
    const run = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-CheckPasswords', '1000'], { encoding: 'utf8', windowsHide: true })
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0)
    expect(run.stdout).toContain(
      '1000 passwords, each 32 characters with an upper-case letter, a lower-case letter, a digit and a symbol, none containing the account name, all distinct',
    )
  })

  // With --unavailable the driver measures nothing, so this runs the same everywhere; the measured
  // path is covered above with context.ps1's output as data, and in the windows-probe workflow.
  it('placeholder.mjs writes its result lines to stdout, context checks first', () => {
    const run = node('placeholder.mjs', ['ports', '--user', 'standard', '--unavailable', 'no account'])
    expect(run.status, run.stderr).toBe(0)
    const lines = run.stdout.trimEnd().split('\n').map((l) => JSON.parse(l) as { id: string; answer: unknown; detail: string; data: { context: unknown } })
    expect(lines.map((l) => l.id)).toEqual([...contextIds('standard'), ...placeholderIds('ports', 'standard')])
    for (const line of lines) {
      expect(line.answer, line.id).toBeNull()
      expect(line.detail, line.id).toBe('the standard user could not be used: no account')
      expect(line.data.context, line.id).toEqual({ user: 'standard', console: 'none' })
    }

    for (const args of [['ports'], ['nowhere', '--user', 'admin'], ['ports', '--user', 'root'], ['ports', 'helper', '--user', 'admin'], ['commands', '--user', 'standard']]) {
      const usage = node('placeholder.mjs', args)
      expect(usage.status, args.join(' ')).toBe(2)
      expect(usage.stdout, args.join(' ')).toBe('')
    }
  })
})
