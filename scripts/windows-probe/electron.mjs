#!/usr/bin/env node
// The Electron probes (task 7.1, design D3): whether the built app starts on the runner and what its
// `--smoke-test` reports, whether its main process has a console, and whether Playwright's Electron
// launcher works there. Veydr holds a single-instance lock, so the launches run one after the other,
// and each ends before the next starts. The workflow builds the app and downloads Electron first.
//
//   node scripts/windows-probe/electron.mjs --user admin
//
// is started by launch-detached.mjs and writes the result lines to stdout. Exit codes: 0 written,
// 1 failure, including a smoke report with a check checks.mjs does not know, 2 usage error.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DriverUsageError, contextResult, driverMain, isEntryPoint, noAnswer, noConsoleAnswer, parseDriverArgs, runDriver, runProgram, stopProgram } from './driver.mjs'
import { describeExit } from './helper-build.mjs'
import { placeholderIds } from './placeholder.mjs'
import { appEnv, launchAnswer, outputTail, reportAnswers, runSmoke, smokeAnswers, smokeData, smokeIds } from './smoke-run.mjs'

const AREA = 'electron'
/** Why ffi-koffi-electron does not run: the maintainer has not approved it under gate G-4 (design D6). */
export const KOFFI_NOT_APPROVED = 'not approved'
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const CONTEXT_PRELOAD = fileURLToPath(new URL('./electron-context.cjs', import.meta.url))
const PLAYWRIGHT_CONFIG = 'test/windows-probe/playwright.config.ts'
/** Past the spec's own 120 s limit. */
const PLAYWRIGHT_MS = 240_000
/** Add-Type compiles context.ps1's C# first, inside a process that is also starting Electron. */
const CONTEXT_MS = 120_000
const CONTEXT_POLL_MS = 500
const STOP_MS = 15_000

const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/** Every `message` under an `errors` list in Playwright's JSON report. */
function errorMessages(value, inErrors = false) {
  if (Array.isArray(value)) return value.flatMap((item) => errorMessages(item, inErrors))
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, item]) => (inErrors && key === 'message' && typeof item === 'string' ? [item] : errorMessages(item, inErrors || key === 'errors')))
}

/** electron-playwright, from a run with `--reporter=json`. Exactly the one test must have passed: a skip also exits with 0. */
export function playwrightAnswer(run, timeoutMs = PLAYWRIGHT_MS) {
  const unanswered = noAnswer(run, timeoutMs)
  if (unanswered !== undefined) return unanswered
  let result
  try {
    result = JSON.parse(run.stdout)
  } catch {
    if (run.code === 0) return { answer: null, detail: 'Playwright exited with 0 but printed no JSON report' }
    return { answer: 'no', detail: `Playwright ${describeExit(run)}: ${outputTail(`${run.stdout} ${run.stderr}`.replace(ANSI_COLOR, ''))}` }
  }
  const stats = result?.stats
  if (run.code === 0 && stats?.expected === 1 && stats?.unexpected === 0 && stats?.skipped === 0 && stats?.flaky === 0) return { answer: 'yes', detail: '' }
  const messages = errorMessages(result).map((message) => message.replace(ANSI_COLOR, ''))
  return { answer: 'no', detail: `Playwright ${describeExit(run)}, stats ${JSON.stringify(stats ?? null)}: ${outputTail(messages.join(' ')) || 'no error message'}` }
}

/** ctx-electron-no-console, from context.ps1's measurement of the process with `pid`. */
export function consoleAnswer({ pid, measurement }) {
  if ('error' in measurement) return { answer: null, detail: `context.ps1 failed: ${String(measurement.error)}`, data: { electronPid: pid } }
  const { answer, detail, data } = noConsoleAnswer(measurement, pid)
  return { answer, detail, data: { ...data, electronPid: pid } }
}

/** Every answer of the area by ID, and the report's checks that have no ID. */
export function electronAnswers({ ids, smoke, playwright, mainConsole }) {
  const { answers, unknown } = smokeAnswers({ prefix: AREA, ids: smokeIds(ids, AREA), smoke, packaged: false })
  return {
    unknown,
    answers: {
      ...answers,
      'electron-launch': { ...launchAnswer(smoke), data: smokeData(smoke) },
      'ctx-electron-no-console': consoleAnswer(mainConsole),
      'electron-playwright': { ...playwrightAnswer(playwright), data: { code: playwright.code, signal: playwright.signal } },
      'ffi-koffi-electron': { answer: null, detail: KOFFI_NOT_APPROVED, data: {} },
    },
  }
}

