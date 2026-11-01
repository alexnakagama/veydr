import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ENCODING_TEST_STRING, VERBATIM_REFUSED_CASES } from '../../scripts/windows-probe/checks.mjs'
import { CORPUS } from '../../scripts/windows-probe/cmd-corpus.mjs'
import { RECORD_FILE, SHIM_LINE, directSpawnAnswer, pathextAnswer, pathextCwdAnswer, previewArgs, refusalAnswer, routeAnswer, runCommands, stderrWithoutEnvironment, withoutEnvironment } from '../../scripts/windows-probe/commands.mjs'
import { type ContextMeasurement, type ProgramResult, contextIds, reportCheck, runProgram, windowsPowerShell } from '../../scripts/windows-probe/driver.mjs'
import { asciiLiteral, codePagesAnswer, encodingAnswer, encodingCommand, parseCodePages, runEncoding } from '../../scripts/windows-probe/encoding.mjs'
import { compareEnvironment, parseSeen, pathCaseAnswer, registryAnswer, registryEnvironment, registryResult, runEnvironment, seenForData, withoutPath } from '../../scripts/windows-probe/environment.mjs'
import { placeholderIds } from '../../scripts/windows-probe/placeholder.mjs'

// The parts of the command, environment and encoding probes that can be checked anywhere: how
// measurements become answers, and how each driver is wired. What Windows does is measured by the
// windows-probe workflow; the Windows CI lane runs the PowerShell and the shim below.

const root = join(__dirname, '../..')
const probeDir = join(root, 'scripts/windows-probe')
const ran = (overrides: Partial<ProgramResult> = {}): ProgramResult => ({ code: 0, signal: null, stdout: '', stderr: '', ...overrides })
const notStarted = ran({ code: null, error: 'spawn cmd.exe ENOENT' })
const timedOut = ran({ code: null, signal: 'SIGTERM' })

let dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'veydr-probe-test-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  dirs = []
})

