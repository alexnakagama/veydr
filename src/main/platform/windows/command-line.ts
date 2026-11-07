import { sep } from 'node:path'
import { SpawnError } from '../errors'

// Every Windows command line Veydr starts (add-windows-environment-and-commands design D1). Veydr
// builds the complete `CreateProcess` command line here, argv[0] included, and the helper passes it
// on unchanged, so all quoting lives in one place that unit tests reach on every system.
//
// Three readers are involved:
// - `CommandLineToArgvW` and the C runtime, for an ordinary program (`quoteArgument`);
// - `cmd.exe`, for a batch file (`batchCommandLine`), which is parsed twice when the batch file
//   forwards its arguments with `%*`: once for the `/c` line and once for the batch line;
// - `cmd.exe`, for a shell-mode script (`shellCommandLine`), which is passed verbatim.
//
// `cmd.exe` is always started with `/d` (no AutoRun commands), `/v:off` (no `!delayed!` expansion,
// whatever the registry says) and `/s /c "<…>"` (the first and last quote of the rest are removed,
// and the text between them is run as one line).
//
// The batch-file quoting is `scripts/windows-probe/cmd-quote.mjs`, which W0 validated against the
// injection corpus, except that simple arguments pass bare (see `BARE_BATCH_ARGUMENT`).

/** The longest command line `cmd.exe` accepts, in characters. */
export const CMD_MAX_LINE = 8191

/**
 * The longest command line `CreateProcess` accepts, in characters: 32,767 with the terminating NUL
 * (the helper refuses the same, design D1).
 */
export const MAX_COMMAND_LINE = 32_766

/** Characters kept free on a batch file's own line for its text around `%*` (npm.cmd's is under 200). */
export const SHIM_LINE_RESERVE = 1024

/** The flags every `cmd.exe` line starts with (see the file comment). */
const CMD_FLAGS = '/d /v:off /s /c'

/**
 * A batch-file argument that carries no character `cmd.exe` interprets, so it reaches `%1` and
 * `%~1` as written, and a `%*` forwarder's program reads it unchanged: ASCII letters, digits and
 * `_ + - . : / \ @`. It is W1's `BareBatchArgumentPattern`. Anything else is quoted.
 */
export const BARE_BATCH_ARGUMENT = /^[A-Za-z0-9_+\-.:/\\@]+$/

/** Characters `cmd.exe` interprets on a command line or a batch line. */
const CMD_METACHARACTERS = /[\^"&|<>()%!]/g

/** Why a command line was refused. */
export type CommandLineRefusal =
  /** A NUL character, which ends any Windows command line. */
  | 'nul'
  /** A line break, which ends a `cmd.exe` line, so only its first line would run. */
  | 'line-break'
  /**
   * A lone UTF-16 surrogate, which has no UTF-8 form, so the command line could not reach the
   * helper (which reads it as UTF-8) unchanged.
   */
  | 'unpaired-surrogate'
  /** A shell-mode script that is empty or only whitespace. */
  | 'blank-script'
  /** A path that cannot be quoted, depends on the current drive or directory, or is a device path. */
  | 'invalid-path'
  /** More than `CMD_MAX_LINE` characters on the `cmd.exe` line. */
  | 'line-too-long'
  /** More than `CMD_MAX_LINE - SHIM_LINE_RESERVE` characters of arguments on the batch file's own line. */
  | 'batch-line-too-long'
  /** More than `MAX_COMMAND_LINE` characters on a `CreateProcess` command line. */
  | 'command-line-too-long'
  /** A batch file given as the program, which `CreateProcess` would run through `cmd.exe` unquoted. */
  | 'batch-file-program'
  /** A command line whose argv[0] is not the quoted program it is started with. */
  | 'command-line-mismatch'

/**
 * A command line that cannot be built, so nothing was started. It is a `SpawnError`, so it reaches
 * the user like any other start failure; `refusal` says which limit was hit. The message names the
 * limit and, for an argument or a script, its position, never its text, which may hold a secret.
 * Paths (of `cmd.exe` and the batch file) are not secret and are shown.
 */
export class CommandLineError extends SpawnError {
  constructor(
    readonly refusal: CommandLineRefusal,
    message: string,
  ) {
    super('other', message)
  }
}

/**
 * Whether `path` names a file without depending on a current drive or directory: `C:\…` or a UNC
 * path (`\\server\share\…`). Windows rules only, on every system.
 */
const isWindowsFullPath = (path: string): boolean => /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path)

