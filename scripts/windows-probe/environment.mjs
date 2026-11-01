#!/usr/bin/env node
// The environment probes (task 5.2, design D3): whether a process's inherited environment is the
// registry's, and what a child sees of a path variable by its spelling. Variable values never reach
// a result line, only names do; the one exception is the markers of env-path-case, which are the
// probe's own.
//
//   node scripts/windows-probe/environment.mjs --user admin|standard [--unavailable <reason>]
//
// is started by launch-detached.mjs, and by standard-user.ps1 for the standard user, and writes the
// result lines to stdout. Exit codes: 0 written, 1 failure, 2 usage error.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DriverUsageError, driverMain, isEntryPoint, parseDriverArgs, reportCheck, runDriver, runProgram, windowsPowerShell } from './driver.mjs'
import { describeExit, oneLine } from './helper-build.mjs'
import { placeholderIds } from './placeholder.mjs'

const AREA = 'environment'
const ENV_REGISTRY = 'env-registry'
const ENV_PATH_CASE = 'env-path-case'
const SCRIPT_MS = 60_000
const CHILD_MS = 30_000

/** Prints the child's path variables as `[[name, value], …]`. */
const PRINT_PATH_VARIABLES = "console.log(JSON.stringify(Object.entries(process.env).filter(([name]) => name.toUpperCase() === 'PATH')))"

const isPathName = (name) => name.toUpperCase() === 'PATH'
const sorted = (names) => [...names].sort((a, b) => a.localeCompare(b))

/**
 * The environment the registry defines, by upper-case name, as `{ name, value }`: user over machine,
 * except `Path`, which is the machine value followed by the user value (design D3). Windows adds no
 * second `;` after a machine value ending in one.
 */
export function registryEnvironment(machine, user) {
  const merged = new Map()
  for (const [name, value] of Object.entries(machine)) merged.set(name.toUpperCase(), { name, value })
  for (const [name, value] of Object.entries(user)) {
    const key = name.toUpperCase()
    const base = merged.get(key)
    if (isPathName(name) && base !== undefined) merged.set(key, { name: base.name, value: base.value.endsWith(';') ? `${base.value}${value}` : `${base.value};${value}` })
    else merged.set(key, { name, value })
  }
  return merged
}

/** The names, never the values, of what differs between the registry's environment and an inherited one. */
export function compareEnvironment(registry, inherited) {
  // Variables named with a leading `=` are cmd.exe's per-drive directories, not an environment.
  const entries = Object.entries(inherited).filter(([name, value]) => !name.startsWith('=') && value !== undefined)
  const seen = new Set(entries.map(([name]) => name.toUpperCase()))
  const different = entries.filter(([name, value]) => registry.has(name.toUpperCase()) && registry.get(name.toUpperCase()).value !== value).map(([name]) => name)
  return {
    compared: entries.filter(([name]) => registry.has(name.toUpperCase())).length,
    different: sorted(different),
    onlyInRegistry: sorted([...registry].filter(([key]) => !seen.has(key)).map(([, { name }]) => name)),
    onlyInherited: sorted(entries.filter(([name]) => !registry.has(name.toUpperCase())).map(([name]) => name)),
  }
}

/** env-registry, from compareEnvironment. */
export function registryAnswer({ compared, different }) {
  if (compared === 0) return { answer: null, detail: 'no variable is defined both in the registry and in the driver\'s environment' }
  return different.length === 0 ? { answer: 'yes', detail: '' } : { answer: 'no', detail: `different values for ${different.join(', ')}` }
}

const isStringMap = (value) => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every((v) => typeof v === 'string')

/** registry-env.ps1's output as `{ machine, user }`, or `{ error }` saying why there is none. */
export function registryResult({ fileText, run }) {
  const exit = `registry-env.ps1 ${describeExit(run)}`
  if (fileText === undefined) return { error: `${exit} and wrote no result file: ${oneLine(run.stderr)}` }
  let value
  try {
    value = JSON.parse(fileText.replace(/^\uFEFF/, ''))
  } catch {
    return { error: `${exit} and its result file is not JSON` }
  }
  if (typeof value?.error === 'string') return { error: value.error }
  if (run.code !== 0 || !isStringMap(value?.machine) || !isStringMap(value?.user)) return { error: `${exit} and its result is not usable` }
  return { machine: value.machine, user: value.user }
}