/** The measurement in context.ps1's result file, or undefined until the whole file is there. */
function readMeasurement(outFile) {
  let fileText
  try {
    fileText = readFileSync(outFile, 'utf8')
    JSON.parse(fileText.replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
  return contextResult({ code: 0, signal: null, fileText })
}

/**
 * Starts the app with electron-context.cjs preloaded, and stops it once context.ps1 has reported. This
 * is the real app, not its smoke test, so it uses the runner's user data, which the job's VM discards.
 */
function measureConsole(electron, dir) {
  const outFile = join(dir, 'electron-context.json')
  return new Promise((resolve) => {
    const child = spawn(electron, ['-r', CONTEXT_PRELOAD, ROOT], { env: { ...appEnv(), VEYDR_PROBE_CONTEXT_FILE: outFile }, windowsHide: true, stdio: 'ignore' })
    let exited = false
    let settled = false
    let timer
    let poll
    const finish = (measurement) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(poll)
      const done = () => resolve({ pid: child.pid, measurement })
      if (exited) {
        done()
        return
      }
      // The next launch, or the job's cleanup, must not find it still running.
      const force = setTimeout(done, STOP_MS)
      child.once('close', () => {
        clearTimeout(force)
        done()
      })
      stopProgram(child)
    }
    timer = setTimeout(() => finish(readMeasurement(outFile) ?? { error: `no result within ${CONTEXT_MS / 1000} s` }), CONTEXT_MS)
    poll = setInterval(() => {
      const measurement = readMeasurement(outFile)
      if (measurement !== undefined) finish(measurement)
    }, CONTEXT_POLL_MS)
    child.once('error', (error) => {
      exited = true
      finish({ error: `cannot start Electron: ${error.message}` })
    })
    child.once('exit', (code, signal) => {
      exited = true
      finish(readMeasurement(outFile) ?? { error: `Electron ended before context.ps1 reported: ${describeExit({ code, signal })}` })
    })
  })
}

const failedRun = (error) => ({ code: null, signal: null, stdout: '', stderr: '', error: error instanceof Error ? error.message : String(error) })

/** The launches, one at a time; one that throws does not cost the others. */
async function measureElectron() {
  const dir = mkdtempSync(join(tmpdir(), 'veydr-probe-electron-'))
  try {
    const electron = createRequire(import.meta.url)('electron')
    const smoke = await runSmoke(electron, [ROOT, '--smoke-test'], { dir }).catch((error) => {
      const run = failedRun(error)
      return { run, problem: run.error, reportVia: null }
    })
    const cli = fileURLToPath(new URL('../../node_modules/@playwright/test/cli.js', import.meta.url))
    const playwright = await runProgram(process.execPath, [cli, 'test', '-c', PLAYWRIGHT_CONFIG, '--reporter=json'], { timeoutMs: PLAYWRIGHT_MS, cwd: ROOT, env: appEnv() })
    const mainConsole = await measureConsole(electron, dir)
    return { smoke, playwright, mainConsole }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

/** Runs the driver for a parsed command line; `options` are passed on to runDriver (tests), but for `measureArea`. */
export async function runElectron(args, { measureArea = measureElectron, ...options } = {}) {
  const { user, unavailable, positional } = parseDriverArgs(args)
  if (positional.length > 0) throw new DriverUsageError(`expected no positional arguments, got ${JSON.stringify(positional)}`)
  const ids = placeholderIds(AREA, user)
  await runDriver({
    ...options,
    area: AREA,
    user,
    ids,
    unavailable,
    probe: async (report) => {
      let measured
      try {
        measured = await measureArea()
      } catch (error) {
        const detail = `the probe failed: ${error instanceof Error ? error.message : String(error)}`
        reportAnswers(report, ids, { answers: Object.fromEntries(ids.map((id) => [id, { answer: null, detail, data: {} }])) })
        return
      }
      reportAnswers(report, ids, electronAnswers({ ids, ...measured }))
    },
  })
}

if (isEntryPoint(import.meta.url)) driverMain('electron.mjs', runElectron)
