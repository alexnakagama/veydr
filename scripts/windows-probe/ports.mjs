#!/usr/bin/env node
// The port probes (tasks 6.1–6.2, design D3): which methods list a process's listening sockets with
// its PID, how long they take, and whether the owner of every listener can be identified. A separate
// process, port-listener.mjs, holds the sockets; for the standard user the driver starts it, so it is
// that user's process. Only a listener on the address, port and PID expected counts as found.
//
//   node scripts/windows-probe/ports.mjs --user admin|standard [--unavailable <reason>]
//
// is started by launch-detached.mjs, and by standard-user.ps1 for the standard user, and writes the
// result lines to stdout. Exit codes: 0 written, 1 failure, 2 usage error.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DriverUsageError, driverMain, isEntryPoint, noAnswer, parseDriverArgs, runDriver, runProgram, system32, windowsPowerShell } from './driver.mjs'
import { describeExit, oneLine } from './helper-build.mjs'
import { placeholderIds } from './placeholder.mjs'

const AREA = 'ports'
export const LISTEN_ADDRESSES = Object.freeze(['127.0.0.1', '::1', '0.0.0.0'])
/** Calls per latency check, and its limits (design D3): a tenth of the Ports view's 3 s interval, and 1 s. */
export const LATENCY_CALLS = 10
export const LATENCY_MEDIAN_MS = 300
export const LATENCY_SLOWEST_MS = 1_000
const LISTENER_START_MS = 30_000
const LISTENER_STOP_MS = 10_000
const NETSTAT_MS = 60_000
/** Add-Type compiles the script's C# first, and 2 × LATENCY_CALLS reads follow. */
const SCRIPT_MS = 120_000

const LISTENER = fileURLToPath(new URL('./port-listener.mjs', import.meta.url))

const normalizeAddress = (address) => address.replace(/^\[|\]$/g, '').toLowerCase()

/**
 * The TCP sockets `netstat -ano` shows listening, as `{ address, port, pid }`. A listening socket is
 * told by its remote address, which is a wildcard, since the state column is localized (design D5).
 */
export function parseNetstat(stdout) {
  const rows = []
  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 5 || !/^TCP$/i.test(columns[0])) continue
    const local = /^(.+):(\d+)$/.exec(columns[1])
    const pid = columns.at(-1)
    if (local === null || !/^\d+$/.test(pid) || !['0.0.0.0:0', '[::]:0'].includes(columns[2])) continue
    rows.push({ address: normalizeAddress(local[1]), port: Number(local[2]), pid: Number(pid) })
  }
  return rows
}

/** A listing from a netstat run: `{ rows }`, or `{ error }` saying why there is none. */
export function netstatListing(run) {
  const unanswered = noAnswer(run, NETSTAT_MS)
  if (unanswered !== undefined) return { error: unanswered.detail }
  return run.code === 0 ? { rows: parseNetstat(run.stdout) } : { error: `netstat ${describeExit(run)}: ${oneLine(run.stderr)}` }
}

/** Whether `listing` shows each of the listeners with `helperPid`. */
export function listenerAnswer({ method, listing, listeners, helperPid }) {
  if ('error' in listing) return { answer: null, detail: `${method}: ${listing.error}` }
  const found = (l) => listing.rows.some((row) => normalizeAddress(row.address) === l.address && row.port === l.port && row.pid === helperPid)
  const missing = listeners.filter((l) => !found(l))
  if (missing.length === 0) return { answer: 'yes', detail: '' }
  return { answer: 'no', detail: `${method} does not list ${missing.map((l) => `${l.address} port ${l.port}`).join(', ')} with PID ${helperPid}` }
}

/** port-control: `results` holds listenerAnswer's result by method. */
export function controlAnswer(results) {
  const entries = Object.entries(results)
  if (entries.some(([, result]) => result.answer === 'yes')) return { answer: 'yes', detail: '' }
  const details = entries.map(([, result]) => result.detail).join('; ')
  return entries.some(([, result]) => result.answer === 'no') ? { answer: 'no', detail: details } : { answer: null, detail: details }
}

export function median(values) {
  const ordered = [...values].sort((a, b) => a - b)
  const middle = ordered.length / 2
  return Number.isInteger(middle) ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[Math.floor(middle)]
}

/** port-*-latency, from a listing of ports.ps1. */
export function latencyAnswer(listing) {
  if ('error' in listing) return { answer: null, detail: listing.error }
  const { durationsMs } = listing
  if (durationsMs.length !== LATENCY_CALLS) return { answer: null, detail: `expected ${LATENCY_CALLS} durations, got ${durationsMs.length}` }
  const [middle, slowest] = [median(durationsMs), Math.max(...durationsMs)]
  if (middle <= LATENCY_MEDIAN_MS && slowest <= LATENCY_SLOWEST_MS) return { answer: 'yes', detail: '' }
  return { answer: 'no', detail: `the median is ${middle.toFixed(1)} ms and the slowest ${slowest.toFixed(1)} ms` }
}