/** `env` without a path variable under any spelling. */
export const withoutPath = (env) => Object.fromEntries(Object.entries(env).filter(([name]) => !isPathName(name)))

/** The path variables a child printed, as `[[name, value], …]`, or undefined. */
export function parseSeen(stdout) {
  try {
    const seen = JSON.parse(stdout.trim())
    return Array.isArray(seen) && seen.every((entry) => Array.isArray(entry) && entry.length === 2 && entry.every((part) => typeof part === 'string')) ? seen : undefined
  } catch {
    return undefined
  }
}

/** What `data` may show of `seen`: only the probe's own markers, so no real value reaches a result file. */
export const seenForData = (seen, markers) => seen.map(([name, value]) => ({ name, value: markers.includes(value) ? value : '(not a marker)' }))

/** env-path-case: `seen` is what the child printed, or undefined. */
export function pathCaseAnswer({ seen, marker }) {
  if (seen === undefined) return { answer: null, detail: 'the child did not report its environment' }
  if (seen.length !== 1) return { answer: 'no', detail: `the child sees ${seen.length} path variables: ${seen.map(([name]) => name).join(', ')}` }
  return seen[0][1] === marker ? { answer: 'yes', detail: '' } : { answer: 'no', detail: `the child's ${seen[0][0]} does not hold the marker` }
}

async function readRegistry() {
  const dir = mkdtempSync(join(tmpdir(), 'veydr-probe-environment-'))
  try {
    const outFile = join(dir, 'registry.json')
    const script = fileURLToPath(new URL('./registry-env.ps1', import.meta.url))
    const run = await runProgram(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-OutFile', outFile], { timeoutMs: SCRIPT_MS })
    let fileText
    try {
      fileText = readFileSync(outFile, 'utf8')
    } catch {
      fileText = undefined
    }
    return registryResult({ fileText, run })
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

async function envRegistry() {
  const registry = await readRegistry()
  if ('error' in registry) return { answer: null, detail: registry.error, data: {} }
  const comparison = compareEnvironment(registryEnvironment(registry.machine, registry.user), process.env)
  return { ...registryAnswer(comparison), data: comparison }
}

/** Starts a child with `env`, and resolves with the path variables it printed, or undefined. */
async function pathVariablesSeenWith(env) {
  const run = await runProgram(process.execPath, ['-e', PRINT_PATH_VARIABLES], { env, timeoutMs: CHILD_MS })
  return { run, seen: parseSeen(run.stdout) }
}

async function envPathCase() {
  const [marker, mixed, upper] = ['only', 'mixed', 'upper'].map((name) => `C:\\veydr-probe-marker-${name}`)
  const base = withoutPath(process.env)
  const only = await pathVariablesSeenWith({ ...base, PATH: marker })
  const both = await pathVariablesSeenWith({ ...base, Path: mixed, PATH: upper })
  return {
    ...pathCaseAnswer({ seen: only.seen, marker }),
    data: {
      inheritedSpelling: Object.keys(process.env).filter(isPathName),
      seenWithPath: only.seen === undefined ? `the child ${describeExit(only.run)}` : seenForData(only.seen, [marker]),
      seenWithBoth: both.seen === undefined ? `the child ${describeExit(both.run)}` : seenForData(both.seen, [mixed, upper]),
    },
  }
}

/** Runs the driver for a parsed command line; `options` are passed on to runDriver (tests). */
export async function runEnvironment(args, options = {}) {
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
      await reportCheck(report, user === 'standard' ? `${ENV_REGISTRY}-std` : ENV_REGISTRY, envRegistry)
      if (ids.includes(ENV_PATH_CASE)) await reportCheck(report, ENV_PATH_CASE, envPathCase)
    },
  })
}

if (isEntryPoint(import.meta.url)) driverMain('environment.mjs', runEnvironment)
