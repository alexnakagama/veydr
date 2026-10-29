#!/usr/bin/env node
// Starts a probe driver the way Veydr's main process would see its commands' parent: without a
// console (design D9). The driver is started with `detached: true` (DETACHED_PROCESS, so it gets no
// console) and `windowsHide: true`; its stdout is read line by line and each result line is appended
// to the results file at once, so a driver that hangs or crashes keeps the lines it wrote.
//
//   node scripts/windows-probe/launch-detached.mjs --timeout <seconds> --out <results-file> [--log <file>] -- <driver.mjs> [<driver args>...]
//
// The driver runs under the same node.exe as the launcher. Its stderr, and the launcher's own
// messages, go to the launcher's stderr, or to `--log` when it has none (standard-user.ps1 starts it
// without standard handles). A driver that does not exit within the timeout is stopped with its
// whole process tree. NEGATIVE_CONTROL=true, which the workflow sets on one probe step for its
// negative-control input, starts the driver attached instead, on the launcher's console, which is
// the job shell's, as if started straight from the shell; its ctx-no-console must then fail (D9).
//
// Exit codes: 0 the driver exited with 0 within the timeout and wrote result lines, and only those;
// 1 a failed run (did not start, timed out, exited with another code, wrote no result lines, or wrote
// a line that is not a result line, which is left out of the results file); 2 usage error.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'

/** How long the launcher keeps reading after the driver exited: a descendant may still hold its stdout open. */
const DRAIN_MS = 5_000

/** Thrown for a command line the launcher cannot run; it exits with 2. */
export class LaunchUsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LaunchUsageError'
  }
}

/** Parses the launcher's command line, and NEGATIVE_CONTROL from `env`. Throws LaunchUsageError. */
export function parseLaunchArgs(args, env = {}) {
  const separator = args.indexOf('--')
  if (separator < 0) throw new LaunchUsageError('missing "--" before the driver')
  const [driver, ...driverArgs] = args.slice(separator + 1)
  if (driver === undefined) throw new LaunchUsageError('no driver after "--"')
  if (!driver.endsWith('.mjs')) throw new LaunchUsageError(`the driver must be a .mjs file, not ${JSON.stringify(driver)}`)
  const options = {}
  const own = args.slice(0, separator)
  for (let i = 0; i < own.length; i += 2) {
    const [name, value] = [own[i], own[i + 1]]
    if (!['--timeout', '--out', '--log'].includes(name)) throw new LaunchUsageError(`unknown option ${JSON.stringify(name)}`)
    if (value === undefined || value === '') throw new LaunchUsageError(`${name} needs a value`)
    if (name.slice(2) in options) throw new LaunchUsageError(`${name} given twice`)
    options[name.slice(2)] = value
  }
  if (options.out === undefined) throw new LaunchUsageError('--out <results-file> is required')
  if (options.timeout === undefined) throw new LaunchUsageError('--timeout <seconds> is required')
  if (!/^\d+$/.test(options.timeout) || Number(options.timeout) < 1 || Number(options.timeout) > 3600) {
    throw new LaunchUsageError(`--timeout must be a whole number of seconds from 1 to 3600, not ${JSON.stringify(options.timeout)}`)
  }
  const flag = env.NEGATIVE_CONTROL
  if (flag !== undefined && flag !== 'true' && flag !== 'false') throw new LaunchUsageError(`NEGATIVE_CONTROL must be "true" or "false", not ${JSON.stringify(flag)}`)
  return { driver, driverArgs, out: options.out, log: options.log, timeoutMs: Number(options.timeout) * 1000, attached: flag === 'true' }
}

/** Whether `text` is a probe result line: a JSON object with a check ID. summary.mjs checks the rest. */
export function isResultLine(text) {
  try {
    const value = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.id === 'string' && value.id !== '' && 'answer' in value
  } catch {
    return false
  }
}

