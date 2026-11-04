#!/usr/bin/env node
// Builds the Windows process-tree helper (add-windows-process-supervision design D5):
//
//   node scripts/build-windows-helper.mjs
//
// compiles src/main/platform/windows/helper/veydr-helper.cs with the csc.exe of .NET Framework 4.8
// into out-helper/veydr-helper.exe, which is git-ignored: no helper binary is ever committed. The
// SHA-256 of the source is stored next to the binary, and the build is skipped while it matches.
// Exit codes: 0 built or already up to date; 1 the build failed (compiler output on stderr), or the
// system is not Windows; 2 usage error.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '..')

export const SOURCE_PATH = join(root, 'src', 'main', 'platform', 'windows', 'helper', 'veydr-helper.cs')
export const OUTPUT_DIR = join(root, 'out-helper')
export const HELPER_PATH = join(OUTPUT_DIR, 'veydr-helper.exe')
/** The SHA-256 of the source the binary beside it was built from, as lowercase hex and a newline. */
export const HASH_PATH = join(OUTPUT_DIR, 'veydr-helper.sha256')
/** The binary is built under this name and renamed, so an interrupted build never leaves a half-written helper. */
const PARTIAL_PATH = join(OUTPUT_DIR, 'veydr-helper.partial.exe')

export const NOT_WINDOWS_MESSAGE = 'the Windows helper can only be built on Windows'
const COMPILE_TIMEOUT_MS = 120_000

/** A failure the script reports to the user and exits 1 for. */
export class BuildError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BuildError'
  }
}

/** The .NET Framework 4.x compiler that every supported Windows ships. */
export const compilerPath = (windir = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows') =>
  join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')

/** The compiler's arguments; warnings are errors so a diagnostic never goes unnoticed. */
export const compilerArguments = (source, output) => ['/nologo', '/optimize+', '/warnaserror+', '/target:exe', `/out:${output}`, source]

export const sourceHash = (source = SOURCE_PATH) => createHash('sha256').update(readFileSync(source)).digest('hex')

/** Whether `binary` exists and the hash stored beside it is `hash`. */
export function isUpToDate({ binary = HELPER_PATH, hashFile = HASH_PATH, hash }) {
  if (!existsSync(binary) || !existsSync(hashFile)) return false
  return readFileSync(hashFile, 'utf8').trim() === hash
}

/** Removes a file whose absence is the goal; a file that cannot be removed (still running) is left, and the build error says why it failed. */
function discard(path) {
  try {
    rmSync(path, { force: true })
  } catch {
    // Nothing more to do for a cleanup.
  }
}

function runCompiler(compiler, args) {
  const run = spawnSync(compiler, args, { encoding: 'utf8', windowsHide: true, timeout: COMPILE_TIMEOUT_MS })
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}`.trim(), error: run.error }
}

/**
 * Builds the helper unless it is up to date, and returns `'built'` or `'up-to-date'`.
 * Throws BuildError when the system is not Windows or the compiler is missing or fails; a failed
 * build leaves neither a binary nor a hash behind, so nothing can mistake it for a finished one.
 * The paths, the platform and the compiler can be replaced for tests.
 */
export function buildHelper({
  platform = process.platform,
  compiler = compilerPath(),
  source = SOURCE_PATH,
  binary = HELPER_PATH,
  hashFile = HASH_PATH,
  partial = PARTIAL_PATH,
  run = runCompiler,
} = {}) {
  if (platform !== 'win32') throw new BuildError(NOT_WINDOWS_MESSAGE)
  const hash = sourceHash(source)
  if (isUpToDate({ binary, hashFile, hash })) return 'up-to-date'

  if (!existsSync(compiler)) throw new BuildError(`the .NET Framework compiler was not found at ${compiler}`)
  mkdirSync(resolve(binary, '..'), { recursive: true })
  rmSync(hashFile, { force: true })
  rmSync(partial, { force: true })
  const result = run(compiler, compilerArguments(source, partial))
  if (result.error !== undefined || result.status !== 0) {
    discard(partial)
    discard(binary)
    const how = result.error === undefined ? `exited with ${String(result.status)}` : result.error.message
    throw new BuildError(`csc.exe ${how}${result.output === '' ? '' : `:\n${result.output}`}`)
  }
  // The hash was taken before the compiler read the source; if the source changed in between, the
  // binary may not match it, so no hash is stored and the next run builds again.
  if (sourceHash(source) !== hash) {
    discard(partial)
    throw new BuildError(`${source} changed during the build; run the build again`)
  }
  try {
    renameSync(partial, binary)
    writeFileSync(hashFile, `${hash}\n`)
  } catch (error) {
    discard(partial)
    discard(hashFile)
    throw new BuildError(`could not install ${binary}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return 'built'
}

/** Runs the script for `args` and returns its exit code; `options` are passed on to buildHelper (tests). */
export function runBuildCli(args, options = {}, { stdout = console.log, stderr = console.error } = {}) {
  if (args.length > 0) {
    stderr('usage: node scripts/build-windows-helper.mjs')
    return 2
  }
  try {
    const outcome = buildHelper(options)
    const binary = options.binary ?? HELPER_PATH
    stdout(outcome === 'built' ? `built ${binary}` : `${binary} is up to date`)
    return 0
  } catch (error) {
    if (!(error instanceof BuildError)) throw error
    stderr(`build-windows-helper: ${error.message}`)
    return 1
  }
}

function isEntryPoint() {
  if (process.argv[1] === undefined) return false
  try {
    const [argv, self] = [realpathSync(process.argv[1]), fileURLToPath(import.meta.url)]
    return process.platform === 'win32' ? argv.toLowerCase() === self.toLowerCase() : argv === self
  } catch {
    return false
  }
}

if (isEntryPoint()) process.exitCode = runBuildCli(process.argv.slice(2))