describe('command answers', () => {
  it('wants the refusal to be EINVAL', () => {
    expect(directSpawnAnswer({ code: 'EINVAL' }).answer).toBe('yes')
    expect(directSpawnAnswer({ code: 'EACCES' })).toEqual({ answer: 'no', detail: 'the spawn failed with EACCES, not EINVAL' })
    expect(directSpawnAnswer({ started: true }).answer).toBe('no')
  })

  it('answers yes only for the intended arguments and no sentinel', () => {
    const intended = ['a b', '']
    expect(routeAnswer({ intended, recorded: ['a b', ''], sentinel: false, run: ran() })).toEqual({ answer: 'yes', detail: '' })
    // A non-zero exit says nothing: an injected command that failed leaves one behind a good shim.
    expect(routeAnswer({ intended, recorded: ['a b', ''], sentinel: false, run: ran({ code: 1 }) }).answer).toBe('yes')
    expect(routeAnswer({ intended, recorded: ['a', 'b'], sentinel: false, run: ran() })).toEqual({ answer: 'no', detail: 'received ["a","b"] instead of ["a b",""]' })
    // Not a join in disguise: the same text split differently is another result.
    expect(routeAnswer({ intended: ['ab'], recorded: ['a', 'b'], sentinel: false, run: ran() }).answer).toBe('no')
    expect(routeAnswer({ intended, recorded: ['a b', ''], sentinel: true, run: ran() })).toEqual({ answer: 'no', detail: 'an injected command created the sentinel' })
    expect(routeAnswer({ intended, recorded: ['x'], sentinel: true, run: ran() }).detail).toContain('; an injected command created the sentinel')
    expect(routeAnswer({ intended, recorded: undefined, sentinel: false, run: ran({ code: 1 }) })).toEqual({ answer: 'no', detail: 'record.mjs wrote nothing (cmd.exe exited with 1)' })
  })

  it('gives no answer for a command that did not start or finish', () => {
    expect(routeAnswer({ intended: [], recorded: undefined, sentinel: false, run: notStarted })).toEqual({ answer: null, detail: 'the command did not start: spawn cmd.exe ENOENT' })
    expect(routeAnswer({ intended: [], recorded: undefined, sentinel: true, run: timedOut })).toEqual({ answer: null, detail: 'the command did not finish within 60 s' })
    expect(pathextCwdAnswer({ sentinel: false, run: timedOut }).answer).toBeNull()
    expect(pathextAnswer({ pathext: '.CMD', where: notStarted, run: ran() }).answer).toBeNull()
    expect(pathextAnswer({ pathext: '.CMD', where: ran(), run: timedOut }).answer).toBeNull()
  })

  it('keeps long arguments out of the result lines, stating their length', () => {
    expect(previewArgs(['short', 'x'.repeat(256)])).toEqual(['short', 'x'.repeat(256)])
    expect(previewArgs(['x'.repeat(4000)])).toEqual([`${'x'.repeat(256)}… (4000 characters)`])
    const { detail } = routeAnswer({ intended: ['a&'.repeat(2000)], recorded: ['a'], sentinel: false, run: ran() })
    expect(detail.length).toBeLessThan(400)
  })

  it('answers yes for a refusal only where the check asks for one', () => {
    expect([...VERBATIM_REFUSED_CASES].sort()).toEqual(['carriage-return', 'long', 'newline'])
    for (const id of VERBATIM_REFUSED_CASES) expect(CORPUS.map((c) => c.id), id).toContain(id)
    expect(refusalAnswer({ expected: true, reason: 'too long', shim: 'C:\\t\\fwd.cmd' })).toEqual({ answer: 'yes', detail: '' })
    // A temp path with a % makes cmd-quote.mjs refuse every case: that must not read as PASS.
    expect(refusalAnswer({ expected: false, reason: 'cannot quote', shim: 'C:\\100%\\fwd.cmd' })).toEqual({ answer: null, detail: 'unexpected refusal with the shim at C:\\100%\\fwd.cmd: cannot quote' })
  })

  it('keeps variable values out of what a case recorded, showing that it was expanded', () => {
    const env = { PATH: 'C:\\Program Files\\nodejs;C:\\Windows\\system32', SHORT: 'abc', UNSET: undefined }
    const shown = (recorded: string[], intended: string[] = []) => withoutEnvironment(recorded, intended, env)
    expect(shown([env.PATH])).toEqual([`(${env.PATH.length} characters from the environment)`])
    // Unquoted, an expansion splits at the space; %PATH:\=/% changes the backslashes.
    expect(shown(['C:\\Program', 'Files\\nodejs;C:\\Windows\\system32'])).toEqual(['(10 characters from the environment)', '(32 characters from the environment)'])
    expect(shown(['C:/Program Files/nodejs;C:/Windows/system32'])).toEqual(['(43 characters from the environment)'])
    expect(shown([`x${env.PATH}y`])).toEqual([`(${env.PATH.length + 2} characters from the environment)`])
    // What the case intended, and short text that happens to match, stay as they are.
    expect(shown(['system32'], ['system32'])).toEqual(['system32'])
    expect(shown(['%PATH%', 'abc', 'nodejs'])).toEqual(['%PATH%', 'abc', 'nodejs'])
    expect(stderrWithoutEnvironment(`'C:\\Windows\\system32' is not\r\nrecognized`, env)).toBe('(from the environment) is not recognized')
    const { detail } = routeAnswer({ intended: ['%PATH%'], recorded: [env.PATH], shown: shown([env.PATH]), sentinel: false, run: ran() })
    expect(detail).not.toContain('nodejs')
    expect(detail).toContain('characters from the environment')
  })

  it('takes the first match with a PATHEXT extension as what cmd.exe starts', () => {
    const where = ran({ stdout: 'C:\\node\\npm\r\nC:\\node\\npm.cmd\r\nC:\\node\\npm.ps1\r\n' })
    const version = ran({ stdout: '11.6.2\r\n' })
    expect(pathextAnswer({ pathext: '.COM;.EXE;.BAT;.CMD', where, run: version })).toEqual({ answer: 'yes', detail: '' })
    expect(pathextAnswer({ pathext: '.com;.cmd;', where: ran({ stdout: 'C:\\node\\NPM.CMD\r\n' }), run: version }).answer).toBe('yes')
    expect(pathextAnswer({ pathext: '.EXE;.CMD', where: ran({ stdout: 'C:\\a\\npm.exe\r\nC:\\node\\npm.cmd\r\n' }), run: version })).toEqual({ answer: 'no', detail: 'npm resolves to C:\\a\\npm.exe' })
    expect(pathextAnswer({ pathext: '.EXE', where, run: version }).detail).toContain('no match for npm has a PATHEXT extension')
    expect(pathextAnswer({ pathext: '.CMD', where, run: ran({ code: 1, stdout: 'oops' }) }).detail).toBe('npm --version through cmd.exe exited with 1, printing "oops"')
    expect(pathextAnswer({ pathext: undefined, where, run: version })).toEqual({ answer: null, detail: 'PATHEXT is not set' })
  })

  it('reads the decoy\'s sentinel', () => {
    expect(pathextCwdAnswer({ sentinel: false, run: ran({ stdout: '11.6.2\r\n' }) }).answer).toBe('yes')
    expect(pathextCwdAnswer({ sentinel: true, run: ran() })).toEqual({ answer: 'no', detail: 'cmd.exe ran the npm.cmd decoy from the working directory' })
    // A missing sentinel means nothing if npm did not run at all.
    expect(pathextCwdAnswer({ sentinel: false, run: ran({ code: 1 }) })).toEqual({ answer: null, detail: 'neither the decoy nor npm ran: cmd.exe exited with 1, printing ""' })
  })

  it('has record.mjs write the arguments where commands.mjs reads them', () => {
    const dir = tempDir()
    const run = spawnSync(process.execPath, [join(probeDir, 'record.mjs'), 'a b', '', '--flag', 'grüße'], { cwd: dir, encoding: 'utf8' })
    expect(run.status).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, RECORD_FILE), 'utf8'))).toEqual(['a b', '', '--flag', 'grüße'])
  })

  it('uses the shim of design D3', () => {
    expect(SHIM_LINE).toBe('@node "%~dp0record.mjs" %*')
  })

  it.skipIf(process.platform !== 'win32')('[windows-only: cmd.exe] the shim hands an argument to record.mjs', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'fwd.cmd'), `${SHIM_LINE}\r\n`)
    copyFileSync(join(probeDir, 'record.mjs'), join(dir, 'record.mjs'))
    const run = spawnSync(`"${join(dir, 'fwd.cmd')}"`, ['hello'], { cwd: dir, shell: true, encoding: 'utf8', windowsHide: true })
    expect(run.status).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, RECORD_FILE), 'utf8'))).toEqual(['hello'])
  })
})

