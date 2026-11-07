import { describe, expect, it } from 'vitest'
import { CORPUS } from '../../scripts/windows-probe/cmd-corpus.mjs'
import { cmdShimCommandLine, MAX_COMMAND_LINE, SHIM_LINE_RESERVE as PROBE_SHIM_LINE_RESERVE } from '../../scripts/windows-probe/cmd-quote.mjs'
import { SpawnError } from '../../src/main/platform/errors'
import {
  BARE_BATCH_ARGUMENT,
  batchCommandLine,
  CMD_MAX_LINE,
  CommandLineError,
  helperLaunch,
  isBatchFile,
  MAX_COMMAND_LINE as WINDOWS_MAX_COMMAND_LINE,
  quoteArgument,
  SHIM_LINE_RESERVE,
  shellCommandLine,
  type CommandLineRefusal,
} from '../../src/main/platform/windows/command-line'

// Design D1: every Windows command line, built in TypeScript and checked here on every system. The
// batch-file quoting must match W0's validated `cmd-quote.mjs` exactly for every argument that needs
// quoting; the real `cmd.exe` and helper run the same lines in the Windows integration tests.

const CMD = 'C:\\Windows\\System32\\cmd.exe'
const SHIM = 'C:\\Program Files\\nodejs\\npm.cmd'
/** What every `cmd.exe` line built for `CMD` starts with. */
const PREFIX = `"${CMD}" /d /v:off /s /c `

/**
 * Splits a complete command line by the `CommandLineToArgvW` rules: argv[0] is read up to its
 * closing quote (or the first space or tab) without escapes; each later argument by the backslash
 * and quote rules. A reference written independently of the code under test.
 */
function commandLineToArgv(line: string): string[] {
  const argv: string[] = []
  let i = 0
  if (line.startsWith('"')) {
    const end = line.indexOf('"', 1)
    argv.push(end < 0 ? line.slice(1) : line.slice(1, end))
    i = end < 0 ? line.length : end + 1
  } else {
    while (i < line.length && line[i] !== ' ' && line[i] !== '\t') i++
    argv.push(line.slice(0, i))
  }
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i++
    if (i >= line.length) break
    let arg = ''
    let quoted = false
    while (i < line.length && (quoted || (line[i] !== ' ' && line[i] !== '\t'))) {
      if (line[i] === '\\') {
        let n = 0
        while (line[i] === '\\') {
          n++
          i++
        }
        if (line[i] === '"') {
          arg += '\\'.repeat(Math.floor(n / 2))
          if (n % 2 === 1) {
            arg += '"'
            i++
          }
        } else {
          arg += '\\'.repeat(n)
        }
      } else if (line[i] === '"') {
        quoted = !quoted
        i++
      } else {
        arg += line[i]
        i++
      }
    }
    argv.push(arg)
  }
  return argv
}

/** Whether every `"` in `quoted` other than the first and last is escaped by an odd run of backslashes. */
function onlyOuterQuotesUnescaped(quoted: string): boolean {
  const inner = quoted.slice(1, -1)
  for (const match of inner.matchAll(/(\\*)"/g)) {
    if ((match[1] ?? '').length % 2 === 0) return false
  }
  return quoted.startsWith('"') && quoted.endsWith('"')
}

/** mulberry32: a small deterministic 32-bit generator, so a failing case can be reproduced from its seed. */
function generator(seed: number): (bound: number) => number {
  let state = seed >>> 0
  return (bound) => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    // The whole 32-bit result, scaled, so every bound draws on the high bits too.
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 2 ** 32) * bound)
  }
}

/** Arguments of 0 to 15 characters from `alphabet`, with runs of backslashes and quotes common. */
function* randomArguments(seed: number, count: number, alphabet: readonly string[] = ['a', 'Z', '0', ' ', '\t', '\\', '\\', '\\', '"', '"', '&', '%', '^', '!', 'ü', '日', '😀', '\v']): Generator<string> {
  const next = generator(seed)
  for (let n = 0; n < count; n++) {
    let arg = ''
    const length = next(16)
    for (let k = 0; k < length; k++) arg += alphabet[next(alphabet.length)]
    yield arg
  }
}