/**
 * Whether `path` names a program without depending on a current drive or directory: `C:\…` or a UNC
 * path, the rule the helper applies (a root-relative `\…` is not enough). Where paths are POSIX,
 * which only tests reach, an absolute path is enough.
 */
export const isFullyQualified = (path: string): boolean => isWindowsFullPath(path) || (sep === '/' && path.startsWith('/'))

/**
 * A Win32 device or literal path (`\\.\…`, `\\?\…`, in either slash). `cmd.exe` does not reliably run
 * a batch file from one, and the resolver never produces one, so it is refused rather than guessed at.
 */
const isDevicePath = (path: string): boolean => /^[\\/]{2}[.?][\\/]/.test(path)

/**
 * Whether a full path has a segment that Windows removes or resolves when it normalizes the path:
 * an empty one (`\\`, or a trailing separator), `.`, `..`, or one of only dots and spaces. The drive
 * (`C:`) or the UNC prefix (`\\`) is not a segment. The helper's `HasDotSegment` is the same rule.
 */
export function hasDotSegment(path: string): boolean {
  const rest = /^[A-Za-z]:[\\/]/.test(path) ? path.slice(3) : /^[\\/]{2}/.test(path) ? path.slice(2) : path.replace(/^[\\/]/, '')
  return rest.split(/[\\/]/).some((segment) => /^[. ]*$/.test(segment))
}

const hasNul = (text: string): boolean => text.includes('\0')
const hasLineBreak = (text: string): boolean => /[\r\n]/.test(text)
/** A lone surrogate: in `u` mode a paired one is a single code point and does not match. */
const hasLoneSurrogate = (text: string): boolean => /[\uD800-\uDFFF]/u.test(text)

/** `"<path>"` as argv[0] of a command line, which is read up to its closing quote without escapes. */
function quotedProgram(path: string, what: string): string {
  if (hasNul(path)) throw new CommandLineError('nul', `The ${what} path contains a NUL character, which no Windows command line can carry`)
  if (hasLineBreak(path) || path.includes('"')) {
    throw new CommandLineError('invalid-path', `The ${what} path contains a line break or a double quote, which cannot be quoted: ${JSON.stringify(path)}`)
  }
  if (hasLoneSurrogate(path)) throw new CommandLineError('unpaired-surrogate', `The ${what} path contains an unpaired UTF-16 surrogate: ${JSON.stringify(path)}`)
  if (!isWindowsFullPath(path)) throw new CommandLineError('invalid-path', `The ${what} must be given by its full path: ${JSON.stringify(path)}`)
  if (isDevicePath(path)) throw new CommandLineError('invalid-path', `The ${what} must be an ordinary drive or UNC path, not a \\\\.\\ or \\\\?\\ path: ${JSON.stringify(path)}`)
  return `"${path}"`
}

/** Refuses a line longer than `cmd.exe` accepts. */
function checkCmdLine(line: string, what: string): string {
  if (line.length > CMD_MAX_LINE) {
    throw new CommandLineError('line-too-long', `The ${what} for cmd.exe has ${line.length} characters, more than the ${CMD_MAX_LINE} cmd.exe accepts`)
  }
  return line
}

