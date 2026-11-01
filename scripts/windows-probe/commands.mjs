#!/usr/bin/env node
// The command probes (task 5.1, design D3): how `.cmd` shims can be started, from a parent without a
// console. Each corpus case runs on each route with `fwd.cmd`, the shape of npm.cmd, as the target, in
// a working directory of its own: record.mjs writes what arrived there, and so would an injected
// command its sentinel.
//
//   node scripts/windows-probe/commands.mjs --user admin [--unavailable <reason>]
//
// is started by launch-detached.mjs and writes the result lines to stdout. Exit codes: 0 written,
// 1 failure, 2 usage error.
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CMD_ROUTES, VERBATIM_REFUSED_CASES } from './checks.mjs'
import { CORPUS, sentinelFor } from './cmd-corpus.mjs'
import { cmdShimArgs } from './cmd-quote.mjs'
import { DriverUsageError, driverMain, isEntryPoint, noAnswer, parseDriverArgs, reportCheck, runDriver, runProgram, system32 } from './driver.mjs'
import { describeExit, oneLine } from './helper-build.mjs'
import { placeholderIds } from './placeholder.mjs'

const AREA = 'commands'

/** One command. The `long` case runs 2,000 failing commands on the shell route, each searching PATH. */
const COMMAND_MS = 60_000

/** The shim's only line, the shape of npm.cmd (design D3). */
export const SHIM_LINE = '@node "%~dp0record.mjs" %*'

/** The file record.mjs writes in its working directory. */
export const RECORD_FILE = 'veydr-record.json'

const DECOY_SENTINEL = 'veydr-sentinel-pathext-cwd'

/** The longest argument `data` and `detail` hold in full; the `long` case would dwarf its result file. */
const PREVIEW_LENGTH = 256

/** Shorter text is too likely to appear in a variable by chance to count as coming from one. */
const MIN_ENVIRONMENT_TEXT = 8

/** What `npm --version` prints. */
const VERSION = /^\d+\.\d+\.\d+/

const message = (error) => (error instanceof Error ? error.message : String(error))

/** `args` with any argument too long for a result line cut short, stating its length. */
export const previewArgs = (args) => args.map((arg) => (arg.length > PREVIEW_LENGTH ? `${arg.slice(0, PREVIEW_LENGTH)}… (${arg.length} characters)` : arg))

const comparable = (text) => text.replaceAll('\\', '/').toLowerCase()

/**
 * Whether `text` holds a variable's value from `env`, or a part of one: the shell route's expansions
 * end up in what a case records, split at spaces, or with `\` replaced by `%PATH:\=/%`.
 */
function fromEnvironment(text, env) {
  if (text.length < MIN_ENVIRONMENT_TEXT) return false
  const found = comparable(text)
  return Object.values(env).some((value) => value !== undefined && value.length >= MIN_ENVIRONMENT_TEXT && (comparable(value).includes(found) || found.includes(comparable(value))))
}

/**
 * The recorded arguments as a result line may show them: no variable value reaches a result file
 * (task 5.2), and that an argument arrived expanded, which is the finding, stays visible.
 */
export const withoutEnvironment = (recorded, intended, env) => recorded.map((arg) => (!intended.includes(arg) && fromEnvironment(arg, env) ? `(${arg.length} characters from the environment)` : arg))

