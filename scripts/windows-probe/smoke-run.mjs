// What the electron and nsis probes share (tasks 7.1–7.2): running `--smoke-test` and turning its
// report into `<prefix>-smoke-<check>` answers (design D3). A report is taken from stdout as Veydr
// writes it, so the prefix below must equal SMOKE_REPORT_PREFIX in src/main/app/smoke.ts, which
// test/unit/windows-probe-electron.test.ts checks.
//
// Whether a GUI-subsystem program's report reaches a pipe is part of what is measured (nsis-install).
// A run that printed no report line on the pipe is repeated with stdout sent to a file, so such a
// result does not also cost the smoke checks their evidence; `reportVia` keeps the difference visible.
import { closeSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runProgram } from './driver.mjs'
import { describeExit } from './helper-build.mjs'
import { ON_TIMEOUT_SMOKE_CHECKS } from './smoke-checks.mjs'

export const SMOKE_REPORT_PREFIX = 'VEYDR_SMOKE_TEST '
/** Past the smoke test's own 30 s limit, with room for Electron to start. */
export const SMOKE_RUN_MS = 120_000
const TAIL_CHARACTERS = 500
const NO_REPORT = 'the app printed no smoke report'

/** The end of `text` on one line: a tool's last lines say why it failed. */
export const outputTail = (text) => text.replace(/\s+/g, ' ').trim().slice(-TAIL_CHARACTERS)

/** The environment for a launch of Electron: this one, minus what changes Electron's mode. */
export function appEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^ELECTRON_/i.test(name) && !/^NODE_OPTIONS$/i.test(name)))
}

const isCheck = (value) => typeof value?.name === 'string' && typeof value?.ok === 'boolean' && typeof value?.detail === 'string'

const isReport = (value) =>
  ['pass', 'fail'].includes(value?.result) &&
  typeof value?.packaged === 'boolean' &&
  Array.isArray(value?.checks) &&
  value.checks.every(isCheck) &&
  new Set(value.checks.map((c) => c.name)).size === value.checks.length

/** The report in `stdout`, read as Latin-1 by runProgram: `{ report }`, or `{ problem }` saying why there is none. */
export function parseSmokeReport(stdout) {
  const lines = Buffer.from(stdout, 'latin1').toString('utf8').split(/\r?\n/).filter((line) => line.startsWith(SMOKE_REPORT_PREFIX))
  if (lines.length === 0) return { problem: NO_REPORT }
  if (lines.length > 1) return { problem: `the app printed ${lines.length} smoke reports` }
  let value
  try {
    value = JSON.parse(lines[0].slice(SMOKE_REPORT_PREFIX.length))
  } catch {
    return { problem: 'the smoke report is not JSON' }
  }
  return isReport(value) ? { report: value } : { problem: 'the smoke report is malformed' }
}

/** The exit code smoke.ts gives a report. */
export const expectedExitCode = (report) => (report.result === 'pass' ? 0 : 1)

/**
 * Runs `file` with `args` and resolves with `{ run, report?, problem?, reportVia, fileRun? }`: `run` is
 * the run on a pipe, `reportVia` is 'pipe', 'file' (see the top of this file) or null. `dir` holds the
 * file. Only a run that started and printed no report line is repeated, and a report from the repeated
 * run counts only if that run ended as the report says.
 */
export async function runSmoke(file, args, { dir, env = appEnv(), timeoutMs = SMOKE_RUN_MS }) {
  const run = await runProgram(file, args, { timeoutMs, env })
  const piped = parseSmokeReport(run.stdout)
  if ('report' in piped) return { run, report: piped.report, reportVia: 'pipe' }
  if (run.error !== undefined) return { run, problem: run.error, reportVia: null }
  if (piped.problem !== NO_REPORT) return { run, problem: piped.problem, reportVia: null }
  const path = join(dir, 'smoke-stdout.txt')
  const stdout = openSync(path, 'w')
  let fileRun
  try {
    fileRun = await runProgram(file, args, { timeoutMs, env, stdio: ['ignore', stdout, 'pipe'] })
  } finally {
    closeSync(stdout)
  }
  const written = parseSmokeReport(readFileSync(path, 'latin1'))
  if (!('report' in written)) return { run, problem: `${piped.problem}, on a pipe or in a file`, reportVia: null, fileRun }
  if (fileRun.code !== expectedExitCode(written.report)) return { run, problem: `the run with stdout in a file ${describeExit(fileRun)}, but its report says ${written.report.result}`, reportVia: null, fileRun }
  return { run, report: written.report, reportVia: 'file', fileRun }
}

