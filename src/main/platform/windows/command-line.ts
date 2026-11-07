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
 * A Win32 device or literal path (`\\.\…`, `\\?\…`, in either slash). `cmd.exe` does not reliably run
 * a batch file from one, and the resolver never produces one, so it is refused rather than guessed at.
 */
const isDevicePath = (path: string): boolean => /^[\\/]{2}[.?][\\/]/.test(path)

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
