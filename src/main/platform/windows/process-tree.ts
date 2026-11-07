import { execFile, spawn as spawnChild } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { DEFAULT_STOP_TIMEOUT_MS } from '../../../shared/config'
import { SpawnError } from '../errors'
import type { LedgerEntry, ProcessIdentity, ProcessTree, SpawnPlan, StopResult, Survivor } from '../types'
import { helperLaunch, isFullyQualified } from './command-line'
import {
  HELPER_KILL_WAIT_MS,
  procInfo,
  startHelperRun,
  STOP_MARGIN_MS,
  type HelperClientOptions,
  type SpawnHelper,
  type WindowsManagedProcess,
} from './helper-client'
import { parseWindowsIdentity, windowsIdentity } from './identity'
import {
  encodeIdentities,
  MAX_GRACE_MS,
  MAX_TOOL_IDENTITIES,
  MAX_TOOL_OUTPUT_BYTES,
  parseInspectOutput,
  parseTerminateOutput,
  PROTOCOL_VERSION,
  ProtocolError,
  type HelperMember,
  type WindowsProcessRef,
} from './protocol'

/** Reads what `veydr-helper.exe version` prints; rejects if it cannot be run. */
export type ReadHelperVersion = (helperPath: string) => Promise<string>

export interface WindowsProcessTreeOptions extends HelperClientOptions {
  /** `veydr-helper.exe version` outside tests. */
  readonly readHelperVersion?: ReadHelperVersion
  /** Time survivors get to end after Ctrl+Break (the default stop timeout, 5 s). */
  readonly survivorGraceMs?: number
  /** How long `veydr-helper.exe inspect` may take. */
  readonly inspectTimeoutMs?: number
  /** This process; never reported or ended. */
  readonly selfPid?: number
}

/** The Windows process tree; its runs also report the console the helper gave them. */
export interface WindowsProcessTree extends Pick<ProcessTree, 'findSurvivors' | 'terminateSurvivors'> {
  spawn(plan: SpawnPlan): Promise<WindowsManagedProcess>
}

/** How long `veydr-helper.exe version` may take. */
export const VERSION_TIMEOUT_MS = 10_000

/** How long `veydr-helper.exe inspect` may take. */
export const INSPECT_TIMEOUT_MS = 30_000

/** Most bytes of a subcommand's stderr kept for its error message. */
const MAX_TOOL_STDERR_BYTES = 4096

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export { isFullyQualified }

/** Runs `<helper> version`, hidden, and resolves with its stdout. */
export const runHelperVersion: ReadHelperVersion = (helperPath) =>
  new Promise((resolve, reject) => {
    execFile(
      helperPath,
      ['version'],
      { encoding: 'utf8', windowsHide: true, timeout: VERSION_TIMEOUT_MS, maxBuffer: 1024, shell: false },
      (error: Error | null, stdout: string) => (error === null ? resolve(stdout) : reject(error)),
    )
  })

/**
 * Windows process trees (add-windows-process-supervision design D1): each command runs through its
 * own `veydr-helper.exe run`, which holds the command's Job Object. `spawn` refuses, before any
 * process of the command exists, a helper that is missing or speaks another protocol version
 * (design D5). The helper's version is read once per helper file, and again after it changes.
 */