describe('environment answers', () => {
  const secret = 'do-not-record-me'

  it('merges user over machine, and Path as the machine value then the user value', () => {
    const merged = registryEnvironment({ Path: 'C:\\m', TEMP: 'C:\\t', OS: 'Windows_NT' }, { PATH: 'C:\\u', temp: 'C:\\ut', ONLY: 'x' })
    expect(Object.fromEntries(merged)).toEqual({
      PATH: { name: 'Path', value: 'C:\\m;C:\\u' },
      TEMP: { name: 'temp', value: 'C:\\ut' },
      OS: { name: 'OS', value: 'Windows_NT' },
      ONLY: { name: 'ONLY', value: 'x' },
    })
    expect(registryEnvironment({ Path: 'C:\\m;' }, { Path: 'C:\\u' }).get('PATH')?.value).toBe('C:\\m;C:\\u')
    expect(registryEnvironment({}, { Path: 'C:\\u' }).get('PATH')?.value).toBe('C:\\u')
    expect(registryEnvironment({ Path: 'C:\\m' }, {}).get('PATH')?.value).toBe('C:\\m')
  })

  it('compares without case in the names, and with case in the values, recording names only', () => {
    const registry = registryEnvironment({ Path: 'C:\\a', SAME: 'x', CASE: 'value', MISSING: secret }, {})
    const comparison = compareEnvironment(registry, { PATH: 'C:\\b', same: 'x', CASE: 'VALUE', EXTRA: secret, '=C:': 'C:\\', UNSET: undefined })
    expect(comparison).toEqual({ compared: 3, different: ['CASE', 'PATH'], onlyInRegistry: ['MISSING'], onlyInherited: ['EXTRA'] })
    expect(JSON.stringify(comparison)).not.toContain(secret)
    expect(JSON.stringify(registryAnswer(comparison))).not.toContain(secret)
  })

  it('answers no on a difference, and null on nothing to compare', () => {
    expect(registryAnswer({ compared: 2, different: [] }).answer).toBe('yes')
    expect(registryAnswer({ compared: 2, different: ['A', 'B'] })).toEqual({ answer: 'no', detail: 'different values for A, B' })
    expect(registryAnswer({ compared: 0, different: [] }).answer).toBeNull()
  })

  it('reads the registry script\'s result, or says why there is none', () => {
    const good = '{"machine":{"A":"1"},"user":{}}'
    expect(registryResult({ fileText: good, run: ran() })).toEqual({ machine: { A: '1' }, user: {} })
    expect(registryResult({ fileText: `\uFEFF${good}`, run: ran() })).toEqual({ machine: { A: '1' }, user: {} })
    expect(registryResult({ fileText: undefined, run: ran({ code: 1, stderr: 'x\ny' }) })).toEqual({ error: 'registry-env.ps1 exited with 1 and wrote no result file: x y' })
    expect(registryResult({ fileText: undefined, run: notStarted })).toEqual({ error: 'registry-env.ps1 spawn cmd.exe ENOENT and wrote no result file: ' })
    expect(registryResult({ fileText: 'nope', run: ran() })).toEqual({ error: 'registry-env.ps1 exited with 0 and its result file is not JSON' })
    expect(registryResult({ fileText: '{"error":"denied"}', run: ran({ code: 1 }) })).toEqual({ error: 'denied' })
    expect(registryResult({ fileText: good, run: ran({ code: 1 }) })).toHaveProperty('error')
    expect(registryResult({ fileText: '{"machine":{"A":1},"user":{}}', run: ran() })).toHaveProperty('error')
    expect(registryResult({ fileText: '{"machine":[],"user":{}}', run: ran() })).toHaveProperty('error')
    expect(registryResult({ fileText: 'null', run: ran() })).toHaveProperty('error')
  })

  it('removes a path variable under any spelling', () => {
    expect(withoutPath({ Path: 'a', PATH: 'b', path: 'c', OTHER: 'd' })).toEqual({ OTHER: 'd' })
  })

  it('wants exactly one path variable, holding the marker', () => {
    const marker = 'C:\\marker'
    expect(pathCaseAnswer({ seen: [['PATH', marker]], marker }).answer).toBe('yes')
    expect(pathCaseAnswer({ seen: [['Path', marker]], marker }).answer).toBe('yes')
    expect(pathCaseAnswer({ seen: [['Path', 'a'], ['PATH', marker]], marker })).toEqual({ answer: 'no', detail: 'the child sees 2 path variables: Path, PATH' })
    expect(pathCaseAnswer({ seen: [], marker }).answer).toBe('no')
    const other = pathCaseAnswer({ seen: [['PATH', secret]], marker })
    expect(other).toEqual({ answer: 'no', detail: 'the child\'s PATH does not hold the marker' })
    expect(pathCaseAnswer({ seen: undefined, marker }).answer).toBeNull()
  })

  it('parses what the child printed, and shows only markers', () => {
    expect(parseSeen('[["PATH","x"]]\r\n')).toEqual([['PATH', 'x']])
    for (const bad of ['', 'nope', '{}', '[["PATH"]]', '[["PATH",1]]']) expect(parseSeen(bad), bad).toBeUndefined()
    expect(seenForData([['PATH', 'm'], ['Path', secret]], ['m'])).toEqual([{ name: 'PATH', value: 'm' }, { name: 'Path', value: '(not a marker)' }])
  })

  it('has a child report what the driver passes it', () => {
    const seen = spawnSync(process.execPath, ['-e', "console.log(JSON.stringify(Object.entries(process.env).filter(([name]) => name.toUpperCase() === 'VEYDR_X')))"], { encoding: 'utf8', env: { ...process.env, VEYDR_X: 'v' } })
    expect(parseSeen(seen.stdout)).toEqual([['VEYDR_X', 'v']])
  })

  it.skipIf(process.platform !== 'win32')('[windows-only: Windows PowerShell 5.1] registry-env.ps1 reads the machine environment', { timeout: 120_000 }, () => {
    const outFile = join(tempDir(), 'registry.json')
    const run = spawnSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(probeDir, 'registry-env.ps1'), '-OutFile', outFile], { encoding: 'utf8', windowsHide: true })
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    const result = registryResult({ fileText: readFileSync(outFile, 'utf8'), run: ran() })
    expect(result).toHaveProperty('machine.OS', 'Windows_NT')
    expect(result).toHaveProperty('user')
  })
})