/** Metacharacters `cmd.exe` acts on outside its quoted state. */
const CMD_OPERATORS = new Set(['&', '|', '<', '>', '(', ')'])

/**
 * A model of `cmd.exe`'s caret and quote phase on one line: outside quotes, `^x` becomes `x`, and an
 * unescaped `"` toggles the quoted state, inside which everything is literal. It throws on an
 * operator outside quotes or a trailing `^`, which would run another command or continue the line.
 * Percent expansion is not modelled, so it is used only for arguments without `%`.
 */
function cmdCaretPhase(line: string): string {
  let out = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? ''
    if (quoted) {
      if (ch === '"') quoted = false
      out += ch
    } else if (ch === '^') {
      if (i + 1 >= line.length) throw new Error(`a trailing ^ continues the line: ${line}`)
      out += line[++i]
    } else if (ch === '"') {
      quoted = true
      out += ch
    } else if (CMD_OPERATORS.has(ch)) {
      throw new Error(`an unescaped ${ch} would be run by cmd.exe: ${line}`)
    } else {
      out += ch
    }
  }
  return out
}

/**
 * What the program behind an npm-style shim (`@node "%~dp0record.mjs" %*`) receives from `line`, a
 * `batchCommandLine`: parse 1 is the `/s /c` line, parse 2 the batch line `%*` is substituted into,
 * and the program splits the result by the `CommandLineToArgvW` rules.
 */
function forwardedArguments(line: string, file: string): string[] {
  const rest = line.slice(PREFIX.length)
  expect(rest.startsWith('"') && rest.endsWith('"'), 'the /c text is in outer quotes').toBe(true)
  // `/s`: the first and the last quote are removed, and the rest is one command.
  const invocation = cmdCaretPhase(rest.slice(1, -1))
  const head = `"${file}"`
  expect(invocation.startsWith(head), 'parse 1 runs the batch file').toBe(true)
  const percentStar = invocation.slice(head.length).replace(/^ /, '')
  const batchLine = cmdCaretPhase(`node "C:\\shim\\record.mjs" ${percentStar}`)
  return commandLineToArgv(batchLine).slice(2)
}

/** Runs `build` and returns the `CommandLineError` it throws. */
function refusal(build: () => unknown): CommandLineError {
  try {
    build()
  } catch (error) {
    expect(error).toBeInstanceOf(CommandLineError)
    expect(error).toBeInstanceOf(SpawnError)
    return error as CommandLineError
  }
  throw new Error('expected a CommandLineError, but nothing was thrown')
}

function expectRefused(build: () => unknown, kind: CommandLineRefusal, message: RegExp): CommandLineError {
  const error = refusal(build)
  expect(error.refusal).toBe(kind)
  expect(error.reason).toBe('other')
  expect(error.message).toMatch(message)
  return error
}