export function createWindowsProcessTree(options: WindowsProcessTreeOptions): WindowsProcessTree {
  const selfPid = options.selfPid ?? process.pid
  const survivorGraceMs = options.survivorGraceMs ?? DEFAULT_STOP_TIMEOUT_MS
  const inspectTimeoutMs = options.inspectTimeoutMs ?? INSPECT_TIMEOUT_MS
  const stopMarginMs = options.stopMarginMs ?? STOP_MARGIN_MS
  requireMs('survivorGraceMs', survivorGraceMs, 0)
  requireMs('inspectTimeoutMs', inspectTimeoutMs, 1)
  requireMs('stopMarginMs', stopMarginMs, 0)
  const readVersion = options.readHelperVersion ?? runHelperVersion
  /** The checked helper file (size and modification time) and its check, shared by concurrent spawns. */
  let checked: { readonly key: string; readonly result: Promise<void> } | null = null

  async function checkHelper(): Promise<void> {
    const { helperPath } = options
    if (helperPath === '') throw new SpawnError('other', 'The Windows helper path is not configured')
    // A bare name would be looked up on PATH.
    if (!isFullyQualified(helperPath)) throw new SpawnError('other', `The Windows helper path must be absolute: ${helperPath}`)
    let key: string
    try {
      const info = await stat(helperPath)
      if (!info.isFile()) throw new Error('not a file')
      key = `${info.size}:${info.mtimeMs}`
    } catch {
      throw new SpawnError('other', `Windows helper not found: ${helperPath}`)
    }
    if (checked?.key !== key) {
      const result = verifyVersion(helperPath, readVersion)
      checked = { key, result }
      // A failed check is not remembered: the next spawn checks again.
      result.catch(() => {
        if (checked?.result === result) checked = null
      })
    }
    return checked.result
  }

  /**
   * Runs a survivor subcommand on `targets`, at most MAX_TOOL_IDENTITIES per call; `call` gives each
   * call's arguments and time limit when it starts. Every process an answer reports must be one
   * that call asked about.
   */
  async function runTool<T>(
    targets: ReadonlyMap<string, WindowsProcessRef>,
    call: () => { readonly args: readonly string[]; readonly timeoutMs: number },
    parse: (output: string) => T,
    reported: (answer: T) => readonly HelperMember[],
  ): Promise<T[]> {
    await checkHelper()
    const all = [...targets]
    const answers: T[] = []
    for (let start = 0; start < all.length; start += MAX_TOOL_IDENTITIES) {
      const chunk = new Map(all.slice(start, start + MAX_TOOL_IDENTITIES))
      const { args, timeoutMs } = call()
      const output = await runHelperTool(options.helperPath, args, encodeIdentities([...chunk.values()]), {
        spawnHelper: options.spawnHelper ?? spawnChild,
        timeoutMs,
      })
      const answer = parse(output)
      for (const m of reported(answer)) {
        if (!chunk.has(refKey(m))) throw new ProtocolError('malformed', `The Windows helper reported process ${m.pid}, which ${args[0] ?? ''} was not asked about`)
      }
      answers.push(answer)
    }
    return answers
  }

  /** The Windows identities among `identities`, without duplicates and without this process. */
  const targetsOf = (identities: Iterable<ProcessIdentity>): Map<string, WindowsProcessRef> => {
    const targets = new Map<string, WindowsProcessRef>()
    for (const identity of identities) {
      // Another platform's identity (e.g. a Linux ledger entry) names no Windows process.
      const parsed = parseWindowsIdentity(identity)
      if (parsed === null || parsed.pid === selfPid) continue
      targets.set(refKey(parsed), parsed)
    }
    return targets
  }

  return {
    async spawn(plan: SpawnPlan): Promise<WindowsManagedProcess> {
      // What the plan alone shows is refused before the helper's version is even read.
      checkPlanText(plan)
      await checkHelper()
      await checkPlanFiles(plan)
      return startHelperRun(plan, options)
    },

    /**
     * Crash recovery on Windows (design D4): a recorded process survives if a live process has
     * both its PID and its creation time, as `veydr-helper.exe inspect` reads them. Nothing is
     * opened for writing.
     */
    async findSurvivors(entries: readonly LedgerEntry[]): Promise<Survivor[]> {
      const targets = targetsOf(entries.flatMap((entry) => [entry.leader, ...entry.descendants]))
      if (targets.size === 0) return []
      const answers = await runTool(targets, () => ({ args: ['inspect'], timeoutMs: inspectTimeoutMs }), parseInspectOutput, (answer) => answer.processes)
      const alive = new Map(answers.flatMap((answer) => answer.processes).map((m) => [refKey(m), m]))

      const found = new Map<string, Survivor>()
      for (const entry of entries) {
        for (const identity of [entry.leader, ...entry.descendants]) {
          const parsed = parseWindowsIdentity(identity)
          if (parsed === null) continue
          const key = refKey(parsed)
          const m = alive.get(key)
          if (m === undefined || found.has(key)) continue
          found.set(key, { commandId: entry.commandId, runId: entry.runId, identity: windowsIdentity(m.pid, m.created), info: procInfo(m) })
        }
      }
      return [...found.values()]
    },

    /**
     * Ends survivors found by `findSurvivors` through `veydr-helper.exe terminate` (design D4): each
     * is re-verified, gets Ctrl+Break where its console holds only survivors, and is then ended
     * with `TerminateProcess` if it still matches. Survivors are in no job Veydr holds, so
     * processes they started meanwhile are not ended.
     *
     * More than MAX_TOOL_IDENTITIES survivors take several calls. The grace period counts from the
     * first call, so later calls get only what is left of it; and a console shared by survivors of
     * different calls looks foreign to each, so those survivors are ended without Ctrl+Break.
     */
    async terminateSurvivors(survivors: readonly Survivor[]): Promise<StopResult> {
      const targets = targetsOf(survivors.map((s) => s.identity))
      if (targets.size === 0) return { graceful: 'yes', forced: false, survivors: [] }
      const started = Date.now()
      const call = (): { args: string[]; timeoutMs: number } => {
        const graceMs = Math.max(0, survivorGraceMs - (Date.now() - started))
        // The helper sends no event once graceMs has passed, so it spends at most graceMs, one
        // event's delivery (1 s), and its kill wait (1 s).
        return { args: ['terminate', String(graceMs)], timeoutMs: graceMs + 2 * HELPER_KILL_WAIT_MS + stopMarginMs }
      }
      const answers = await runTool(targets, call, parseTerminateOutput, (answer) => answer.survivors)
      const left = answers.flatMap((answer) => answer.survivors).map(procInfo)
      if (left.length > 0) options.log?.record('warn', 'process.survivors', { pids: left.map((s) => s.pid) })
      return {
        graceful: answers.every((answer) => answer.graceful === 'yes') ? 'yes' : 'no',
        forced: answers.some((answer) => answer.forced),
        survivors: left,
      }
    },
  }
}