describe('encoding answers', () => {
  const env = { PATH: 'p', PYTHONUTF8: '0', pythonioencoding: 'latin-1', OTHER: 'x' }
  const command = (tool: string, variant: string) => encodingCommand(tool, variant, { text: 'ü', node: 'C:\\node dir\\node.exe', cmd: 'C:\\cmd.exe', env })

  it('writes the test string in ASCII', () => {
    expect(asciiLiteral('Gü ✓')).toBe("'G\\u00fc \\u2713'")
    const printed = spawnSync(process.execPath, ['-e', `process.stdout.write(${asciiLiteral(ENCODING_TEST_STRING)})`], { encoding: 'utf8' })
    expect(printed.stdout).toBe(ENCODING_TEST_STRING)
  })

  it('builds each tool\'s command, with chcp only in the utf8 variant', () => {
    expect(command('cmd', 'plain')).toEqual({ file: 'C:\\cmd.exe', args: ['/d', '/s', '/c', '"echo ü"'], options: { windowsVerbatimArguments: true } })
    expect(command('cmd', 'utf8').args.at(-1)).toBe('"chcp 65001>nul & echo ü"')
    expect(command('node', 'plain')).toEqual({ file: 'C:\\node dir\\node.exe', args: ['-e', "process.stdout.write('\\u00fc')"], options: {} })
    expect(command('node', 'utf8').args.at(-1)).toBe(`"chcp 65001>nul & "C:\\node dir\\node.exe" -e "process.stdout.write('\\u00fc')""`)
    expect(() => command('perl', 'plain')).toThrow('does not know how to run perl')
  })

  it('takes Python\'s encoding from the variant, not from the environment', () => {
    const plain = command('python', 'plain')
    const utf8 = command('python', 'utf8')
    expect(plain.args).toEqual(['-c', "print('\\u00fc')"])
    expect(plain.options.env).toEqual({ PATH: 'p', OTHER: 'x' })
    expect(utf8.options.env).toEqual({ PATH: 'p', OTHER: 'x', PYTHONUTF8: '1' })
  })

  it('wants valid UTF-8 that decodes to exactly the string', () => {
    const expected = 'Grüße ✓'
    const utf8 = Buffer.from(expected, 'utf8')
    expect(encodingAnswer({ run: ran(), bytes: utf8, expected })).toEqual({ answer: 'yes', detail: '' })
    for (const ending of ['\n', '\r\n']) expect(encodingAnswer({ run: ran(), bytes: Buffer.from(`${expected}${ending}`), expected }).answer, JSON.stringify(ending)).toBe('yes')
    expect(encodingAnswer({ run: ran(), bytes: Buffer.from(`${expected}\n\n`), expected }).answer).toBe('no')
    expect(encodingAnswer({ run: ran(), bytes: Buffer.from(`\uFEFF${expected}`), expected }).answer).toBe('no')
    expect(encodingAnswer({ run: ran(), bytes: Buffer.from('Grüße', 'latin1'), expected })).toEqual({ answer: 'no', detail: 'the output is not valid UTF-8' })
    expect(encodingAnswer({ run: ran(), bytes: Buffer.from('Gr?', 'latin1'), expected })).toEqual({ answer: 'no', detail: 'the output decodes to "Gr?"' })
    expect(encodingAnswer({ run: ran({ code: 1 }), bytes: Buffer.alloc(0), expected })).toEqual({ answer: 'no', detail: 'the output decodes to "" (it exited with 1)' })
    expect(encodingAnswer({ run: notStarted, bytes: Buffer.alloc(0), expected }).answer).toBeNull()
    expect(encodingAnswer({ run: timedOut, bytes: Buffer.alloc(0), expected })).toEqual({ answer: null, detail: 'the command did not finish within 30 s' })
  })

  it('keeps the bytes through runProgram\'s Latin-1', () => {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
    expect(Buffer.from(bytes.toString('latin1'), 'latin1').equals(bytes)).toBe(true)
  })

  it('reads the code pages', () => {
    const pages = { acp: 1252, oemcp: 437, consoleOutputCP: 437 }
    expect(parseCodePages(`${JSON.stringify(pages)}\r\n`)).toEqual(pages)
    for (const bad of ['', 'nope', '{"acp":1252}', '{"acp":"1252","oemcp":437,"consoleOutputCP":437}']) expect(parseCodePages(bad), bad).toBeUndefined()
    expect(codePagesAnswer({ hidden: { ...pages, consoleOutputCP: 65001 }, run: ran() })).toEqual({ answer: 'yes', detail: '' })
    expect(codePagesAnswer({ hidden: pages, run: ran() })).toEqual({ answer: 'no', detail: 'the console output code page is 437' })
    expect(codePagesAnswer({ hidden: { ...pages, consoleOutputCP: 0 }, run: ran() }).answer).toBeNull()
    expect(codePagesAnswer({ hidden: undefined, run: ran({ code: 1, stderr: 'boom' }) })).toEqual({ answer: null, detail: 'codepages.ps1 exited with 1 with no report: boom' })
  })

  it.skipIf(process.platform !== 'win32')('[windows-only: Windows PowerShell 5.1] codepages.ps1 reports the code pages of its console', { timeout: 120_000 }, () => {
    const run = spawnSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(probeDir, 'codepages.ps1')], { encoding: 'utf8', windowsHide: true })
    expect(run.status).toBe(0)
    expect(parseCodePages(run.stdout)?.consoleOutputCP).toBeGreaterThan(0)
  })
})