describe('Windows command lines (design D1)', () => {
  it("keeps cmd-quote.mjs's limits", () => {
    expect(CMD_MAX_LINE).toBe(MAX_COMMAND_LINE)
    expect(SHIM_LINE_RESERVE).toBe(PROBE_SHIM_LINE_RESERVE)
  })

  describe('quoteArgument', () => {
    it('round-trips through a CommandLineToArgvW reference parser', () => {
      const fixed = ['', 'plain', 'two words', 'tab\there', 'a"b', 'say "hi"', 'C:\\dir\\', 'x\\"y', 'x\\\\"y', '\\\\server\\share\\', '"', '\\', '\\\\"', 'grüße-日本語-😀', 'v\vt']
      for (const arg of [...fixed, ...randomArguments(1, 2000)]) {
        const quoted = quoteArgument(arg)
        expect(onlyOuterQuotesUnescaped(quoted), JSON.stringify(arg)).toBe(true)
        expect(commandLineToArgv(`"C:\\p.exe" ${quoted}`), JSON.stringify(arg)).toEqual(['C:\\p.exe', arg])
      }
    })

    it('keeps several arguments apart', () => {
      const args = ['a b', 'C:\\out\\', '', '"q"', 'last\\']
      expect(commandLineToArgv(`"C:\\p.exe" ${args.map(quoteArgument).join(' ')}`)).toEqual(['C:\\p.exe', ...args])
    })

    it('[spec:project-registry/unrepresentable-argument-refused] refuses NUL', () => {
      expectRefused(() => quoteArgument('a\0b'), 'nul', /NUL/)
    })
  })

  describe('batchCommandLine', () => {
    it("matches cmd-quote.mjs over the W0 corpus: quoted arguments exactly, simple ones bare, refusals alike", () => {
      let quotedCases = 0
      let bareCases = 0
      let refusedCases = 0
      for (const { id, args } of CORPUS) {
        let expected: string | null
        try {
          expected = cmdShimCommandLine(SHIM, args)
        } catch {
          expected = null
        }
        if (expected === null) {
          refusal(() => batchCommandLine(CMD, SHIM, args))
          refusedCases++
          continue
        }
        const simple = args.map((arg) => BARE_BATCH_ARGUMENT.test(arg))
        // A mixed case could not be compared with cmd-quote.mjs as a whole; none exists in the corpus.
        expect(new Set(simple).size, `${id} mixes simple and quoted arguments`).toBeLessThanOrEqual(1)
        if (simple[0] === true) {
          expect(batchCommandLine(CMD, SHIM, args), id).toBe(`${PREFIX}"${[`"${SHIM}"`, ...args].join(' ')}"`)
          bareCases++
        } else {
          expect(batchCommandLine(CMD, SHIM, args), id).toBe(PREFIX + expected)
          quotedCases++
        }
      }
      // The corpus exercises all three outcomes, so none of the branches above is vacuous.
      expect(quotedCases).toBeGreaterThan(10)
      expect(bareCases).toBeGreaterThan(0)
      expect(refusedCases).toBeGreaterThan(0)
    })

    it('passes simple arguments bare and quotes the rest, argument by argument', () => {
      const build = 'C:\\src\\build.bat'
      expect(batchCommandLine(CMD, build, ['release', 'C:\\out\\'])).toBe(`${PREFIX}""${build}" release C:\\out\\"`)
      // The quoted argument is exactly what cmd-quote.mjs makes of it alone.
      const quoted = cmdShimCommandLine(build, ['two words']).slice(`""${build}" `.length, -1)
      expect(batchCommandLine(CMD, build, ['release', 'two words', '-v'])).toBe(`${PREFIX}""${build}" release ${quoted} -v"`)
    })

    it('reaches a %* forwarder unchanged through both cmd.exe parses, for bare and quoted arguments side by side (a model without percent expansion)', () => {
      const next = generator(7)
      const quotedPool = [...randomArguments(3, 400, ['a', ' ', '\t', '\\', '\\', '"', '"', '&', '|', '<', '>', '(', ')', '^', '!', '=', ',', ';', 'ü', '😀'])]
      const barePool = ['release', 'C:\\out\\', '\\\\srv\\share\\', 'a\\', '-v', 'user@host', '1.2.3', 'x+y:z/w']
      const fixed = [
        ['release', 'two words', 'C:\\out\\'],
        ['C:\\out\\', 'a"b'],
        ['a\\', '"', 'b\\'],
        ['', 'x', ''],
        ['a&b', 'release', 'a|b', 'C:\\x\\', 'a^b'],
      ]
      const random = Array.from({ length: 500 }, () => Array.from({ length: 1 + next(4) }, () => (next(2) === 0 ? barePool[next(barePool.length)] ?? '' : quotedPool[next(quotedPool.length)] ?? '')))
      let mixed = 0
      for (const args of [...fixed, ...random]) {
        if (new Set(args.map((arg) => BARE_BATCH_ARGUMENT.test(arg))).size > 1) mixed++
        expect(forwardedArguments(batchCommandLine(CMD, SHIM, args), SHIM), JSON.stringify(args)).toEqual(args)
      }
      expect(mixed).toBeGreaterThan(100)
    })

    it('generates varied random arguments', () => {
      const lengths = new Set([...randomArguments(1, 2000)].map((arg) => [...arg].length))
      expect([...lengths].sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, n) => n))
    })

    it('treats only ASCII letters, digits and _ + - . : / \\ @ as simple', () => {
      for (const arg of ['release', 'C:\\out\\', '--flag', 'a+b', 'user@host', '//x', 'v1.2.3', '_'])
        expect(BARE_BATCH_ARGUMENT.test(arg), arg).toBe(true)
      for (const arg of ['', 'a b', 'a=b', 'a,b', 'a;b', 'ü', '%1', '!x!', 'a&b', 'a^b', '"', '(x)', 'a\tb', 'a*b', 'a?b'])
        expect(BARE_BATCH_ARGUMENT.test(arg), arg).toBe(false)
    })

    it('accepts a line of exactly the longest length, and refuses one character more', () => {
      // Quoting `&` grows the /c line about twice as fast as the batch line, so the line limit is hit first.
      const quoted = '&'.repeat(2000)
      const base = batchCommandLine(CMD, SHIM, [quoted]).length
      const pad = CMD_MAX_LINE - base - 1
      expect(pad).toBeGreaterThan(0)
      expect(batchCommandLine(CMD, SHIM, [quoted, 'x'.repeat(pad)])).toHaveLength(CMD_MAX_LINE)
      expectRefused(() => batchCommandLine(CMD, SHIM, [quoted, 'x'.repeat(pad + 1)]), 'line-too-long', new RegExp(`${CMD_MAX_LINE + 1} characters, more than the ${CMD_MAX_LINE}`))
    })

    it("accepts arguments that fill the batch file's line up to its reserve, and refuses one character more", () => {
      // A bare argument takes its own length plus one separator on the batch line.
      const longest = CMD_MAX_LINE - SHIM_LINE_RESERVE - 1
      expect(batchCommandLine(CMD, SHIM, ['x'.repeat(longest)])).toContain('x'.repeat(longest))
      expectRefused(() => batchCommandLine(CMD, SHIM, ['x'.repeat(longest + 1)]), 'batch-line-too-long', new RegExp(`more than the ${CMD_MAX_LINE - SHIM_LINE_RESERVE} left of cmd.exe's ${CMD_MAX_LINE}`))
    })

    describe('[spec:project-registry/unrepresentable-argument-refused] refusals', () => {
      it('refuses a line break or NUL in an argument, naming its position but not its text', () => {
        const secret = 'token-5f3a9c'
        for (const [arg, kind] of [
          [`${secret}\nnext`, 'line-break'],
          [`${secret}\rnext`, 'line-break'],
          [`${secret}\r\nnext`, 'line-break'],
          [`${secret}\0`, 'nul'],
        ] as const) {
          const error = expectRefused(() => batchCommandLine(CMD, SHIM, ['ok', arg]), kind, /^Argument 2 contains/)
          expect(error.message).not.toContain(secret)
        }
        expect(refusal(() => batchCommandLine(CMD, SHIM, ['a\nb'])).message).toMatch(/runs one line/)
      })

      it('refuses arguments too long for one cmd.exe line, naming the limit', () => {
        const longCase = CORPUS.find((c) => c.id === 'long')
        expect(longCase).toBeDefined()
        expectRefused(() => batchCommandLine(CMD, SHIM, longCase?.args ?? []), 'line-too-long', /more than the 8191 cmd\.exe accepts/)
      })

      it('refuses a batch file path that cannot be quoted or is not a full path', () => {
        expectRefused(() => batchCommandLine(CMD, 'C:\\100%\\x.cmd', []), 'invalid-path', /contains %/)
        expectRefused(() => batchCommandLine(CMD, 'C:\\a"b\\x.cmd', []), 'invalid-path', /double quote/)
        expectRefused(() => batchCommandLine(CMD, 'C:\\a\nb\\x.cmd', []), 'invalid-path', /line break/)
        expectRefused(() => batchCommandLine(CMD, 'C:\\a\0.cmd', []), 'nul', /NUL/)
        for (const relative of ['x.cmd', 'tools\\x.cmd', 'C:x.cmd', '\\tools\\x.cmd', '/tools/x.cmd', '\\\\'])
          expectRefused(() => batchCommandLine(CMD, relative, []), 'invalid-path', /full path/)
        for (const device of ['\\\\?\\C:\\x.cmd', '\\\\.\\C:\\x.cmd', '//?/C:/x.cmd', '\\\\.\\pipe\\x', '\\\\?\\UNC\\srv\\share\\x.cmd'])
          expectRefused(() => batchCommandLine(CMD, device, []), 'invalid-path', /ordinary drive or UNC path/)
        expectRefused(() => batchCommandLine(CMD, 'C:\\a\uD800.cmd', []), 'unpaired-surrogate', /unpaired/)
      })

      it('refuses an unpaired surrogate in an argument, naming its position but not its text, and accepts a paired one', () => {
        for (const lone of ['\uD800', 'secret\uDC00', 'x\uDBFFy']) {
          const error = expectRefused(() => batchCommandLine(CMD, SHIM, ['ok', lone]), 'unpaired-surrogate', /^Argument 2 contains an unpaired/)
          expect(error.message).not.toContain('secret')
          expectRefused(() => quoteArgument(lone), 'unpaired-surrogate', /unpaired/)
        }
        expect(batchCommandLine(CMD, SHIM, ['😀'])).toContain('😀')
      })

      it('refuses a cmd.exe path that cannot be quoted or is not a full path', () => {
        expectRefused(() => batchCommandLine('cmd.exe', SHIM, []), 'invalid-path', /cmd\.exe must be given by its full path/)
        expectRefused(() => batchCommandLine('C:\\a"\\cmd.exe', SHIM, []), 'invalid-path', /double quote/)
      })
    })

    it('accepts UNC and forward-slash paths', () => {
      expect(batchCommandLine('\\\\srv\\c$\\Windows\\System32\\cmd.exe', '//srv/share/x.cmd', [])).toBe('"\\\\srv\\c$\\Windows\\System32\\cmd.exe" /d /v:off /s /c ""//srv/share/x.cmd""')
    })

    it('reads back the cmd.exe program and flags by the CommandLineToArgvW rules', () => {
      const argv = commandLineToArgv(batchCommandLine(CMD, SHIM, ['a b']))
      expect(argv.slice(0, 5)).toEqual([CMD, '/d', '/v:off', '/s', '/c'])
    })
  })

  describe('shellCommandLine', () => {
    it('passes the script verbatim', () => {
      for (const script of ['echo a && echo %PATH%', 'echo "quoted" ^& more | find "x"', 'set X=1&& call echo %X%', ' leading and trailing ', 'grüße 日本語'])
        expect(shellCommandLine(CMD, script)).toBe(`${PREFIX}"${script}"`)
    })

    it('accepts a line of exactly the longest length, and refuses one character more', () => {
      const longest = CMD_MAX_LINE - `${PREFIX}""`.length
      expect(shellCommandLine(CMD, 'x'.repeat(longest))).toHaveLength(CMD_MAX_LINE)
      expectRefused(() => shellCommandLine(CMD, 'x'.repeat(longest + 1)), 'line-too-long', new RegExp(`${CMD_MAX_LINE + 1} characters, more than the ${CMD_MAX_LINE} cmd\\.exe accepts`))
    })

    it('[spec:project-registry/multi-line-script-refused-on-windows] refuses a line break, saying that cmd.exe runs one line', () => {
      for (const script of ['echo a\necho b', 'echo a\r\necho b', 'echo a\recho b', 'echo a\n'])
        expectRefused(() => shellCommandLine(CMD, script), 'line-break', /cmd\.exe runs one line/)
    })

    it('refuses NUL, and an empty or blank script', () => {
      expectRefused(() => shellCommandLine(CMD, 'echo\0x'), 'nul', /NUL/)
      expectRefused(() => shellCommandLine(CMD, 'echo \uDFFF'), 'unpaired-surrogate', /unpaired/)
      expect(shellCommandLine(CMD, 'echo 😀')).toBe(`${PREFIX}"echo 😀"`)
      for (const script of ['', ' ', '\t \t', '\u3000']) expectRefused(() => shellCommandLine(CMD, script), 'blank-script', /empty/)
    })

    it('refuses a cmd.exe path that cannot be quoted or is not a full path', () => {
      expectRefused(() => shellCommandLine('cmd', 'echo x'), 'invalid-path', /full path/)
      expectRefused(() => shellCommandLine('C:\\x"\\cmd.exe', 'echo x'), 'invalid-path', /double quote/)
      expectRefused(() => shellCommandLine('C:\\x\0\\cmd.exe', 'echo x'), 'nul', /NUL/)
      expectRefused(() => shellCommandLine('\\\\?\\C:\\Windows\\System32\\cmd.exe', 'echo x'), 'invalid-path', /ordinary drive or UNC path/)
    })
  })
})

