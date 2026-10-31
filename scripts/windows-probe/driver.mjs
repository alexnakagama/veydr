// The part every probe driver shares (design D9). A driver is a Node script that launch-detached.mjs
// starts without a console, directly or, through standard-user.ps1, as the temporary standard user.
// It writes one JSON result line per check to stdout, which the launcher appends to the job's
// results file. runDriver() reports the context checks first (ctx-no-console, ctx-job, then
// ctx-standard-user for the standard user), measured by context.ps1, and then runs the driver's own
// probe.
//
// A driver's command line is `[<positional>...] --user admin|standard [--unavailable <reason>]`.
// `--user` is the account the driver was started for; every line records it in `data.context`, and
// the context checks verify it. `--unavailable` is used by standard-user.ps1 when the standard user
// could not be created or used: the driver then runs nothing and answers each of its checks with
// null and the reason, so they are NOT-TESTABLE with the error instead of missing.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECKS, CONTEXT_AREA, PROBE_AREAS } from './checks.mjs'

export const USERS = Object.freeze(['admin', 'standard'])

const NO_CONSOLE = 'ctx-no-console'
const STANDARD_USER = 'ctx-standard-user'
const JOB = 'ctx-job'

/** Win32 ERROR_INVALID_HANDLE: what AttachConsole reports when the process has no console. */
const ERROR_INVALID_HANDLE = 6

/**
 * How long one run of context.ps1 may take; Add-Type compiles its C# first, which takes seconds.
 * Both runs of measureContext together stay well within the launcher's timeout.
 */
const CONTEXT_TIMEOUT_MS = 60_000

/** Thrown for a driver command line that cannot be run; the driver exits with 2. */
export class DriverUsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DriverUsageError'
  }
}

/** Parses `[<positional>...] --user admin|standard [--unavailable <reason>]`. Throws DriverUsageError. */
export function parseDriverArgs(args) {
  let user
  let unavailable
  const positional = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--user' || arg === '--unavailable') {
      const value = args[i + 1]
      if (value === undefined) throw new DriverUsageError(`${arg} needs a value`)
      if (arg === '--user' ? user !== undefined : unavailable !== undefined) throw new DriverUsageError(`${arg} given twice`)
      if (arg === '--user') user = value
      else unavailable = value
      i++
    } else if (arg.startsWith('--')) {
      throw new DriverUsageError(`unknown option ${arg}`)
    } else {
      positional.push(arg)
    }
  }
  if (!USERS.includes(user)) throw new DriverUsageError(`--user must be admin or standard, not ${JSON.stringify(user)}`)
  if (unavailable !== undefined && unavailable.trim() === '') throw new DriverUsageError('--unavailable needs a reason')
  return { user, unavailable, positional }
}

const runsAs = (entry, user) => entry.context.user === 'both' || entry.context.user === user

/** The order of the context checks (tasks 3.1): ctx-no-console and ctx-job first in every driver. */
const CONTEXT_ORDER = [NO_CONSOLE, JOB, STANDARD_USER]

/** The context checks a driver started for `user` reports first, in CONTEXT_ORDER. */
export function contextIds(user, checks = CHECKS) {
  const ids = checks.filter((c) => c.kind === 'check' && c.area === CONTEXT_AREA && runsAs(c, user)).map((c) => c.id)
  const unknown = ids.filter((id) => !CONTEXT_ORDER.includes(id))
  if (unknown.length > 0) throw new Error(`driver.mjs does not know how to answer ${unknown.join(', ')}`)
  return CONTEXT_ORDER.filter((id) => ids.includes(id))
}

// ---------------------------------------------------------------------------------------------
// Context checks (D9), from context.ps1's measurement