/** cmd.exe's error output, which quotes the commands it could not run, without variable values. */
export const stderrWithoutEnvironment = (stderr, env) => oneLine(stderr.split(/\s+/).map((word) => (fromEnvironment(word.replace(/^['"]|['"]$/g, ''), env) ? '(from the environment)' : word)).join(' '))

// ---------------------------------------------------------------------------------------------
// The answers, from what was measured

/** cmd-direct-spawn. `spawned` is `{ started: true }`, or `{ code }` for a spawn that was refused. */
export function directSpawnAnswer(spawned) {
  if (spawned.started === true) return { answer: 'no', detail: 'x.cmd started without a shell' }
  return spawned.code === 'EINVAL' ? { answer: 'yes', detail: '' } : { answer: 'no', detail: `the spawn failed with ${String(spawned.code)}, not EINVAL` }
}

/**
 * A verbatim case the candidate refused. Only a case whose check asks for that answers yes: the
 * refusal also depends on the shim's real path, which checks.mjs cannot know, and one for any
 * other reason must not pass as the behavior asked for.
 */
export function refusalAnswer({ expected, reason, shim }) {
  return expected ? { answer: 'yes', detail: '' } : { answer: null, detail: `unexpected refusal with the shim at ${shim}: ${reason}` }
}

/**
 * cmd-route-*: `recorded` is what record.mjs wrote, or undefined; `shown` is how a result line may
 * show it (withoutEnvironment); `sentinel` is whether the case's sentinel exists.
 */
export function routeAnswer({ intended, recorded, shown = recorded, sentinel, run }) {
  const unanswered = noAnswer(run, COMMAND_MS)
  if (unanswered !== undefined) return unanswered
  const problems = []
  if (recorded === undefined) problems.push(`record.mjs wrote nothing (cmd.exe ${describeExit(run)})`)
  else if (JSON.stringify(recorded) !== JSON.stringify(intended)) problems.push(`received ${JSON.stringify(previewArgs(shown))} instead of ${JSON.stringify(previewArgs(intended))}`)
  if (sentinel) problems.push('an injected command created the sentinel')
  return problems.length === 0 ? { answer: 'yes', detail: '' } : { answer: 'no', detail: problems.join('; ') }
}

/**
 * cmd-pathext: `where` is where.exe's result, which lists every match in search order, and `run` is
 * `npm --version` through cmd.exe. The first match with a `PATHEXT` extension is what cmd.exe starts;
 * the extensionless `npm` beside npm.cmd is a shell script it does not. where.exe is not cmd.exe's own
 * lookup, so this reads the resolution from the two together; a fixture on PATH would observe cmd.exe
 * directly, but not the real npm the question names.
 */
export function pathextAnswer({ pathext, where, run }) {
  if (pathext === undefined) return { answer: null, detail: 'PATHEXT is not set' }
  const unanswered = noAnswer(where, COMMAND_MS) ?? noAnswer(run, COMMAND_MS)
  if (unanswered !== undefined) return unanswered
  const extensions = pathext.split(';').filter((extension) => extension !== '').map((extension) => extension.toLowerCase())
  const matches = where.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  const first = matches.find((match) => extensions.includes(win32.extname(match).toLowerCase()))
  if (first === undefined) return { answer: 'no', detail: `no match for npm has a PATHEXT extension: where.exe ${describeExit(where)}` }
  if (win32.basename(first).toLowerCase() !== 'npm.cmd') return { answer: 'no', detail: `npm resolves to ${first}` }
  if (run.code !== 0 || !VERSION.test(run.stdout.trim())) return { answer: 'no', detail: `npm --version through cmd.exe ${describeExit(run)}, printing ${JSON.stringify(oneLine(run.stdout))}` }
  return { answer: 'yes', detail: '' }
}

/** cmd-pathext-cwd: `sentinel` is whether the decoy ran. With no sentinel, it counts as left unused only if the real npm ran. */
export function pathextCwdAnswer({ sentinel, run }) {
  const unanswered = noAnswer(run, COMMAND_MS)
  if (unanswered !== undefined) return unanswered
  if (sentinel) return { answer: 'no', detail: 'cmd.exe ran the npm.cmd decoy from the working directory' }
  if (run.code !== 0 || !VERSION.test(run.stdout.trim())) return { answer: null, detail: `neither the decoy nor npm ran: cmd.exe ${describeExit(run)}, printing ${JSON.stringify(oneLine(run.stdout))}` }
  return { answer: 'yes', detail: '' }
}

// ---------------------------------------------------------------------------------------------
// The probes

/** Writes the shim and x.cmd into `dir`, and copies record.mjs beside the shim. */
function prepare(dir) {
  const fwd = join(dir, 'fwd.cmd')
  writeFileSync(fwd, `${SHIM_LINE}\r\n`)
  copyFileSync(fileURLToPath(new URL('./record.mjs', import.meta.url)), join(dir, 'record.mjs'))
  const direct = join(dir, 'x.cmd')
  writeFileSync(direct, '@exit /b 0\r\n')
  return { dir, fwd, direct }
}

/** A new empty directory under `dir`, so nothing of an earlier command can be found in it. */
const newDirectory = (dir, ...names) => {
  const path = join(dir, ...names)
  mkdirSync(path, { recursive: true })
  return path
}

/** Spawning a `.cmd` directly: Node refuses it synchronously, unlike a spawn that fails in the OS. */
function spawnDirectly(file) {
  return new Promise((resolve) => {
    try {
      const child = spawn(file, [], { windowsHide: true, stdio: 'ignore' })
      child.on('error', (error) => resolve({ code: error.code }))
      child.on('spawn', () => resolve({ started: true }))
    } catch (error) {
      resolve({ code: error.code })
    }
  })
}

async function directSpawn({ direct }) {
  const spawned = await spawnDirectly(direct)
  return { ...directSpawnAnswer(spawned), data: { spawned } }
}

/** What the case's working directory shows after its command, for routeAnswer. */
function readRecord(cwd) {
  const file = join(cwd, RECORD_FILE)
  if (!existsSync(file)) return undefined
  try {
    const recorded = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(recorded) ? recorded : undefined
  } catch {
    return undefined
  }
}

/**
 * One corpus case on one route. The shim's path is quoted on the shell route, which would otherwise
 * split it at a space: the case is about the arguments, and an unquoted path with a space is outside
 * this check. A case the candidate refuses is never spawned.
 */
async function routeCase(route, c, { dir, fwd }) {
  const where = { route, case: c.id }
  let start
  if (route === 'shell') {
    start = (options) => runProgram(`"${fwd}"`, c.args, { ...options, shell: true })
  } else {
    const refusal = VERBATIM_REFUSED_CASES.includes(c.id)
    let args
    try {
      args = cmdShimArgs(fwd, c.args)
    } catch (error) {
      return { ...refusalAnswer({ expected: refusal, reason: message(error), shim: fwd }), data: { ...where, refused: message(error) } }
    }
    if (refusal) return { answer: 'no', detail: 'the candidate accepted a case it must refuse', data: where }
    start = (options) => runProgram(system32('cmd.exe'), args, { ...options, windowsVerbatimArguments: true })
  }
  const cwd = newDirectory(dir, route, c.id)
  const run = await start({ cwd, timeoutMs: COMMAND_MS })
  const recorded = readRecord(cwd)
  const sentinel = existsSync(join(cwd, sentinelFor(c.id)))
  const shown = recorded === undefined ? undefined : withoutEnvironment(recorded, c.args, process.env)
  const data = { ...where, recorded: shown === undefined ? null : previewArgs(shown), sentinel, exitCode: run.code, stderr: stderrWithoutEnvironment(run.stderr, process.env) }
  return { ...routeAnswer({ intended: c.args, recorded, shown, sentinel, run }), data }
}

async function pathext({ dir }) {
  const cwd = newDirectory(dir, 'pathext')
  const where = await runProgram(system32('where.exe'), ['npm'], { cwd, timeoutMs: COMMAND_MS })
  const run = await runProgram(system32('cmd.exe'), ['/d', '/s', '/c', 'npm --version'], { cwd, timeoutMs: COMMAND_MS })
  return {
    ...pathextAnswer({ pathext: process.env.PATHEXT, where, run }),
    data: { pathext: process.env.PATHEXT ?? null, where: where.stdout.split(/\r?\n/).filter((line) => line.trim() !== ''), npmExitCode: run.code, npmVersion: oneLine(run.stdout) },
  }
}

async function pathextCwd({ dir }) {
  const cwd = newDirectory(dir, 'pathext-cwd')
  writeFileSync(join(cwd, 'npm.cmd'), `@type nul>"%~dp0${DECOY_SENTINEL}"\r\n`)
  const run = await runProgram(system32('cmd.exe'), ['/d', '/s', '/c', 'npm --version'], { cwd, timeoutMs: COMMAND_MS })
  const sentinel = existsSync(join(cwd, DECOY_SENTINEL))
  return {
    ...pathextCwdAnswer({ sentinel, run }),
    data: { noDefaultCurrentDirectoryInExePath: process.env.NoDefaultCurrentDirectoryInExePath !== undefined, sentinel, exitCode: run.code },
  }
}

async function probeCommands(ids, report) {
  const dir = mkdtempSync(join(tmpdir(), 'veydr-probe-commands-'))
  try {
    let files
    try {
      files = prepare(dir)
    } catch (error) {
      for (const id of ids) report(id, null, `the shim could not be written: ${message(error)}`, {})
      return
    }
    await reportCheck(report, 'cmd-direct-spawn', () => directSpawn(files))
    for (const route of Object.keys(CMD_ROUTES)) {
      for (const c of CORPUS) await reportCheck(report, `cmd-route-${route}-${c.id}`, () => routeCase(route, c, files))
    }
    await reportCheck(report, 'cmd-pathext', () => pathext(files))
    await reportCheck(report, 'cmd-pathext-cwd', () => pathextCwd(files))
  } finally {
    // A file a child still holds must not fail a run whose results are written.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (error) {
      console.error(`commands.mjs: left ${dir}: ${message(error)}`)
    }
  }
}

/** Runs the driver for a parsed command line; `options` are passed on to runDriver (tests). */
export async function runCommands(args, options = {}) {
  const { user, unavailable, positional } = parseDriverArgs(args)
  if (positional.length > 0) throw new DriverUsageError(`expected no positional arguments, got ${JSON.stringify(positional)}`)
  const ids = placeholderIds(AREA, user)
  await runDriver({ ...options, area: AREA, user, ids, unavailable, probe: (report) => probeCommands(ids, report) })
}

if (isEntryPoint(import.meta.url)) driverMain('commands.mjs', runCommands)