describe('the helper launch (design D1, protocol version 2)', () => {
  const NODE = 'C:\\Program Files\\nodejs\\node.exe'

  function refusal(run: () => unknown): CommandLineError {
    let thrown: unknown
    try {
      run()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CommandLineError)
    expect(thrown).toBeInstanceOf(SpawnError)
    return thrown as CommandLineError
  }

  it('recognises batch files as the helper does, trailing dots and spaces trimmed, in any case', () => {
    for (const path of ['C:\\x\\build.bat', 'C:\\x\\npm.CMD', 'C:/x/a.Bat', 'C:\\x\\a.cmd.', 'C:\\x\\a.bat . .', '\\\\srv\\share\\run.cmd', 'RUN~1.BAT']) {
      expect(isBatchFile(path), path).toBe(true)
    }
    for (const path of ['C:\\x\\node.exe', 'C:\\x\\a.bat.exe', 'C:\\x.bat\\node.exe', 'C:\\x\\a.batch', 'C:\\x\\acmd', 'C:\\x\\a.bat:stream.exe']) {
      expect(isBatchFile(path), path).toBe(false)
    }
  })

  it('quotes the program and every argument by the CommandLineToArgvW rules when no command line is planned', () => {
    const args = ['server.js', '', 'a b', 'say "hi"', 'trail\\', 'C:\\dir with space\\', '%PATH%', '&|<>^!', 'é😀']
    const launch = helperLaunch({ file: NODE, args })
    expect(launch.application).toBe(NODE)
    expect(launch.commandLine.startsWith(`"${NODE}" `)).toBe(true)
    expect(commandLineToArgv(launch.commandLine)).toEqual([NODE, ...args])
    expect(helperLaunch({ file: NODE, args: [] })).toEqual({ application: NODE, commandLine: `"${NODE}"` })
  })

  it('passes a planned command line on unchanged', () => {
    const commandLine = shellCommandLine(CMD, 'npm run dev && echo %USERNAME%')
    expect(helperLaunch({ file: CMD, args: [], commandLine })).toEqual({ application: CMD, commandLine })
    const batch = batchCommandLine(CMD, SHIM, ['run', 'a & b'])
    expect(helperLaunch({ file: CMD, args: [], commandLine: batch })).toEqual({ application: CMD, commandLine: batch })
  })

  it('refuses a batch file as the program, with or without a command line', () => {
    for (const file of [SHIM, 'C:\\x\\build.BAT', 'C:\\x\\build.bat. ', '\\\\srv\\share\\run.cmd']) {
      expect(refusal(() => helperLaunch({ file, args: ['x'] })).refusal, file).toBe('batch-file-program')
      expect(refusal(() => helperLaunch({ file, args: [], commandLine: `"${file}" x` })).refusal, file).toBe('batch-file-program')
    }
    expect(refusal(() => helperLaunch({ file: SHIM, args: [] })).message).toContain('can only run through cmd.exe')
  })

  it('refuses a program that is not an ordinary full path', () => {
    const cases: [string, CommandLineRefusal][] = [
      ['C:node.exe', 'invalid-path'],
      ['\\node.exe', 'invalid-path'],
      ['node.exe', 'invalid-path'],
      ['\\\\.\\C:\\node.exe', 'invalid-path'],
      ['\\\\?\\C:\\node.exe', 'invalid-path'],
      ['//?/C:/node.exe', 'invalid-path'],
      ['C:\\x\\run.bat::$DATA', 'invalid-path'],
      // Segments that normalization removes would hide a batch file's name (reviewer2, group 2).
      ['C:\\x\\evil.bat\\.', 'invalid-path'],
      ['C:\\x\\evil.bat\\..\\evil.bat', 'invalid-path'],
      ['C:\\x\\evil.bat\\', 'invalid-path'],
      ['C:\\x\\evil.bat\\ . ', 'invalid-path'],
      ['C:\\x\\..\\node.exe', 'invalid-path'],
      ['C:\\x\\.\\node.exe', 'invalid-path'],
      ['C:\\x\\\\node.exe', 'invalid-path'],
      ['\\\\srv\\share\\..\\run.cmd', 'invalid-path'],
      ['C:\\x\\node.exe:alt', 'invalid-path'],
      ['C:\\x\\"node".exe', 'invalid-path'],
      ['C:\\x\\node\n.exe', 'invalid-path'],
      ['C:\\x\\node\0.exe', 'nul'],
      ['C:\\x\\node\uD800.exe', 'unpaired-surrogate'],
    ]
    for (const [file, kind] of cases) expect(refusal(() => helperLaunch({ file, args: [] })).refusal, JSON.stringify(file)).toBe(kind)
  })

  it('refuses a planned command line that does not start with the quoted program, or that holds NUL or a lone surrogate', () => {
    const cases: [string, CommandLineRefusal][] = [
      [`"C:\\Windows\\System32\\other.exe" /c x`, 'command-line-mismatch'],
      [`${CMD} /c x`, 'command-line-mismatch'],
      [`"${CMD}"/c x`, 'command-line-mismatch'],
      [`"${CMD}x" /c x`, 'command-line-mismatch'],
      ['', 'command-line-mismatch'],
      [`"${CMD}" /c a\0b`, 'nul'],
      [`"${CMD}" /c \uDC00`, 'unpaired-surrogate'],
    ]
    for (const [commandLine, kind] of cases) {
      expect(refusal(() => helperLaunch({ file: CMD, args: [], commandLine })).refusal, JSON.stringify(commandLine)).toBe(kind)
    }
  })

  it('accepts dots inside segment names, which normalization keeps', () => {
    for (const file of ['C:\\x\\.hidden\\node.exe', 'C:\\x\\a..b\\node.exe', 'C:\\Program Files\\nodejs\\node.exe', '\\\\srv\\share\\node.exe']) {
      expect(helperLaunch({ file, args: [] }).application, file).toBe(file)
    }
  })

  it('refuses a planned command line together with separate arguments, one of which would be ignored', () => {
    const commandLine = shellCommandLine(CMD, 'echo hi')
    expect(refusal(() => helperLaunch({ file: CMD, args: ['x'], commandLine })).refusal).toBe('command-line-mismatch')
  })

  it('refuses arguments that no command line can carry', () => {
    expect(refusal(() => helperLaunch({ file: NODE, args: ['a\0b'] })).refusal).toBe('nul')
    expect(refusal(() => helperLaunch({ file: NODE, args: ['\uD800'] })).refusal).toBe('unpaired-surrogate')
  })

  it('accepts a command line of exactly the CreateProcess limit and refuses one character more', () => {
    expect(WINDOWS_MAX_COMMAND_LINE).toBe(32_766)
    const program = `"${NODE}" `
    const longest = `${program}${'x'.repeat(WINDOWS_MAX_COMMAND_LINE - program.length)}`
    expect(helperLaunch({ file: NODE, args: [], commandLine: longest }).commandLine).toHaveLength(WINDOWS_MAX_COMMAND_LINE)
    const error = refusal(() => helperLaunch({ file: NODE, args: [], commandLine: `${longest}x` }))
    expect(error.refusal).toBe('command-line-too-long')
    expect(error.message).toBe(`The command line has 32767 characters, more than the 32766 Windows accepts`)
    // Quoting counts: an argument of 32,700 characters becomes too long with its quotes.
    expect(refusal(() => helperLaunch({ file: NODE, args: ['y'.repeat(WINDOWS_MAX_COMMAND_LINE - program.length - 1)] })).refusal).toBe('command-line-too-long')
    // A direct-mode line of 32,000 characters (the Windows integration test's) fits.
    expect(helperLaunch({ file: NODE, args: ['z'.repeat(32_000 - program.length - 2)] }).commandLine).toHaveLength(32_000)
  })

  it('never names an argument in a refusal', () => {
    const secret = 'token=s3cr3t-value'
    const error = refusal(() => helperLaunch({ file: NODE, args: [`${secret}\0`] }))
    expect(error.message).not.toContain(secret)
  })
})
