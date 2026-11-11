#!/usr/bin/env node
// Runs `veydr-helper.exe ports` as the temporary standard user (add-windows-port-inspection design
// D7), for test/integration/windows-ports.test.ts. standard-user.ps1 starts it as that account, with
// the helper given by its -Helper parameter copied next to this file:
//
//   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows-probe/standard-user.ps1 -Results <results-file> -Timeout <seconds> -Driver ports-standard-user.mjs -Helper <full path of veydr-helper.exe>
//
// It is built on driver.mjs, so it reports the context checks first (ctx-standard-user among them,
// the control that the token is not an administrator's) and answers every line with the reason when
// the standard user is unavailable. It is not a probe area: its two result lines are not checks of
// checks.mjs, it has no prediction, and summary.mjs and windows-probe.yml never see it. It writes:
// - ports-std-helper-exit: whether the helper exited with 0, with `data.exitCode`;
// - ports-std-helper-output: whether the helper printed exactly one line, with the exact stdout in
//   `data.stdout`, for the test to read through createWindowsPortInspector. That result line is as
//   long as the listing, up to MAX_OUTPUT_BYTES (16 MiB) and some escaping: whatever reads the
//   results file (launch-detached.mjs, standard-user.ps1, the test) must take lines of that size.
//
// The command line is `--user standard [--unavailable <reason>]`: nothing else, so nothing but the
// helper beside it can be run. Exit codes: 0 written, 1 failure, 2 usage error.
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DriverUsageError, driverMain, isEntryPoint, parseDriverArgs, runDriver } from './driver.mjs'

/** The driver's own area, outside checks.mjs's PROBE_AREAS. */
export const AREA = 'ports-standard-user'

export const EXIT_ID = 'ports-std-helper-exit'
export const OUTPUT_ID = 'ports-std-helper-output'

/** The two result lines this driver writes after the context checks; runDriver's catalog for it. */
export const CATALOG = Object.freeze({
  areas: Object.freeze([AREA]),
  checks: Object.freeze(
    [EXIT_ID, OUTPUT_ID].map((id) => Object.freeze({ kind: 'check', id, area: AREA, context: Object.freeze({ console: 'none', user: 'standard' }) })),
  ),
})

/** The helper this driver runs: the file standard-user.ps1 copies next to it from -Helper. */
export const HELPER_PATH = fileURLToPath(new URL('./veydr-helper.exe', import.meta.url))

/**
 * Most bytes of the helper's stdout kept: MAX_PORTS_OUTPUT_BYTES of protocol.ts (16 MiB), which
 * Veydr itself accepts (windows-probe-launch.test.ts checks that the two agree). More stops the helper.
 */
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

/** Most bytes of the helper's stderr kept for a detail. */
const MAX_STDERR_BYTES = 4096

/**
 * How long the helper may take. Veydr allows 10 s (PORTS_TIMEOUT_MS); the first start of a new
 * account's .NET program may be scanned by antivirus software, so the probe allows more and records
 * the time it took.
 */
export const HELPER_TIMEOUT_MS = 30_000

/**
 * Runs `<helperPath> ports` with stdin empty and closed, hidden and in the helper's directory, and
 * resolves with `{ code, signal, stdout, stderr, ms, error?, stopped? }`: `stdout` as raw bytes,
 * `stderr` as text (at most MAX_STDERR_BYTES), `stopped` naming the limit it was stopped at
 * ('timeout' or 'output'), and `error` why it did not start. Never rejects. The helper starts no
 * process, so stopping it stops everything it ran.
 */