/** JOB_OBJECT_LIMIT_* flags, so `data` names the limits of the driver's job. */
const JOB_LIMITS = [
  [0x1, 'WORKINGSET'],
  [0x2, 'PROCESS_TIME'],
  [0x4, 'JOB_TIME'],
  [0x8, 'ACTIVE_PROCESS'],
  [0x10, 'AFFINITY'],
  [0x20, 'PRIORITY_CLASS'],
  [0x40, 'PRESERVE_JOB_TIME'],
  [0x80, 'SCHEDULING_CLASS'],
  [0x100, 'PROCESS_MEMORY'],
  [0x200, 'JOB_MEMORY'],
  [0x400, 'DIE_ON_UNHANDLED_EXCEPTION'],
  [0x800, 'BREAKAWAY_OK'],
  [0x1000, 'SILENT_BREAKAWAY_OK'],
  [0x2000, 'KILL_ON_JOB_CLOSE'],
  [0x4000, 'SUBSET_AFFINITY'],
]

/** The names of the JOB_OBJECT_LIMIT_* flags set in `flags`, and the hex value of any unknown bits. */
export function jobLimitNames(flags) {
  const known = JOB_LIMITS.reduce((all, [bit]) => all | bit, 0)
  const names = JOB_LIMITS.filter(([bit]) => (flags & bit) !== 0).map(([, name]) => name)
  const unknown = flags & ~known
  return unknown === 0 ? names : [...names, `0x${(unknown >>> 0).toString(16)}`]
}

const hex = (value) => `0x${value.toString(16)}`

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A section of context.ps1's output, or the reason it cannot be used: context.ps1 reports a section
 * it could not measure as `{ error }`, and `fields` gives each field's expected `typeof`.
 */
function section(measurement, name, fields) {
  const value = measurement[name]
  if (!isPlainObject(value)) return { problem: `context.ps1 reported no ${name} section` }
  if ('error' in value) return { problem: `context.ps1 could not measure ${name}: ${String(value.error)}` }
  const wrong = Object.entries(fields).filter(([field, type]) => (type === 'number|null' ? value[field] !== null && typeof value[field] !== 'number' : typeof value[field] !== type))
  if (wrong.length > 0) return { problem: `context.ps1 reported a malformed ${name} section (${wrong.map(([field]) => field).join(', ')})` }
  return { value }
}

function noConsoleAnswer(measurement, driverPid) {
  const { value: con, problem } = section(measurement, 'console', { attached: 'boolean', lastError: 'number', window: 'number' })
  if (problem !== undefined) return { answer: null, detail: problem }
  const data = { attachParent: con.attached ? 'succeeded' : `failed with error ${con.lastError}`, consoleWindow: hex(con.window) }
  // ATTACH_PARENT_PROCESS measures context.ps1's parent, which must be this driver.
  if (measurement.parentPid !== driverPid) return { answer: null, detail: `context.ps1's parent is PID ${String(measurement.parentPid)}, not the driver (PID ${driverPid})`, data }
  if (con.attached) return { answer: 'no', detail: `the driver has a console: AttachConsole(ATTACH_PARENT_PROCESS) succeeded, console window ${hex(con.window)}`, data }
  if (con.lastError !== ERROR_INVALID_HANDLE) {
    return { answer: null, detail: `AttachConsole(ATTACH_PARENT_PROCESS) failed with error ${con.lastError}, which does not show whether the driver has a console`, data }
  }
  if (con.window !== 0) return { answer: null, detail: `context.ps1 still had a console window (${hex(con.window)}) after FreeConsole`, data }
  return { answer: 'yes', detail: '', data }
}

function jobAnswer(measurement) {
  const { value: job, problem } = section(measurement, 'job', { driverInJob: 'boolean', limitFlags: 'number|null' })
  if (problem !== undefined) return { answer: null, detail: problem }
  const data = { inJob: job.driverInJob }
  if (job.limitFlags !== null) Object.assign(data, { limitFlags: hex(job.limitFlags), limits: jobLimitNames(job.limitFlags) })
  else if (job.driverInJob) data.limitsUnreadable = String(job.limitsError ?? 'no reason given')
  if (!job.driverInJob) return { answer: 'yes', detail: '', data }
  // libuv adds a process to its own job at its first spawn that is not detached (run 41173994270), and
  // an attached context.ps1 is that spawn, so this says nothing about a job of the runner's.
  if (measurement.helper === 'attached') return { answer: null, detail: 'the driver is in a job, but starting context.ps1 attached put it in libuv\'s job, which hides whether the runner has one', data }
  const limits = job.limitFlags === null ? ', whose limits could not be read' : `, with limits ${data.limits.length === 0 ? 'none' : data.limits.join(' ')}`
  return { answer: 'no', detail: `the driver is inside a Job Object${limits}`, data }
}