/** How a smoke run went, for `data`. */
export const smokeData = ({ run, reportVia, fileRun }) => ({
  code: run.code,
  signal: run.signal,
  reportVia,
  stdout: outputTail(Buffer.from(run.stdout, 'latin1').toString('utf8')),
  stderr: outputTail(run.stderr),
  ...(fileRun === undefined ? {} : { fileRunCode: fileRun.code, fileRunSignal: fileRun.signal }),
})

/**
 * Whether the app started and its report could be read from a pipe: the question of `electron-launch`,
 * and a part of `nsis-install`'s. A `no` carries the run's output.
 */
export function launchAnswer(smoke) {
  if (smoke.run.error !== undefined) return { answer: null, detail: `the app did not start: ${smoke.run.error}` }
  if (smoke.reportVia === 'pipe') return { answer: 'yes', detail: '' }
  const output = `stdout: ${outputTail(smoke.run.stdout) || 'empty'}; stderr: ${outputTail(smoke.run.stderr) || 'empty'}`
  if (smoke.reportVia === 'file') return { answer: 'no', detail: `the app ${describeExit(smoke.run)} with no report on a pipe, but wrote one to a file; ${output}` }
  return { answer: 'no', detail: `the app ${describeExit(smoke.run)}: ${smoke.problem}; ${output}` }
}

/**
 * The answers to `ids`, the checks named `<prefix>-smoke-<check>`, by ID, and `unknown`: the checks in
 * the report that have no ID, which the driver must reject (design D4).
 */
export function smokeAnswers({ prefix, ids, smoke, packaged }) {
  const start = `${prefix}-smoke-`
  const names = ids.map((id) => id.slice(start.length))
  const { report } = smoke
  const problem = report === undefined ? (smoke.problem ?? NO_REPORT) : report.packaged === packaged ? undefined : `the report says packaged ${String(report.packaged)}`
  // The first run's end stays visible when the report comes from the repeated run.
  const data = { reportVia: smoke.reportVia, runCode: smoke.run.code, runSignal: smoke.run.signal }
  const answers = {}
  for (const [i, id] of ids.entries()) {
    const entry = report?.checks.find((c) => c.name === names[i])
    if (problem !== undefined) answers[id] = { answer: null, detail: problem, data: {} }
    else if (entry === undefined) answers[id] = ON_TIMEOUT_SMOKE_CHECKS.includes(names[i]) ? { answer: 'yes', detail: '', data } : { answer: null, detail: `the report has no ${names[i]} check`, data }
    else answers[id] = { answer: entry.ok ? 'yes' : 'no', detail: entry.ok ? '' : entry.detail || 'reported as failed', data: { ...data, reported: entry.detail } }
  }
  return { answers, unknown: problem === undefined ? report.checks.map((c) => c.name).filter((name) => !names.includes(name)) : [] }
}

/** The IDs of `prefix`'s smoke checks among `ids`. */
export const smokeIds = (ids, prefix) => ids.filter((id) => id.startsWith(`${prefix}-smoke-`))

/** Reports an answer per ID in `ids`, then rejects a report with checks that have no ID (design D4). */
export function reportAnswers(report, ids, { answers, unknown = [] }) {
  for (const id of ids) {
    const result = answers[id] ?? { answer: null, detail: `the probe has no answer for ${id}`, data: {} }
    report(id, result.answer, result.detail, result.data)
  }
  if (unknown.length > 0) throw new Error(`the smoke report has checks that are not in checks.mjs: ${unknown.join(', ')}`)
}