describe('runProgram', () => {
  const sleeper = 'setTimeout(() => {}, 60000)'

  it('stops a program at its timeout and says so with a signal', { timeout: 30_000 }, async () => {
    const run = await runProgram(process.execPath, ['-e', sleeper], { timeoutMs: 200 })
    expect(run.signal).toBe('SIGTERM')
    expect(run.error).toBeUndefined()
  })

  it('does not hang on a descendant that holds the output pipes open', { timeout: 30_000 }, async () => {
    // The grandchild inherits stdout, and child.kill() alone would leave it running.
    const grandchild = 'setTimeout(() => {}, 6000)'
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' }); console.log('started'); ${sleeper}`
    const started = Date.now()
    const run = await runProgram(process.execPath, ['-e', parent], { timeoutMs: 1_000, graceMs: 500 })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(run.signal).toBe('SIGTERM')
    expect(run.stdout).toContain('started')
  })

  it('does not stop a program that already exited, and closes the pipes its descendant holds', { timeout: 30_000 }, async () => {
    const grandchild = 'setTimeout(() => {}, 6000)'
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' }).unref(); console.log('started'); setTimeout(() => process.exit(0), 100)`
    const started = Date.now()
    const run = await runProgram(process.execPath, ['-e', parent], { timeoutMs: 1_000, graceMs: 500 })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(run).toMatchObject({ code: 0, signal: 'SIGTERM' })
    expect(run.stdout).toContain('started')
  })

  it('leaves a program that finishes in time as it ended', async () => {
    const run = await runProgram(process.execPath, ['-e', "process.stdout.write('ok'); process.exitCode = 3"])
    expect(run).toEqual({ code: 3, signal: null, stdout: 'ok', stderr: '' })
  })
})