function standardUserAnswer(measurement, probeDir) {
  const { value: token, problem } = section(measurement, 'token', { user: 'string', elevated: 'boolean', elevationType: 'string', administrators: 'string' })
  if (problem !== undefined) return { answer: null, detail: problem }
  // The hive being loaded is what counts (D9); HKCU\Environment may be absent from a new profile's hive.
  const hkcu = section(measurement, 'hkcu', { environment: 'string', environmentValues: 'number' })
  const data = {
    account: token.user,
    elevated: token.elevated,
    elevationType: token.elevationType,
    administrators: token.administrators,
    hkcu: hkcu.problem === undefined ? 'loaded' : 'unreadable',
    ...(hkcu.problem === undefined ? { hkcuEnvironment: hkcu.value.environment, hkcuEnvironmentValues: hkcu.value.environmentValues } : {}),
    probeDirectory: probeDir.usable ? 'usable' : 'unusable',
  }
  const problems = []
  if (token.elevated) problems.push('the token is elevated')
  if (token.administrators !== 'absent') problems.push(`the token holds Administrators (${token.administrators})`)
  if (hkcu.problem !== undefined) problems.push(`the user's registry hive is not readable: ${hkcu.problem}`)
  if (!probeDir.usable) problems.push(`the probe directory is not usable: ${probeDir.error}`)
  return problems.length === 0 ? { answer: 'yes', detail: '', data } : { answer: 'no', detail: problems.join('; '), data }
}

/**
 * The context checks' answers for a driver started for `user`, in the order contextIds() gives:
 * `[{ id, answer, detail, data }]`. `measurement` is context.ps1's output, or `{ error }` if it could
 * not be obtained; `driverPid` is the driver's PID; `probeDir` is `{ usable: true }` or
 * `{ usable: false, error }`, checked for the standard user only.
 */
export function contextAnswers({ user, measurement, driverPid, probeDir = { usable: true } }) {
  return contextIds(user).map((id) => {
    if (!isPlainObject(measurement)) return { id, answer: null, detail: 'context.ps1 printed no JSON object', data: {} }
    if ('error' in measurement) return { id, answer: null, detail: `context.ps1 failed: ${String(measurement.error)}`, data: {} }
    const result =
      id === NO_CONSOLE ? noConsoleAnswer(measurement, driverPid)
      : id === STANDARD_USER ? standardUserAnswer(measurement, probeDir)
      : id === JOB ? jobAnswer(measurement)
      : { answer: null, detail: `driver.mjs does not know how to answer ${id}` }
    // How context.ps1 ran: detached, so it shares the driver's job, or attached as a fallback (measureContext).
    const helper = measurement.detachedError === undefined ? { contextHelper: measurement.helper } : { contextHelper: measurement.helper, contextHelperDetachedError: measurement.detachedError }
    return { id, answer: result.answer, detail: result.detail, data: { ...result.data, ...helper } }
  })
}

/**
 * The measurement from one run of context.ps1, or `{ error }` saying why there is none.
 * `fileText` is its result file's content, or undefined if it wrote none; `code` and `signal` are how
 * it exited, `stdout` and `stderr` what it printed (diagnostics only, see context.ps1).
 */
export function contextResult({ code, signal, fileText, stdout = '', stderr = '' }) {
  const exit = signal === null ? `exited with ${String(code)}` : signal === 'SIGTERM' ? `was stopped after ${CONTEXT_TIMEOUT_MS / 1000} s` : `ended by ${signal}`
  const printed = [stdout, stderr].map((text) => text.replace(/\s+/g, ' ').trim())
  const diagnostics = `${exit}; stdout ${printed[0] === '' ? 'empty' : JSON.stringify(printed[0])}; stderr ${printed[1] === '' ? 'empty' : JSON.stringify(printed[1])}`
  if (fileText === undefined) return { error: `context.ps1 wrote no result file (${diagnostics})` }
  let value
  try {
    value = JSON.parse(fileText.replace(/^\uFEFF/, ''))
  } catch {
    return { error: `context.ps1's result file is not JSON (${diagnostics})` }
  }
  if (!isPlainObject(value)) return { error: `context.ps1's result file holds no JSON object (${diagnostics})` }
  if ('error' in value) return { error: `${String(value.error)} (${diagnostics})` }
  if (code !== 0) return { error: `context.ps1 wrote a result but ${exit}` }
  return value
}

