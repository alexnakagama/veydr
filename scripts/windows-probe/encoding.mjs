#!/usr/bin/env node
// The encoding probes (task 5.3, design D3): what bytes a console child's output reaches Veydr as.
// Every child starts with `windowsHide: true` from this console-less driver, so it has a hidden
// console of its own, as W1 would start it, and its output is piped, as the supervisor reads it.
//
//   node scripts/windows-probe/encoding.mjs --user admin [--unavailable <reason>]
//
// is started by launch-detached.mjs and writes the result lines to stdout. Exit codes: 0 written,
// 1 failure, 2 usage error.
import { fileURLToPath } from 'node:url'
import { ENCODING_TEST_STRING, ENCODING_TOOLS, ENCODING_VARIANTS } from './checks.mjs'
import { DriverUsageError, driverMain, isEntryPoint, noAnswer, parseDriverArgs, reportCheck, runDriver, runProgram, system32, windowsPowerShell } from './driver.mjs'
import { describeExit, helperReport, oneLine } from './helper-build.mjs'
import { placeholderIds } from './placeholder.mjs'

const AREA = 'encoding'
const CHILD_MS = 30_000
/** Add-Type compiles the script's C# first, which takes seconds, longer on a busy runner. */
const SCRIPT_MS = 60_000
const UTF8_CODE_PAGE = 65001

/** The test string as an ASCII string literal for JavaScript and Python, so no command line carries it raw. */
export const asciiLiteral = (text) => `'${text.replace(/[^\x20-\x7e]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)}'`

/** `env` without the variables that set Python's encoding, under any spelling. */
const withoutPythonEncoding = (env) => Object.fromEntries(Object.entries(env).filter(([name]) => !['PYTHONUTF8', 'PYTHONIOENCODING'].includes(name.toUpperCase())))

/** `line` for runProgram on cmd.exe, verbatim, with the outer quotes that `/s` removes, so Node adds no quoting of its own. */
const onCmd = (cmd, line) => ({ file: cmd, args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } })

/** How `tool` prints `text` in `variant`: `{ file, args, options }` for runProgram. */
export function encodingCommand(tool, variant, { text, node, cmd, env }) {
  const write = `process.stdout.write(${asciiLiteral(text)})`
  if (tool === 'cmd') return onCmd(cmd, `${variant === 'utf8' ? 'chcp 65001>nul & ' : ''}echo ${text}`)
  if (tool === 'node') return variant === 'utf8' ? onCmd(cmd, `chcp 65001>nul & "${node}" -e "${write}"`) : { file: node, args: ['-e', write], options: {} }
  if (tool === 'python') {
    const pythonEnv = variant === 'utf8' ? { ...withoutPythonEncoding(env), PYTHONUTF8: '1' } : withoutPythonEncoding(env)
    return { file: 'python', args: ['-c', `print(${asciiLiteral(text)})`], options: { env: pythonEnv } }
  }
  throw new Error(`encoding.mjs does not know how to run ${tool}`)
}

/**
 * What explains enc-child-cmd-utf8, which run 41271095296 could not: whether `chcp` changed the
 * console, and whether a new cmd.exe on that console writes UTF-8 where the one that ran `chcp` did not.
 */
export const chcpDiagnosticCommands = ({ text, cmd }) => ({
  active: onCmd(cmd, 'chcp 65001>nul & chcp'),
  nested: onCmd(cmd, `chcp 65001>nul & "${cmd}" /d /c echo ${text}`),
})

/** The code page in what `chcp` printed, in any language, or null. */
export const activeCodePage = (stdout) => {
  const found = /(\d+)\D*$/.exec(stdout.trim())
  return found === null ? null : Number(found[1])
}

/**
 * enc-child-*: `bytes` is the child's stdout. One line ending is its own, not the string's. A child
 * that failed to print, as Python does for a character its code page lacks, gets the same answer.
 */
export function encodingAnswer({ run, bytes, expected }) {
  const unanswered = noAnswer(run, CHILD_MS)
  if (unanswered !== undefined) return unanswered
  const exit = run.code === 0 ? '' : ` (it ${describeExit(run)})`
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return { answer: 'no', detail: `the output is not valid UTF-8${exit}` }
  }
  const line = text.replace(/\r?\n$/, '')
  return line === expected ? { answer: 'yes', detail: '' } : { answer: 'no', detail: `the output decodes to ${JSON.stringify(line)}${exit}` }
}

/** codepages.ps1's report as `{ acp, oemcp, consoleOutputCP }`, or undefined. */
export function parseCodePages(stdout) {
  const report = helperReport(stdout)
  return report !== undefined && ['acp', 'oemcp', 'consoleOutputCP'].every((field) => typeof report[field] === 'number') ? report : undefined
}

