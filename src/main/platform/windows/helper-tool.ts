import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { SpawnError } from '../errors'
import { isFullyQualified } from './command-line'
import type { SpawnHelper } from './helper-client'
import { MAX_TOOL_OUTPUT_BYTES, PROTOCOL_VERSION, ProtocolError } from './protocol'

// The helper's short-lived subcommands (add-windows-port-inspection design D6): the version check
// and `runHelperTool`, shared by everything that runs the helper's stdio subcommands (the process
// tree's `inspect` and `terminate`). A port inspector must never import this module, so that its own
// import closure starts no process.

/** Reads what `veydr-helper.exe version` prints; rejects if it cannot be run. */
export type ReadHelperVersion = (helperPath: string) => Promise<string>

/**
 * The check that a helper file may be run: it exists, is given by its full path, and speaks
 * PROTOCOL_VERSION. One check is shared by everything that runs the same helper, so the version is
 * read once per helper file.
 */
export interface HelperCheck {
  /** The helper file this check verifies; its users run exactly this file. */
  readonly helperPath: string
  /** Resolves once the helper may be run; rejects with a `SpawnError` saying why not. */
  readonly verify: () => Promise<void>
}

/** How long `veydr-helper.exe version` may take. */
export const VERSION_TIMEOUT_MS = 10_000

/** Most bytes of a subcommand's stderr kept for its error message. */
const MAX_TOOL_STDERR_BYTES = 4096

/** Largest delay `setTimeout` honours; longer ones fire at once. */
const MAX_TIMER_MS = 0x7fff_ffff

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

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
 * The check of the helper at `helperPath` (add-windows-process-supervision design D5): it rejects a
 * helper that is missing, not fully qualified, or speaks another protocol version. The version is
 * read once per helper file (size and modification time), and again after the file changes; checks
 * running at the same time share one read, and a failed check is not remembered.
 */
export function createHelperCheck(helperPath: string, readVersion: ReadHelperVersion = runHelperVersion): HelperCheck {
  /** The checked helper file (size and modification time) and its check, shared by concurrent callers. */
  let checked: { readonly key: string; readonly result: Promise<void> } | null = null

  async function verify(): Promise<void> {
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
      // A failed check is not remembered: the next caller checks again.
      result.catch(() => {
        if (checked?.result === result) checked = null
      })
    }
    return checked.result
  }

  return { helperPath, verify }
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

export interface HelperToolOptions {
  readonly spawnHelper: SpawnHelper
  /** How long the subcommand may take before it is killed; a positive integer. */
  readonly timeoutMs: number
  /** Most bytes of stdout accepted (MAX_TOOL_OUTPUT_BYTES by default); more fails the call. */
  readonly maxOutputBytes?: number
}

/**
 * Runs `<helper> <args>`, hidden and never detached, writes `input` on its stdin, and resolves with
 * its stdout once it exited with 0. Rejects if it cannot be started, exits otherwise, prints more
 * than `maxOutputBytes`, prints anything but UTF-8, or takes longer than `timeoutMs` (it is then
 * killed). It kills only the child it spawned, not that child's descendants.
 */
export function runHelperTool(
  helperPath: string,
  args: readonly string[],
  input: string,
  { spawnHelper, timeoutMs, maxOutputBytes = MAX_TOOL_OUTPUT_BYTES }: HelperToolOptions,
): Promise<string> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    return Promise.reject(new RangeError(`timeoutMs must be a positive integer: ${String(timeoutMs)}`))
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    return Promise.reject(new RangeError(`maxOutputBytes must be a positive integer: ${String(maxOutputBytes)}`))
  }
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
      if (outBytes > maxOutputBytes) return finish(new ProtocolError('line-too-long', `${what} printed more than ${maxOutputBytes} bytes`))
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