/**
 * `arg` quoted by the `CommandLineToArgvW` and C runtime rules, always in double quotes, so that
 * those parsers read it back unchanged. It is the quoting of `cmd-quote.mjs` and W1's
 * `AppendQuoted`. Throws a `CommandLineError` for NUL, which no command line can carry, and for an
 * unpaired surrogate.
 */
export function quoteArgument(arg: string): string {
  if (hasNul(arg)) throw new CommandLineError('nul', 'An argument contains a NUL character, which no Windows command line can carry')
  if (hasLoneSurrogate(arg)) throw new CommandLineError('unpaired-surrogate', 'An argument contains an unpaired UTF-16 surrogate, which has no UTF-8 form')
  let quoted = '"'
  let backslashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++
      continue
    }
    // Backslashes are literal unless they precede a double quote: then each is doubled, and the
    // quote is escaped by one more.
    quoted += ch === '"' ? '\\'.repeat(backslashes * 2 + 1) + '"' : '\\'.repeat(backslashes) + ch
    backslashes = 0
  }
  // Trailing backslashes precede the closing quote, so they are doubled too.
  return quoted + '\\'.repeat(backslashes * 2) + '"'
}

/** `text` with every `cmd.exe` metacharacter escaped by `^`, for one parse. */
const escapeOnce = (text: string): string => text.replace(CMD_METACHARACTERS, '^$&')

/**
 * `text` escaped for both `cmd.exe` parses of a forwarded argument (the `/c` line, then the batch
 * line `%*` is substituted into). The quotes are escaped too, so `cmd.exe` never enters its quoted
 * state, where `^` would be literal. `%` is the one character `^` cannot protect, since percent
 * expansion runs before carets are removed; a `^` after each `%` makes every `%…%` pair name an
 * undefined variable starting with `^`, which a command line leaves unexpanded.
 */
const escapeForShim = (text: string): string => escapeOnce(escapeOnce(text)).replace(/%(?!\^)/g, '%^')

/**
 * The complete command line that runs the batch file `file` with `args` through `cmdExe`:
 * `"<cmdExe>" /d /v:off /s /c ""<file>" <args>"`. Start it with `cmdExe` as the application.
 *
 * An argument matching `BARE_BATCH_ARGUMENT` is passed bare; every other one is quoted and escaped
 * as `cmd-quote.mjs` does, so a program the batch file forwards it to with `%*` receives it
 * unchanged. A batch file that reads such an argument through `%1` itself sees it escaped.
 *
 * `file` must already be a batch file; choosing which files may run (and their types) is the
 * resolver's job (design D2).
 *
 * Throws a `CommandLineError` for:
 * - a `cmdExe` or `file` that is not a full drive or UNC path, or contains NUL, a line break, `"`
 *   or an unpaired surrogate;
 * - a `file` containing `%`, which `cmd.exe` expands even inside quotes;
 * - an argument containing NUL, a line break or an unpaired surrogate;
 * - a line beyond `CMD_MAX_LINE` characters, or arguments that would take more than
 *   `CMD_MAX_LINE - SHIM_LINE_RESERVE` characters on the batch file's own line.
 */