export function runHelperPorts(helperPath = HELPER_PATH, { timeoutMs = HELPER_TIMEOUT_MS, maxOutputBytes = MAX_OUTPUT_BYTES, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    const started = performance.now()
    const out = []
    let outBytes = 0
    let err = Buffer.alloc(0)
    let stopped
    let settled = false
    let child
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout: Buffer.concat(out), stderr: err.toString('utf8'), ms: Math.round(performance.now() - started), ...(stopped === undefined ? {} : { stopped }), ...result })
    }
    const stop = (why) => {
      if (stopped !== undefined) return
      stopped = why
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    }
    const timer = setTimeout(() => stop('timeout'), timeoutMs)
    try {
      child = spawnImpl(helperPath, ['ports'], { cwd: dirname(helperPath), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false })
    } catch (error) {
      finish({ code: null, signal: null, error: error instanceof Error ? error.message : String(error) })
      return
    }
    child.stdout.on('data', (chunk) => {
      if (stopped !== undefined) return
      outBytes += chunk.length
      if (outBytes > maxOutputBytes) return stop('output')
      out.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (err.length < MAX_STDERR_BYTES) err = Buffer.concat([err, chunk]).subarray(0, MAX_STDERR_BYTES)
    })
    child.on('error', (error) => finish({ code: null, signal: null, error: error.message }))
    child.on('close', (code, signal) => finish({ code, signal }))
  })
}

const oneLine = (text) => text.replace(/\s+/g, ' ').trim()

/**
 * The two result lines for one run of the helper (runHelperPorts): `{ exit, output }`, each
 * `{ answer, detail, data }`. The exit line answers `yes` for exit code 0 and `no` for another code;
 * the output line answers `yes` for exactly one non-empty line of UTF-8 ending in a line feed, and
 * keeps the exact stdout in `data.stdout` whenever it is UTF-8. A helper that did not start or was
 * stopped answers neither (null).
 */
export function helperAnswers(run) {
  const stderr = oneLine(run.stderr)
  const timing = { ms: run.ms }
  if (run.error !== undefined) {
    const detail = `the helper did not start: ${run.error}`
    return { exit: { answer: null, detail, data: timing }, output: { answer: null, detail, data: timing } }
  }
  if (run.stopped !== undefined) {
    const detail = run.stopped === 'timeout' ? `the helper did not finish within ${HELPER_TIMEOUT_MS / 1000} s and was stopped` : `the helper printed more than ${MAX_OUTPUT_BYTES} bytes and was stopped`
    return { exit: { answer: null, detail, data: timing }, output: { answer: null, detail, data: { ...timing, bytes: run.stdout.length } } }
  }
  const exitData = { ...timing, exitCode: run.code, ...(run.signal === null ? {} : { signal: run.signal }), ...(stderr === '' ? {} : { stderr }) }
  const exit = run.code === 0 ? { answer: 'yes', detail: '', data: exitData } : { answer: 'no', detail: `the helper exited with ${String(run.code ?? run.signal)}${stderr === '' ? '' : `: ${stderr}`}`, data: exitData }

  let stdout
  try {
    stdout = new TextDecoder('utf-8', { fatal: true }).decode(run.stdout)
  } catch {
    return { exit, output: { answer: 'no', detail: 'the helper\'s stdout is not UTF-8', data: { bytes: run.stdout.length } } }
  }
  const data = { bytes: run.stdout.length, stdout }
  const lines = stdout.split('\n')
  const output =
    lines.length === 2 && lines[1] === '' && lines[0]?.trim() !== ''
      ? { answer: 'yes', detail: '', data }
      : { answer: 'no', detail: stdout === '' ? 'the helper printed nothing' : 'the helper did not print exactly one line ending in a line feed', data }
  return { exit, output }
}

/** Runs the driver for a parsed command line; `options` are passed on to runDriver (tests), but for `runHelper`. */
export async function runPortsStandardUser(args, { runHelper = runHelperPorts, ...options } = {}) {
  const { user, unavailable, positional } = parseDriverArgs(args)
  if (positional.length > 0) throw new DriverUsageError(`expected no positional arguments, got ${JSON.stringify(positional)}`)
  // Only the standard user's view of the owners is what this driver is for.
  if (user !== 'standard') throw new DriverUsageError(`runs only as the standard user, not ${user}`)
  await runDriver({
    ...options,
    area: AREA,
    user,
    ids: [EXIT_ID, OUTPUT_ID],
    unavailable,
    catalog: CATALOG,
    probe: async (report) => {
      const { exit, output } = helperAnswers(await runHelper())
      report(EXIT_ID, exit.answer, exit.detail, exit.data)
      report(OUTPUT_ID, output.answer, output.detail, output.data)
    },
  })
}

if (isEntryPoint(import.meta.url)) driverMain('ports-standard-user.mjs', runPortsStandardUser)