/** enc-codepages: `hidden` is the report of a child started with `windowsHide: true`. */
export function codePagesAnswer({ hidden, run }) {
  if (hidden === undefined) return { answer: null, detail: `codepages.ps1 ${describeExit(run)} with no report: ${oneLine(run.stderr)}` }
  if (hidden.consoleOutputCP === 0) return { answer: null, detail: 'the child has no console: GetConsoleOutputCP returned 0' }
  return hidden.consoleOutputCP === UTF8_CODE_PAGE ? { answer: 'yes', detail: '' } : { answer: 'no', detail: `the console output code page is ${hidden.consoleOutputCP}` }
}

const runCodePages = (windowsHide) => {
  const script = fileURLToPath(new URL('./codepages.ps1', import.meta.url))
  return runProgram(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide, timeoutMs: SCRIPT_MS })
}

async function codePages() {
  const [hiddenRun, shownRun] = [await runCodePages(true), await runCodePages(false)]
  const hidden = parseCodePages(hiddenRun.stdout)
  const shown = parseCodePages(shownRun.stdout)
  return {
    ...codePagesAnswer({ hidden, run: hiddenRun }),
    data: {
      windowsHide: hidden ?? null,
      noWindowsHide: shown ?? `codepages.ps1 ${describeExit(shownRun)}`,
    },
  }
}

/** Python's version, or why there is none: a `python` that runs but is not Python counts as not installed. */
async function findPython() {
  const run = await runProgram('python', ['--version'], { timeoutMs: CHILD_MS })
  return run.code === 0 && /^Python \d/.test(run.stdout.trim()) ? { version: run.stdout.trim() } : { missing: `Python is not installed: python --version ${describeExit(run)}` }
}

/** `data` for enc-child-cmd-utf8. A diagnostic that fails says so here and never costs the check's answer. */
async function chcpDiagnostics() {
  try {
    return await measureChcp()
  } catch (error) {
    return { chcpDiagnosticError: error instanceof Error ? error.message : String(error) }
  }
}

async function measureChcp() {
  const { active, nested } = chcpDiagnosticCommands({ text: ENCODING_TEST_STRING, cmd: system32('cmd.exe') })
  const activeRun = await runProgram(active.file, active.args, { ...active.options, timeoutMs: CHILD_MS })
  const nestedRun = await runProgram(nested.file, nested.args, { ...nested.options, timeoutMs: CHILD_MS })
  const bytes = Buffer.from(nestedRun.stdout, 'latin1')
  return {
    chcpActiveCodePage: activeCodePage(activeRun.stdout),
    nestedCmd: { hex: bytes.toString('hex'), exitCode: nestedRun.code, decodes: encodingAnswer({ run: nestedRun, bytes, expected: ENCODING_TEST_STRING }).answer },
  }
}

async function childEncoding(tool, variant, python) {
  const where = { tool, variant, windowsHide: true }
  if (tool === 'python' && python.missing !== undefined) return { answer: null, detail: python.missing, data: where }
  const { file, args, options } = encodingCommand(tool, variant, { text: ENCODING_TEST_STRING, node: process.execPath, cmd: system32('cmd.exe'), env: process.env })
  const run = await runProgram(file, args, { ...options, timeoutMs: CHILD_MS })
  // runProgram reads output as Latin-1, which maps each byte to one character and back unchanged.
  const bytes = Buffer.from(run.stdout, 'latin1')
  return {
    ...encodingAnswer({ run, bytes, expected: ENCODING_TEST_STRING }),
    data: { ...where, hex: bytes.toString('hex'), exitCode: run.code, stderr: oneLine(run.stderr), ...(tool === 'python' ? { python: python.version } : {}), ...(tool === 'cmd' && variant === 'utf8' ? await chcpDiagnostics() : {}) },
  }
}

async function probeEncoding(report) {
  await reportCheck(report, 'enc-codepages', codePages)
  const python = await findPython()
  for (const tool of Object.keys(ENCODING_TOOLS)) {
    for (const variant of Object.keys(ENCODING_VARIANTS)) await reportCheck(report, `enc-child-${tool}-${variant}`, () => childEncoding(tool, variant, python))
  }
}

/** Runs the driver for a parsed command line; `options` are passed on to runDriver (tests). */
export async function runEncoding(args, options = {}) {
  const { user, unavailable, positional } = parseDriverArgs(args)
  if (positional.length > 0) throw new DriverUsageError(`expected no positional arguments, got ${JSON.stringify(positional)}`)
  const ids = placeholderIds(AREA, user)
  await runDriver({ ...options, area: AREA, user, ids, unavailable, probe: probeEncoding })
}

if (isEntryPoint(import.meta.url)) driverMain('encoding.mjs', runEncoding)
