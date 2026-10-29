// Candidate quoting for starting a `.cmd`/`.bat` shim through `cmd.exe /d /v:off /s /c` (design D3).
// The `cmd-route-verbatim-<case>` checks run it against the corpus; if every case passes (a case cmd.exe
// cannot carry passes by being refused), W2 adopts it unchanged.
//
// An argument for an npm-style shim (`@node "%~dp0record.mjs" %*`) is parsed three times:
//   1. by cmd.exe for the `/c` command line;
//   2. by cmd.exe again, for the batch line into which `%*` is substituted;
//   3. by the target program, by the `CommandLineToArgvW` rules.
// So the argument is quoted for 3 (`quoteArgument`), then every cmd metacharacter is escaped with `^`
// once for each of 1 and 2 (`escapeForShim`). The quotes themselves are escaped, so cmd never enters
// its quoted state, where `^` would be literal; every metacharacter is therefore escaped in both
// parses. `%` is the one character `^` cannot protect from 1: percent expansion runs before carets are
// removed. A `^` is put right after each `%`, so every `%…%` pair names a variable starting with
// `^`, which is undefined and left unexpanded on a command line; that `^` is removed in parse 1.
// `/v:off` turns delayed expansion (`!VAR!`) off whatever the registry says; `!` is escaped anyway.
// Escaping makes a line up to five times longer than its arguments, so a line beyond cmd.exe's
// 8191-character limit is refused rather than truncated. The limit applies to both parses: the
// batch line also holds the shim's own text, for which SHIM_LINE_RESERVE characters are kept free.

/** Characters cmd.exe interprets on a command line or a batch line. */
const METACHARACTERS = /[\^"&|<>()%!]/g

/** cmd.exe's longest command line, in characters. */
export const MAX_COMMAND_LINE = 8191

/** Characters kept free on the batch line for the shim's own text around `%*` (npm.cmd's is under 200). */
export const SHIM_LINE_RESERVE = 1024

/** Line breaks end a cmd command line and NUL ends any command line: no quoting can carry them. */
const UNREPRESENTABLE = /[\0\n\r]/

/** Quotes one argument by the `CommandLineToArgvW` rules, always in double quotes. */
export function quoteArgument(arg) {
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

const escapeOnce = (text) => text.replace(METACHARACTERS, '^$&')

/** Escapes text for both cmd.exe parses of a shim's arguments (see the file comment). */
export function escapeForShim(text) {
  return escapeOnce(escapeOnce(text)).replace(/%(?!\^)/g, '%^')
}

/**
 * The text after `/c` for running `command` (a `.cmd`/`.bat` path) with `args`, including the
 * outer quotes that `/s` removes. Pass it with `windowsVerbatimArguments: true`, as `cmdShimArgs` does.
 * Throws for an argument containing a line break or NUL, for a command path containing `"` or `%`,
 * which cannot be quoted for cmd.exe, and for a line longer than `MAX_COMMAND_LINE`.
 */
export function cmdShimCommandLine(command, args) {
  if (/["%]/.test(command) || UNREPRESENTABLE.test(command)) {
    throw new Error(`cannot quote command path ${JSON.stringify(command)} for cmd.exe`)
  }
  const parts = [`"${command}"`]
  // What `%*` expands to on the batch line: the arguments as parse 1 leaves them.
  let batchArgs = 0
  for (const arg of args) {
    if (UNREPRESENTABLE.test(arg)) throw new Error(`cannot pass ${JSON.stringify(arg)} through cmd.exe: it contains a line break or NUL`)
    const quoted = quoteArgument(arg)
    parts.push(escapeForShim(quoted))
    batchArgs += escapeOnce(quoted).length + 1
  }
  const line = `"${parts.join(' ')}"`
  if (line.length > MAX_COMMAND_LINE) {
    throw new Error(`cannot pass these arguments through cmd.exe: the escaped line has ${line.length} characters, more than ${MAX_COMMAND_LINE}`)
  }
  if (batchArgs + SHIM_LINE_RESERVE > MAX_COMMAND_LINE) {
    throw new Error(
      `cannot pass these arguments through cmd.exe: they take ${batchArgs} characters on the shim's batch line, more than ${MAX_COMMAND_LINE - SHIM_LINE_RESERVE}`,
    )
  }
  return line
}

/**
 * `cmd.exe` arguments for `spawn` with `windowsVerbatimArguments: true`:
 * `spawn('cmd.exe', cmdShimArgs(command, args), { windowsVerbatimArguments: true })`.
 */
export function cmdShimArgs(command, args) {
  return ['/d', '/v:off', '/s', '/c', cmdShimCommandLine(command, args)]
}