/** Runs context.ps1 under Windows PowerShell 5.1 (design D2), which writes its measurement to a file. */
function runContextScript(driverPid, { detached }) {
  const powershell = windowsPowerShell()
  const script = fileURLToPath(new URL('./context.ps1', import.meta.url))
  let dir
  try {
    dir = mkdtempSync(join(tmpdir(), 'veydr-probe-context-'))
  } catch (error) {
    return Promise.resolve({ error: `cannot create a directory for context.ps1's result: ${error instanceof Error ? error.message : String(error)}` })
  }
  const outFile = join(dir, 'context.json')
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-TargetPid', String(driverPid), '-OutFile', outFile]
  // Only a detached helper is outside libuv's job, so its own job is the driver's innermost job.
  if (detached) args.push('-ReadJobLimits')
  return new Promise((resolve) => {
    const done = (result) => {
      rmSync(dir, { recursive: true, force: true })
      resolve(result)
    }
    const child = spawn(powershell, args, { detached, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    const timer = setTimeout(() => child.kill(), CONTEXT_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      done({ error: `cannot start Windows PowerShell: ${error.message}` })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      let fileText
      try {
        fileText = readFileSync(outFile, 'utf8')
      } catch {
        fileText = undefined
      }
      done(contextResult({ code, signal, fileText, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }))
    })
  })
}

/**
 * context.ps1's measurement of this driver, with `helper` saying how it ran. It runs detached first,
 * so it is in the driver's own job and can read that job's limits. If that fails, it runs again attached to a hidden console of its own, which still measures
 * the driver's console, job membership and token, but not the job's limits.
 */
export async function measureContext(driverPid = process.pid) {
  if (process.platform !== 'win32') return { error: 'context.ps1 runs only on Windows' }
  const detached = await runContextScript(driverPid, { detached: true })
  if (!('error' in detached)) return { ...detached, helper: 'detached' }
  const attached = await runContextScript(driverPid, { detached: false })
  if ('error' in attached) return { error: `detached: ${detached.error}; attached: ${attached.error}` }
  return { ...attached, helper: 'attached', detachedError: detached.error }
}

/** Whether the driver can create, read and delete a file in its working directory, the probe directory. */
export function checkProbeDirectory(dir = process.cwd()) {
  const file = join(dir, `.veydr-probe-check-${process.pid}`)
  try {
    writeFileSync(file, 'veydr-probe', { flag: 'wx' })
    if (readFileSync(file, 'utf8') !== 'veydr-probe') throw new Error(`${file} did not read back`)
    rmSync(file)
    return { usable: true }
  } catch (error) {
    return { usable: false, error: `${dir}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** The path of Windows PowerShell 5.1, which every .ps1 probe script runs under (design D2). */
export const windowsPowerShell = () => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/**
 * Runs a program without a window and resolves with `{ code, signal, stdout, stderr, error }`, stopping
 * it after `timeoutMs`. Never rejects: `error` says why it did not start. Output is read as Latin-1,
 * since Windows tools print in the console's code page and only ASCII is looked at.
 */
export function runProgram(file, args, { timeoutMs = 60_000, ...options } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options })
    const output = { stdout: [], stderr: [] }
    child.stdout.on('data', (chunk) => output.stdout.push(chunk))
    child.stderr.on('data', (chunk) => output.stderr.push(chunk))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    const text = (chunks) => Buffer.concat(chunks).toString('latin1')
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, signal: null, stdout: text(output.stdout), stderr: text(output.stderr), error: error.message })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout: text(output.stdout), stderr: text(output.stderr) })
    })
  })
}

// ---------------------------------------------------------------------------------------------

/**
 * True when Node runs the module at `moduleUrl` as the entry point. Node resolves symlinks for
 * `import.meta.url`, so argv[1] is too. Windows paths compare without case (a drive letter may
 * differ), since a driver that wrongly thinks it was imported would exit 0 having done nothing.
 */
export function isEntryPoint(moduleUrl) {
  if (process.argv[1] === undefined) return false
  try {
    const [argv, self] = [realpathSync(process.argv[1]), fileURLToPath(moduleUrl)]
    return process.platform === 'win32' ? argv.toLowerCase() === self.toLowerCase() : argv === self
  } catch {
    return false
  }
}

/** Runs a driver's `run(args)` and sets the exit code: 0 written, 1 failure, 2 usage error. */
export function driverMain(name, run) {
  run(process.argv.slice(2)).then(
    () => {
      process.exitCode = 0
    },
    (error) => {
      const usage = error instanceof DriverUsageError
      console.error(`${usage ? `usage: ${name} --user admin|standard [--unavailable <reason>]: ` : `${name}: `}${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = usage ? 2 : 1
    },
  )
}

/**
 * Runs a driver: reports the context checks, then calls `probe(report)`, which reports each of
 * `ids` (the area's checks this driver answers as `user`) once with `report(id, answer, detail, data)`.
 * Every line goes to `write` as JSON with `data.context` set to `{ user, console: 'none' }`, the
 * context the driver was started for. Throws if `probe` throws, a report is invalid, or an ID was
 * not reported; the lines written until then stay written.
 */
export async function runDriver({ area, user, ids, probe, unavailable, measure = measureContext, probeDirectory = checkProbeDirectory, write = (line) => process.stdout.write(`${line}\n`) }) {
  if (!PROBE_AREAS.includes(area)) throw new DriverUsageError(`area must be one of ${PROBE_AREAS.join(', ')}, not ${JSON.stringify(area)}`)
  if (!USERS.includes(user)) throw new DriverUsageError(`user must be admin or standard, not ${JSON.stringify(user)}`)
  const byId = new Map(CHECKS.map((c) => [c.id, c]))
  for (const id of ids) {
    const entry = byId.get(id)
    if (entry?.kind !== 'check' || entry.area !== area || !runsAs(entry, user)) throw new DriverUsageError(`${id} is not a check of area ${area} that runs as ${user}`)
  }
  if (ids.length === 0) throw new DriverUsageError(`area ${area} has no checks that run as ${user}`)
  const context = contextIds(user)
  const allowed = new Set([...context, ...ids])
  const reported = new Set()

  const report = (id, answer, detail = '', data = {}) => {
    if (!allowed.has(id)) throw new Error(`${id} is not a check this driver reports`)
    if (reported.has(id)) throw new Error(`${id} reported twice`)
    if (!['yes', 'no', null].includes(answer)) throw new Error(`${id}: answer must be "yes", "no" or null, not ${JSON.stringify(answer)}`)
    if (typeof detail !== 'string' || ((answer === 'no' || answer === null) && detail.trim() === '')) throw new Error(`${id}: answer ${String(answer)} needs a detail giving the reason`)
    if (!isPlainObject(data)) throw new Error(`${id}: data must be an object`)
    reported.add(id)
    write(JSON.stringify({ id, answer, detail, data: { ...data, context: { user, console: 'none' } } }))
  }

  if (unavailable !== undefined) {
    const reason = `the standard user could not be used: ${unavailable}`
    for (const id of [...context, ...ids]) report(id, null, reason, { unavailable: true })
    return
  }
  // Context checks first (D9), so every later answer can be read against them.
  const measurement = await measure(process.pid)
  const probeDir = user === 'standard' ? probeDirectory() : { usable: true }
  for (const line of contextAnswers({ user, measurement, driverPid: process.pid, probeDir })) report(line.id, line.answer, line.detail, line.data)
  await probe(report)
  const missing = ids.filter((id) => !reported.has(id))
  if (missing.length > 0) throw new Error(`the probe did not report ${missing.join(', ')}`)
}