export function batchCommandLine(cmdExe: string, file: string, args: readonly string[]): string {
  const program = quotedProgram(cmdExe, 'cmd.exe')
  const batchFile = quotedProgram(file, 'batch file')
  if (file.includes('%')) throw new CommandLineError('invalid-path', `The batch file path contains %, which cmd.exe expands even inside quotes: ${JSON.stringify(file)}`)

  const parts = [batchFile]
  // What `%*` expands to on the batch line: the arguments as the `/c` parse leaves them.
  let batchArgs = 0
  args.forEach((arg, index) => {
    const position = `Argument ${index + 1}`
    if (hasNul(arg)) throw new CommandLineError('nul', `${position} contains a NUL character, which no Windows command line can carry`)
    if (hasLineBreak(arg)) throw new CommandLineError('line-break', `${position} contains a line break, which cmd.exe cannot pass to a batch file: it runs one line`)
    if (hasLoneSurrogate(arg)) throw new CommandLineError('unpaired-surrogate', `${position} contains an unpaired UTF-16 surrogate, which has no UTF-8 form`)
    if (BARE_BATCH_ARGUMENT.test(arg)) {
      parts.push(arg)
      batchArgs += arg.length + 1
      return
    }
    const quoted = quoteArgument(arg)
    parts.push(escapeForShim(quoted))
    batchArgs += escapeOnce(quoted).length + 1
  })

  const line = checkCmdLine(`${program} ${CMD_FLAGS} "${parts.join(' ')}"`, 'batch-file command line')
  if (batchArgs + SHIM_LINE_RESERVE > CMD_MAX_LINE) {
    throw new CommandLineError(
      'batch-line-too-long',
      `The arguments take ${batchArgs} characters on the batch file's own line, more than the ${CMD_MAX_LINE - SHIM_LINE_RESERVE} left of cmd.exe's ${CMD_MAX_LINE} after ${SHIM_LINE_RESERVE} kept for the batch file's text`,
    )
  }
  return line
}

/**
 * Whether `path` names a batch file, which `CreateProcess` would run through `cmd.exe` with its own
 * unsafe quoting: its file name ends in `.bat` or `.cmd`, in any case, once trailing dots and spaces
 * (which Windows drops from a file name) are removed. It is the helper's `IsBatchFile`.
 */
export function isBatchFile(path: string): boolean {
  const name = path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1).replace(/[. ]+$/, '')
  return /\.(?:bat|cmd)$/i.test(name)
}

/** What the helper is given for one run (design D1): the program, and its complete command line. */
export interface HelperLaunch {
  /** The fully qualified program `CreateProcess` starts; never a batch file. */
  readonly application: string
  /** The complete command line, argv[0] included, at most `MAX_COMMAND_LINE` characters. */
  readonly commandLine: string
}

/**
 * The launch for a plan (design D1): `plan.commandLine` when the resolver built one, or `plan.file`
 * and `plan.args` quoted by the `CommandLineToArgvW` rules. The helper repeats the checks that keep a
 * batch file from running without `cmd.exe`; they are made here first, so that a refusal names the
 * cause before any process exists.
 *
 * Throws a `CommandLineError` for:
 * - a program that is not a full drive or UNC path, is a device path, has an empty, `.` or `..`
 *   segment (or one of only dots and spaces), holds an alternate data stream (`:` after the drive),
 *   or contains NUL, a line break, `"` or an unpaired surrogate;
 * - a `commandLine` together with separate `args`, one of which would be ignored;
 * - a batch-file program without a `commandLine` (`batch-file-program`), and a batch file as the
 *   program of any command line: a batch file runs only as part of a `cmd.exe` command line;
 * - a `commandLine` that does not start with the quoted program (`command-line-mismatch`), or that
 *   contains NUL or an unpaired surrogate;
 * - a command line beyond `MAX_COMMAND_LINE` characters.
 */
