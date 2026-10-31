#!/usr/bin/env node
// helper-csc-build (task 4.4, design D2), the evidence for gate G-4 option C: does the csc.exe of
// .NET Framework 4.8 compile job-helper.cs, and does the helper, started from this console-less
// driver, end a child and its grandchild through a Job Object? The binary goes to a temporary
// directory and is never committed.
//
//   node scripts/windows-probe/helper-build.mjs --user admin|standard [--unavailable <reason>]
//
// is started by launch-detached.mjs and writes the result lines to stdout. Exit codes: 0 written,
// 1 failure, 2 usage error.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DriverUsageError, driverMain, isEntryPoint, parseDriverArgs, runDriver, runProgram } from './driver.mjs'
import { placeholderIds } from './placeholder.mjs'
import { readyFile, specFile, workerCommand, writeAtomic } from './tree-files.mjs'

const AREA = 'helper'
const COMPILE_MS = 60_000
/** The helper's own waits (60 s for the tree, 10 s for the job to empty, twice) and a margin. */
const HELPER_MS = 100_000

export const compilerPath = (windir = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows') => join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')

/** The version in csc.exe's banner, which it prints when /nologo is not given. */
export function compilerVersion(output) {
  return /compiler version ([\d.]+)/i.exec(output)?.[1] ?? null
}

/** The helper's JSON line, or undefined. */
export function helperReport(stdout) {
  try {
    const value = JSON.parse(stdout.trim().split('\n').at(-1) ?? '')
    return typeof value === 'object' && value !== null ? value : undefined
  } catch {
    return undefined
  }
}

/** Compiles `<name>.cs` from this directory into `dir`, and resolves with the binary's path and csc.exe's result. */
export async function compileHelper(name, dir) {
  const compiler = compilerPath()
  const source = join(dir, `${name}.cs`)
  const binary = join(dir, `${name}.exe`)
  copyFileSync(fileURLToPath(new URL(`./${name}.cs`, import.meta.url)), source)
  const result = existsSync(compiler)
    ? await runProgram(compiler, ['/target:exe', `/out:${binary}`, source], { timeoutMs: COMPILE_MS, cwd: dir })
    : { code: null, signal: null, stdout: '', stderr: '', error: `${compiler} does not exist` }
  return { compiler, binary, result }
}

export const describeExit = ({ code, signal, error }) => error ?? `exited with ${signal ?? String(code)}`
const oneLine = (text) => text.replace(/\s+/g, ' ').trim().slice(0, 500)

/** The answer from each step; `alive` lists the names of the tree's processes still running. */
export function buildAnswer({ compile, run, report, tree, alive }) {
  if (compile.code !== 0) return { answer: 'no', detail: `csc.exe ${describeExit(compile)}: ${oneLine(`${compile.stdout}${compile.stderr}`)}` }
  if (run.code !== 0) return { answer: 'no', detail: `the helper ${describeExit(run)}: ${oneLine(run.stderr)}` }
  if (report === undefined) return { answer: 'no', detail: `the helper printed no report: ${oneLine(run.stdout)}` }
  if (report.inJob !== true) return { answer: 'no', detail: 'the helper\'s child was not in its job' }
  if (tree === undefined) return { answer: 'no', detail: 'the child and grandchild did not record their PIDs' }
  if (alive.length > 0) return { answer: 'no', detail: `still running after the job ended: ${alive.join(', ')}` }
  return { answer: 'yes', detail: '' }
}

const isRunning = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The PIDs the worker tree recorded, or undefined. */
function readTree(dir) {
  try {
    const child = JSON.parse(readFileSync(readyFile(dir, 'helper-child'), 'utf8'))
    return { 'helper-child': child.pid, 'helper-grandchild': child.children['helper-grandchild'] }
  } catch {
    return undefined
  }
}

async function buildAndRun(dir) {
  const { compiler, binary, result: compile } = await compileHelper('job-helper', dir)
  const data = { compiler, compilerVersion: compilerVersion(compile.stdout), compilerExitCode: compile.code }
  const empty = { code: null, signal: null, stdout: '', stderr: '' }
  if (compile.code !== 0) return { ...buildAnswer({ compile, run: empty, alive: [] }), data }

  const spec = specFile(dir, 'helper-child')
  writeAtomic(spec, JSON.stringify({ dir, name: 'helper-child', children: [{ name: 'helper-grandchild' }] }))
  const run = await runProgram(binary, [readyFile(dir, 'helper-child'), process.execPath, workerCommand(spec)], { timeoutMs: HELPER_MS, cwd: dir })
  const report = helperReport(run.stdout)
  const tree = readTree(dir)
  const alive = tree === undefined ? [] : Object.entries(tree).filter(([, pid]) => isRunning(pid)).map(([name]) => name)
  const result = buildAnswer({ compile, run, report, tree, alive })
  return { ...result, data: { ...data, helperExitCode: run.code, helper: report ?? null, processes: tree ?? null, } }
}

async function probeHelper(id, report) {
  const dir = mkdtempSync(join(tmpdir(), 'veydr-probe-helper-'))
  try {
    const { answer, detail, data } = await buildAndRun(dir)
    report(id, answer, detail, data)
  } catch (error) {
    report(id, null, `the probe failed: ${error instanceof Error ? error.message : String(error)}`, {})
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

/** Runs the driver for a parsed command line; `options` are passed on to runDriver (tests). */
export async function runHelperBuild(args, options = {}) {
  const { user, unavailable, positional } = parseDriverArgs(args)
  if (positional.length > 0) throw new DriverUsageError(`expected no positional arguments, got ${JSON.stringify(positional)}`)
  const ids = placeholderIds(AREA, user)
  const [id] = ids
  await runDriver({ ...options, area: AREA, user, ids, unavailable, probe: (report) => probeHelper(id, report) })
}

if (isEntryPoint(import.meta.url)) driverMain('helper-build.mjs', runHelperBuild)