const refKey = (ref: WindowsProcessRef): string => `${ref.pid}:${ref.created}`

/** Largest delay `setTimeout` honours; longer ones fire at once. */
const MAX_TIMER_MS = 0x7fff_ffff

function requireMs(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min || value > MAX_GRACE_MS) {
    throw new RangeError(`${name} must be an integer from ${min} to ${MAX_GRACE_MS}: ${String(value)}`)
  }
}

/** `setTimeout` for any delay, also beyond MAX_TIMER_MS; returns its cancel function. */
function setLongTimeout(ms: number, cb: () => void): () => void {
  const deadline = Date.now() + ms
  let timer: NodeJS.Timeout
  const arm = (): void => {
    const left = Math.max(0, deadline - Date.now())
    timer = left > MAX_TIMER_MS ? setTimeout(arm, MAX_TIMER_MS) : setTimeout(cb, left)
  }
  arm()
  return () => clearTimeout(timer)
}

/**
 * Runs `<helper> <args>`, hidden and never detached, writes `input` on its stdin, and resolves with
 * its stdout once it exited with 0. Rejects if it cannot be started, exits otherwise, prints more
 * than MAX_TOOL_OUTPUT_BYTES, or takes longer than `timeoutMs` (it is then killed).
 */
export function runHelperTool(
  helperPath: string,
  args: readonly string[],
  input: string,
  { spawnHelper, timeoutMs }: { readonly spawnHelper: SpawnHelper; readonly timeoutMs: number },
): Promise<string> {
  const what = `The Windows helper's ${args[0] ?? ''}`
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnHelper(helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: false, shell: false })
    } catch (error) {
      reject(new Error(`${what} could not be started: ${messageOf(error)}`))
      return
    }
    const { stdin, stdout, stderr } = child
    let settled = false
    const finish = (error: Error | null, output = ''): void => {
      if (settled) return
      settled = true
      cancelTimer()
      if (error === null) return resolve(output)
      // Whatever it was doing, it must not go on unobserved.
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
      }
      reject(error)
    }
    const cancelTimer = setLongTimeout(timeoutMs, () => finish(new Error(`${what} did not finish within ${timeoutMs} ms`)))
    if (stdin === null || stdout === null || stderr === null) {
      finish(new Error(`${what} was started without pipes`))
      return
    }
    const out: Buffer[] = []
    let outBytes = 0
    let err = Buffer.alloc(0)
    child.on('error', (error) => finish(new Error(`${what} could not be run: ${error.message}`)))
    stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length
      if (outBytes > MAX_TOOL_OUTPUT_BYTES) return finish(new ProtocolError('line-too-long', `${what} printed more than ${MAX_TOOL_OUTPUT_BYTES} bytes`))
      out.push(chunk)
    })
    stderr.on('data', (chunk: Buffer) => {
      if (err.length < MAX_TOOL_STDERR_BYTES) err = Buffer.concat([err, chunk]).subarray(0, MAX_TOOL_STDERR_BYTES)
    })
    // The helper may exit before reading all of stdin (e.g. on a usage error); its exit says why.
    stdin.on('error', () => undefined)
    stdin.end(input)
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code !== 0) {
        const detail = err.toString('utf8').trim()
        return finish(new Error(`${what} failed (exit code ${String(code ?? signal)})${detail === '' ? '' : `: ${detail}`}`))
      }
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(out))
      } catch {
        return finish(new ProtocolError('malformed', `${what} output is not valid UTF-8`))
      }
      finish(null, text)
    })
  })
}