/** The owners that exist and could not be read, each with what is missing. */
export function unreadableOwners(owners) {
  return owners
    .filter((o) => !o.Gone && (o.Name === null || o.Created === null))
    .map((o) => ({ pid: o.Pid, name: o.Name, ...(o.NameError === null ? {} : { nameError: o.NameError }), ...(o.CreatedError === null ? {} : { createdError: o.CreatedError }) }))
}

/** port-owner-identity. The helper must be among the owners, or the table was not the machine's. */
export function ownerAnswer({ section, helperPid }) {
  if ('error' in section) return { answer: null, detail: section.error }
  if (!section.rows.some((o) => o.Pid === helperPid && !o.Gone)) return { answer: null, detail: `the listener's owner, PID ${helperPid}, is not among the owners read` }
  const unreadable = unreadableOwners(section.rows)
  if (unreadable.length === 0) return { answer: 'yes', detail: '' }
  const shown = unreadable.map((o) => `PID ${o.pid}${o.name === null ? '' : ` (${o.name})`}`).join(', ')
  return { answer: 'no', detail: `${unreadable.length} of ${section.rows.length} owners could not be read: ${shown}` }
}

const isListing = (value) =>
  Array.isArray(value?.durationsMs) &&
  value.durationsMs.every((ms) => typeof ms === 'number' && Number.isFinite(ms)) &&
  Array.isArray(value?.rows) &&
  value.rows.every((row) => typeof row?.address === 'string' && Number.isInteger(row?.port) && Number.isInteger(row?.pid))

const isOwners = (value) =>
  Array.isArray(value?.rows) &&
  value.rows.every(
    (o) =>
      Number.isInteger(o?.Pid) &&
      typeof o?.Gone === 'boolean' &&
      [o?.Name, o?.NameError, o?.Created, o?.CreatedError].every((field) => field === null || typeof field === 'string'),
  )

/** A section of ports.ps1's output, or `{ error }` if it failed or has the wrong shape. */
const section = (value, valid, name) => {
  if (typeof value?.error === 'string') return { error: value.error }
  return valid(value) ? value : { error: `ports.ps1's ${name} section is malformed` }
}

/** ports.ps1's output as `{ ps, api, owners }`; each failed section, or all of them, is `{ error }`. */
export function portsResult({ fileText, run }) {
  const failed = (error) => ({ ps: { error }, api: { error }, owners: { error } })
  const exit = `ports.ps1 ${describeExit(run)}`
  if (fileText === undefined) return failed(`${exit} and wrote no result file: ${oneLine(run.stderr)}`)
  let value
  try {
    value = JSON.parse(fileText.replace(/^﻿/, ''))
  } catch {
    return failed(`${exit} and its result file is not JSON`)
  }
  if (typeof value?.error === 'string') return failed(value.error)
  if (run.code !== 0) return failed(`${exit} and its result is not usable`)
  return { ps: section(value?.ps, isListing, 'ps'), api: section(value?.api, isListing, 'api'), owners: section(value?.owners, isOwners, 'owners') }
}

/** What `data` shows of a listing: its rows on the listeners' ports, so a miss can be read, not the machine's. */
const rowsFor = (listing, listeners) => ('error' in listing ? null : listing.rows.filter((row) => listeners.some((l) => l.port === row.port)))

const durationsFor = (listing) => ('error' in listing ? null : listing.durationsMs.map((ms) => Math.round(ms * 10) / 10))

/**
 * Every answer of a driver started for `user`, by check ID, from the measurements: `listener` is
 * `{ pid, listeners }`, `netstat` a listing (administrator only), `script` ports.ps1's output.
 */
export function portAnswers({ user, listener, netstat, script }) {
  const { pid: helperPid, listeners } = listener
  const suffix = user === 'standard' ? '-std' : ''
  const where = { helperPid, listeners }
  const answerFor = (method, listing) => listenerAnswer({ method, listing, listeners, helperPid })
  const methods = {
    ...(netstat === undefined ? {} : { netstat: answerFor('netstat', netstat) }),
    'Get-NetTCPConnection': answerFor('Get-NetTCPConnection', script.ps),
    GetExtendedTcpTable: answerFor('GetExtendedTcpTable', script.api),
  }
  const owners = ownerAnswer({ section: script.owners, helperPid })
  const ownerRows = 'error' in script.owners ? null : script.owners.rows
  return {
    [`port-control${suffix}`]: { ...controlAnswer(methods), data: { ...where, methods: Object.fromEntries(Object.entries(methods).map(([name, result]) => [name, result.answer])) } },
    ...(netstat === undefined ? {} : { 'port-netstat': { ...methods.netstat, data: { ...where, rows: rowsFor(netstat, listeners) } } }),
    [`port-ps${suffix}`]: { ...methods['Get-NetTCPConnection'], data: { ...where, rows: rowsFor(script.ps, listeners) } },
    [`port-api${suffix}`]: { ...methods.GetExtendedTcpTable, data: { ...where, rows: rowsFor(script.api, listeners) } },
    [`port-owner-identity${suffix}`]: {
      ...owners,
      data: {
        ownersRead: ownerRows?.length ?? null,
        ownersGone: ownerRows?.filter((o) => o.Gone).map((o) => o.Pid) ?? null,
        ownersUnreadable: ownerRows === null ? null : unreadableOwners(ownerRows),
      },
    },
    ...(user === 'standard'
      ? {
          'port-ps-latency': { ...latencyAnswer(script.ps), data: { durationsMs: durationsFor(script.ps) } },
          'port-api-latency': { ...latencyAnswer(script.api), data: { durationsMs: durationsFor(script.api) } },
        }
      : {}),
  }
}