/** Stops `child` and its descendants: taskkill /T on Windows, the process group the detached child leads elsewhere. */
function stopTree(child, attached) {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
    spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 30_000 })
    return
  }
  try {
    if (attached) child.kill('SIGKILL')
    else process.kill(-child.pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

/**
 * Starts `driver` with `driverArgs` under this node, detached and hidden unless `attached`, appends
 * each result line it writes to `out`, and passes its stderr to `log`. Resolves when the driver has
 * exited and its output is read: `{ ok, lines, problems }`, `ok` meaning it exited with 0 within
 * `timeoutMs` and wrote only result lines. Never rejects.
 */
export function launch({ driver, driverArgs = [], out, timeoutMs, attached = false, log = (text) => process.stderr.write(text), drainMs = DRAIN_MS }) {
  return new Promise((done) => {
    const problems = []
    let lines = 0
    let finished = false
    let timedOut = false
    const timers = []

    const child = spawn(process.execPath, [driver, ...driverArgs], {
      detached: !attached,
      windowsHide: !attached,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const stdout = new StringDecoder('utf8')
    const stderr = new StringDecoder('utf8')
    let pending = ''
    let appendFailed = false
    const take = (raw) => {
      const line = raw.replace(/\r$/, '')
      if (line.trim() === '') return
      if (!isResultLine(line)) {
        const shown = line.length > 200 ? `${line.slice(0, 200)}…` : line
        problems.push(`the driver wrote a line that is not a result line, left out of the results: ${shown}`)
        return
      }
      try {
        appendFileSync(out, `${line}\n`)
        lines++
      } catch (error) {
        if (!appendFailed) problems.push(`cannot append to ${out}: ${error instanceof Error ? error.message : String(error)}`)
        appendFailed = true
      }
    }
    const takeComplete = () => {
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        take(pending.slice(0, end))
        pending = pending.slice(end + 1)
      }
    }

    const finish = () => {
      if (finished) return
      finished = true
      for (const timer of timers) clearTimeout(timer)
      pending += stdout.end()
      takeComplete()
      // A last line without a line break still counts.
      take(pending)
      const rest = stderr.end()
      if (rest !== '') log(rest)
      // Every driver reports its context checks first, so a driver that wrote nothing did not run.
      if (lines === 0 && problems.length === 0) problems.push('the driver wrote no result lines')
      done({ ok: problems.length === 0, lines, problems })
    }

    child.stdout.on('data', (chunk) => {
      pending += stdout.write(chunk)
      takeComplete()
    })
    child.stderr.on('data', (chunk) => log(stderr.write(chunk)))

    timers.push(
      setTimeout(() => {
        timedOut = true
        problems.push(`the driver did not finish within ${timeoutMs / 1000} s, so it was stopped with its process tree`)
        stopTree(child, attached)
        // If it cannot be stopped, report what was read so far rather than waiting for the job's timeout.
        timers.push(setTimeout(finish, drainMs))
      }, timeoutMs),
    )
    child.on('error', (error) => {
      problems.push(`cannot start the driver: ${error.message}`)
      finish()
    })
    child.on('exit', (code, signal) => {
      if (!timedOut && code !== 0) problems.push(`the driver exited with ${signal === null ? `code ${String(code)}` : signal}`)
      timers.push(
        setTimeout(() => {
          log(`launch-detached: the driver's output was still open ${drainMs / 1000} s after it exited (a descendant holds it); stopped reading\n`)
          child.stdout.destroy()
          child.stderr.destroy()
          finish()
        }, drainMs),
      )
    })
    child.on('close', finish)
  })
}

async function main(args) {
  let options
  try {
    options = parseLaunchArgs(args, process.env)
  } catch (error) {
    if (!(error instanceof LaunchUsageError)) throw error
    console.error(`usage: launch-detached.mjs --timeout <seconds> --out <results-file> [--log <file>] -- <driver.mjs> [<driver args>...]: ${error.message}`)
    return 2
  }
  const logFile = options.log
  // A log that cannot be written must not crash the launcher: its messages then go to stderr.
  const log =
    logFile === undefined
      ? (text) => process.stderr.write(text)
      : (text) => {
          try {
            appendFileSync(logFile, text)
          } catch {
            process.stderr.write(text)
          }
        }
  const driver = resolve(options.driver)
  if (!existsSync(driver)) {
    log(`launch-detached: ${driver} does not exist\n`)
    return 2
  }
  const how = options.attached ? 'attached to this console (negative control)' : 'detached, without a console'
  log(`launch-detached: starting ${[driver, ...options.driverArgs].join(' ')}, ${how}\n`)
  const result = await launch({ ...options, driver, log })
  for (const problem of result.problems) log(`launch-detached: ${problem}\n`)
  log(`launch-detached: ${result.lines} result lines appended to ${options.out}\n`)
  return result.ok ? 0 : 1
}

/**
 * True when Node runs this file as the entry point. Node resolves symlinks for `import.meta.url`, so
 * argv[1] is too. Windows paths compare without case (a drive letter may differ), since a launcher or
 * driver that wrongly thinks it was imported would exit 0 having done nothing.
 */
function isEntryPoint() {
  if (process.argv[1] === undefined) return false
  try {
    const [argv, self] = [realpathSync(process.argv[1]), fileURLToPath(import.meta.url)]
    return process.platform === 'win32' ? argv.toLowerCase() === self.toLowerCase() : argv === self
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(`launch-detached.mjs: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    },
  )
}