async function verifyVersion(helperPath: string, readVersion: ReadHelperVersion): Promise<void> {
  let output: string
  try {
    output = await readVersion(helperPath)
  } catch (error) {
    throw new SpawnError('other', `The Windows helper ${helperPath} could not report its protocol version: ${messageOf(error)}`)
  }
  const version = output.trim()
  if (version !== String(PROTOCOL_VERSION)) {
    const shown = /^[0-9]{1,9}$/.test(version) ? version : JSON.stringify(version.slice(0, 40))
    throw new SpawnError('other', `The Windows helper ${helperPath} speaks protocol version ${shown}, but Veydr needs version ${PROTOCOL_VERSION}`)
  }
}

/**
 * What the helper cannot report precisely: Node fails to start the helper itself for a missing
 * working directory, and that must not read as a missing helper. The helper also refuses a program
 * that is not given by its full path, so that nothing is looked up in the working directory, and a
 * command line it would refuse (`helperLaunch`).
 */
function checkPlanText(plan: SpawnPlan): void {
  const hasNul = (text: string): boolean => text.includes('\0')
  if (hasNul(plan.file) || hasNul(plan.cwd) || plan.args.some(hasNul) || (plan.commandLine !== undefined && hasNul(plan.commandLine))) {
    throw new SpawnError('other', `Could not start ${plan.file.replaceAll('\0', '\\0')}: the command contains a NUL character`)
  }
  if (!isFullyQualified(plan.file)) throw new SpawnError('executable-not-found', `Executable not found: ${plan.file} (a full path is needed)`)
  // The command line, before anything is read from disk: a batch file without one built for
  // cmd.exe, for one, is refused whether or not it exists (design D1).
  helperLaunch(plan)
}

/** The working directory and the program, as they are on disk. */
async function checkPlanFiles(plan: SpawnPlan): Promise<void> {
  let cwd
  try {
    cwd = await stat(plan.cwd)
  } catch (error) {
    const code = errnoOf(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new SpawnError('cwd-missing', `Working directory does not exist: ${plan.cwd}`)
    if (code === 'EACCES' || code === 'EPERM') throw new SpawnError('cwd-inaccessible', `Working directory is not accessible: ${plan.cwd}`)
    throw new SpawnError('other', `Working directory cannot be checked: ${plan.cwd} (${code ?? messageOf(error)})`)
  }
  if (!cwd.isDirectory()) throw new SpawnError('cwd-not-directory', `Working directory is not a directory: ${plan.cwd}`)

  let file
  try {
    file = await stat(plan.file)
  } catch (error) {
    const code = errnoOf(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new SpawnError('executable-not-found', `Executable not found: ${plan.file}`)
    throw new SpawnError('other', `Executable cannot be checked: ${plan.file} (${code ?? messageOf(error)})`)
  }
  if (!file.isFile()) throw new SpawnError('not-executable', `Not an executable file: ${plan.file}`)
}