/** Starts port-listener.mjs, and resolves with `{ pid, listeners, alive, stop }` once it listens. */
export function startListener({ addresses = LISTEN_ADDRESSES, timeoutMs = LISTENER_START_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [LISTENER, ...addresses], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    // A listener that already ended must not fail the driver when its stdin is closed.
    child.stdin.on('error', () => {})
    let stdout = ''
    let stderr = ''
    const refuse = (reason) => {
      clearTimeout(timer)
      child.kill()
      reject(new Error(`the listener ${reason}: ${oneLine(stderr)}`))
    }
    const timer = setTimeout(() => refuse(`did not listen within ${timeoutMs / 1000} s`), timeoutMs)
    const alive = () => child.exitCode === null && child.signalCode === null
    const stop = () =>
      new Promise((done) => {
        if (!alive()) {
          done()
          return
        }
        const force = setTimeout(() => child.kill(), LISTENER_STOP_MS)
        child.once('close', () => {
          clearTimeout(force)
          done()
        })
        child.stdin.end()
      })
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')))
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
      const end = stdout.indexOf('\n')
      if (end === -1) return
      child.stdout.removeAllListeners('data')
      child.stdout.resume()
      child.removeAllListeners('close')
      clearTimeout(timer)
      try {
        const { listeners } = JSON.parse(stdout.slice(0, end))
        resolve({ pid: child.pid, listeners, alive, stop })
      } catch {
        refuse('printed no JSON line')
      }
    })
    child.once('error', (error) => refuse(`did not start (${error.message})`))
    child.once('close', () => refuse('ended before it listened'))
  })
}

async function readPorts() {
  const dir = mkdtempSync(join(tmpdir(), 'veydr-probe-ports-'))
  try {
    const outFile = join(dir, 'ports.json')
    const script = fileURLToPath(new URL('./ports.ps1', import.meta.url))
    const run = await runProgram(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-OutFile', outFile, '-Calls', String(LATENCY_CALLS)], { timeoutMs: SCRIPT_MS })
    let fileText
    try {
      fileText = readFileSync(outFile, 'utf8')
    } catch {
      fileText = undefined
    }
    if (noAnswer(run, SCRIPT_MS) !== undefined) return portsResult({ fileText: undefined, run })
    return portsResult({ fileText, run })
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

async function measure(user) {
  const listener = await startListener()
  try {
    const netstat = user === 'admin' ? netstatListing(await runProgram(system32('netstat.exe'), ['-ano'], { timeoutMs: NETSTAT_MS })) : undefined
    const script = await readPorts()
    // Without the listener a method's miss would read as a `no` about that method.
    if (!listener.alive()) throw new Error('the listener ended during the measurements')
    return portAnswers({ user, listener, netstat, script })
  } finally {
    await listener.stop()
  }
}

async function probePorts(report, user, ids) {
  let answers
  let failure
  try {
    answers = await measure(user)
  } catch (error) {
    failure = `the probe failed: ${error instanceof Error ? error.message : String(error)}`
  }
  for (const id of ids) {
    const result = answers?.[id] ?? { answer: null, detail: failure ?? `ports.mjs has no answer for ${id}`, data: {} }
    report(id, result.answer, result.detail, result.data)
  }
}

/** Runs the driver for a parsed command line; `options` are passed on to runDriver (tests). */
export async function runPorts(args, options = {}) {
  const { user, unavailable, positional } = parseDriverArgs(args)
  if (positional.length > 0) throw new DriverUsageError(`expected no positional arguments, got ${JSON.stringify(positional)}`)
  const ids = placeholderIds(AREA, user)
  await runDriver({ ...options, area: AREA, user, ids, unavailable, probe: (report) => probePorts(report, user, ids) })
}

if (isEntryPoint(import.meta.url)) driverMain('ports.mjs', runPorts)