export function helperLaunch(plan: { readonly file: string; readonly args: readonly string[]; readonly commandLine?: string | undefined }): HelperLaunch {
  const { file } = plan
  if (hasNul(file)) throw new CommandLineError('nul', 'The program path contains a NUL character, which no Windows command line can carry')
  if (hasLineBreak(file) || file.includes('"')) {
    throw new CommandLineError('invalid-path', `The program path contains a line break or a double quote, which cannot be quoted: ${JSON.stringify(file)}`)
  }
  if (hasLoneSurrogate(file)) throw new CommandLineError('unpaired-surrogate', `The program path contains an unpaired UTF-16 surrogate: ${JSON.stringify(file)}`)
  if (!isFullyQualified(file)) throw new CommandLineError('invalid-path', `The program must be given by its full path: ${JSON.stringify(file)}`)
  if (isDevicePath(file)) throw new CommandLineError('invalid-path', `The program must be an ordinary drive or UNC path, not a \\\\.\\ or \\\\?\\ path: ${JSON.stringify(file)}`)
  // `C:\tool.bat\.` is `C:\tool.bat` once Windows normalizes it, but its last segment is no batch
  // file name; such segments are refused, so the batch-file check below sees the real name.
  if (hasDotSegment(file)) {
    throw new CommandLineError('invalid-path', `The program path has an empty, "." or ".." segment, or one of only dots and spaces: ${JSON.stringify(file)}`)
  }
  // `C:\tool.bat::$DATA` names a data stream of the file; no program Veydr plans needs one.
  if (file.indexOf(':', 2) !== -1) throw new CommandLineError('invalid-path', `The program path contains ":" after the drive: ${JSON.stringify(file)}`)
  if (isBatchFile(file)) {
    throw new CommandLineError(
      'batch-file-program',
      plan.commandLine === undefined
        ? `The batch file ${JSON.stringify(file)} can only run through cmd.exe, with a command line built for it`
        : `The program ${JSON.stringify(file)} is a batch file; a batch file runs only as part of a cmd.exe command line`,
    )
  }
  // argv[0] is read up to its closing quote, without escapes; the path contains no quote.
  const program = `"${file}"`

  let commandLine: string
  if (plan.commandLine !== undefined && plan.args.length > 0) {
    // One of them would be ignored; the command line is the whole truth, so the plan carries no arguments.
    throw new CommandLineError('command-line-mismatch', 'A plan with a command line must not also have separate arguments')
  }
  if (plan.commandLine === undefined) {
    commandLine = [program, ...plan.args.map(quoteArgument)].join(' ')
  } else {
    commandLine = plan.commandLine
    if (hasNul(commandLine)) throw new CommandLineError('nul', 'The command line contains a NUL character, which no Windows command line can carry')
    if (hasLoneSurrogate(commandLine)) throw new CommandLineError('unpaired-surrogate', 'The command line contains an unpaired UTF-16 surrogate, which has no UTF-8 form')
    // argv[0] is what the started program reads as its own path; it must be the program started.
    if (!(commandLine === program || commandLine.startsWith(`${program} `))) {
      throw new CommandLineError('command-line-mismatch', `The command line does not start with the quoted program ${program}`)
    }
  }
  if (commandLine.length > MAX_COMMAND_LINE) {
    throw new CommandLineError('command-line-too-long', `The command line has ${commandLine.length} characters, more than the ${MAX_COMMAND_LINE} Windows accepts`)
  }
  return { application: file, commandLine }
}

/**
 * The complete command line that runs the shell-mode `script` through `cmdExe`, verbatim:
 * `"<cmdExe>" /d /v:off /s /c "<script>"`. Start it with `cmdExe` as the application.
 *
 * Throws a `CommandLineError` for a `cmdExe` that is not a full path or cannot be quoted, a script
 * that is empty or blank or contains NUL, a line break (`cmd.exe /c` would run only its first
 * line) or an unpaired surrogate, and a full line, prefix and closing quote included, beyond `CMD_MAX_LINE` characters.
 */
export function shellCommandLine(cmdExe: string, script: string): string {
  const program = quotedProgram(cmdExe, 'cmd.exe')
  if (hasNul(script)) throw new CommandLineError('nul', 'The script contains a NUL character, which no Windows command line can carry')
  if (hasLineBreak(script)) throw new CommandLineError('line-break', 'The script contains a line break, but cmd.exe runs one line: join the commands with && or &')
  if (hasLoneSurrogate(script)) throw new CommandLineError('unpaired-surrogate', 'The script contains an unpaired UTF-16 surrogate, which has no UTF-8 form')
  if (script.trim() === '') throw new CommandLineError('blank-script', 'The script is empty')
  return checkCmdLine(`${program} ${CMD_FLAGS} "${script}"`, 'script command line')
}