describe('the drivers', () => {
  const measure = (pid: number): Promise<ContextMeasurement> =>
    Promise.resolve({
      targetPid: pid,
      parentPid: pid,
      console: { attached: false, lastError: 6, window: 0 },
      job: { driverInJob: false, helperInJob: false, limitFlags: null, limitsError: null },
      token: { user: 'RUNNER\\veydr-probe', elevated: false, elevationType: 'default', administrators: 'absent' },
      hkcu: { environment: 'present', environmentValues: 2 },
      helper: 'detached',
    })
  const collect = async (run: (args: string[], options: Parameters<typeof runCommands>[1]) => Promise<void>, args: string[]) => {
    const lines: { id: string; answer: unknown; detail: string; data: Record<string, unknown> }[] = []
    await run(args, { measure, probeDirectory: () => ({ usable: true }), write: (line) => lines.push(JSON.parse(line) as (typeof lines)[number]) })
    return lines
  }

  it('reports what a check resolves with, and null with the reason for one that throws', async () => {
    const lines: unknown[][] = []
    const report = (...args: unknown[]) => void lines.push(args)
    await reportCheck(report, 'a', () => Promise.resolve({ answer: 'yes', detail: '', data: { x: 1 } }))
    await reportCheck(report, 'b', () => Promise.reject(new Error('boom')))
    expect(lines).toEqual([['a', 'yes', '', { x: 1 }], ['b', null, 'the probe failed: boom', {}]])
  })

  // Without Windows every command fails to start, which shows each check is reported, once, in order.
  it.skipIf(process.platform !== 'linux')('[linux-only: no cmd.exe, so no command runs for long] reports each area\'s checks after the context checks', { timeout: 60_000 }, async () => {
    const drivers = [
      ['commands', 'admin', runCommands],
      ['environment', 'admin', runEnvironment],
      ['environment', 'standard', runEnvironment],
      ['encoding', 'admin', runEncoding],
    ] as const
    for (const [area, user, run] of drivers) {
      const lines = await collect(run, ['--user', user])
      expect(lines.map((l) => l.id).sort(), `${area} ${user}`).toEqual([...contextIds(user), ...placeholderIds(area, user)].sort())
      expect(lines.slice(0, contextIds(user).length).map((l) => l.id), `${area} ${user}`).toEqual(contextIds(user))
      for (const line of lines) expect(line.data['context'], line.id).toEqual({ user, console: 'none' })
    }
  })

  it('refuses arguments it does not take, and answers null when the standard user is unavailable', async () => {
    for (const run of [runCommands, runEnvironment, runEncoding]) await expect(collect(run, ['extra', '--user', 'admin'])).rejects.toThrow('expected no positional arguments')
    await expect(collect(runCommands, ['--user', 'standard'])).rejects.toThrow('has no checks that run as standard')
    await expect(collect(runEncoding, ['--user', 'standard'])).rejects.toThrow('has no checks that run as standard')
    const lines = await collect(runEnvironment, ['--user', 'standard', '--unavailable', 'no account'])
    expect(lines.map((l) => l.id)).toEqual([...contextIds('standard'), 'env-registry-std'])
    for (const line of lines) expect(line.answer, line.id).toBeNull()
  })
})
