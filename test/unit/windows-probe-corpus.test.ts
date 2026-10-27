import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CORPUS, sentinelFor } from '../../scripts/windows-probe/cmd-corpus.mjs'
import { cmdShimArgs, cmdShimCommandLine, escapeForShim, MAX_COMMAND_LINE, quoteArgument, SHIM_LINE_RESERVE } from '../../scripts/windows-probe/cmd-quote.mjs'
import { ON_TIMEOUT_SMOKE_CHECKS, PACKAGED_ONLY_SMOKE_CHECKS, SMOKE_CHECKS } from '../../scripts/windows-probe/smoke-checks.mjs'
import { runSmokeTest, type SmokeDeps, type SmokeUi } from '../../src/main/app/smoke'
import { contract } from '../../src/shared/api'

// Design D3: the data the generated check IDs come from — the `.cmd` injection corpus, the candidate
// quoting under test, and the smoke test's check names.

const root = join(__dirname, '../..')

/** Splits a command line's arguments by the `CommandLineToArgvW` rules (after the program name). */
function commandLineToArgv(line: string): string[] {
  const args: string[] = []
  let i = 0
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i++
    if (i >= line.length) break
    let arg = ''
    let quoted = false
    while (i < line.length && (quoted || (line[i] !== ' ' && line[i] !== '\t'))) {
      const ch = line[i] ?? ''
      if (ch === '\\') {
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
      } else if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          arg += '"'
          i += 2
        } else {
          quoted = !quoted
          i++
        }
      } else {
        arg += ch
        i++
      }
    }
    args.push(arg)
  }
  return args
}

/** cmd.exe's caret phase on text outside quotes: `^x` becomes a literal `x`. */
const removeCarets = (text: string): string => text.replace(/\^([\s\S])/g, '$1')

/** Whether every cmd metacharacter in `text` is escaped by a caret, so cmd never treats one as special. */
function everyMetacharacterEscaped(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '^') {
      if (i + 1 >= text.length) return false
      i++
    } else if ('"&|<>()%!'.includes(text[i] ?? '')) {
      return false
    }
  }
  return true
}

describe('cmd-corpus.mjs', () => {
  it('has unique, ID-safe case IDs with a description and at least one argument', () => {
    const ids = CORPUS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of CORPUS) {
      expect(c.id, c.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      expect(c.description.trim(), c.id).not.toBe('')
      expect(c.args.length, c.id).toBeGreaterThan(0)
      for (const arg of c.args) expect(typeof arg, c.id).toBe('string')
    }
  })

  it('covers every class of design D3, and percent signs across arguments', () => {
    const args = CORPUS.flatMap((c) => c.args)
    for (const ch of ['&', '|', '<', '>', '^', '(', ')', ' ', '\n', '\r']) expect(args.some((a) => a.includes(ch)), JSON.stringify(ch)).toBe(true)
    expect(args.some((a) => /%\w+%/.test(a))).toBe(true)
    expect(args.some((a) => /!\w+!/.test(a))).toBe(true)
    expect(args.some((a) => (a.match(/"/g) ?? []).length === 2)).toBe(true)
    expect(args.some((a) => (a.match(/"/g) ?? []).length === 1)).toBe(true)
    expect(args.some((a) => a.endsWith('\\'))).toBe(true)
    expect(args.some((a) => /[^\x00-\x7f]/.test(a))).toBe(true)
    expect(args).toContain('')
    expect(CORPUS.some((c) => c.args.length > 1 && c.args.filter((a) => a.includes('%')).length > 1)).toBe(true)
    for (const reference of ['%1', '%*', '%~dp0']) expect(args).toContain(reference)
  })

  it('names only its own sentinel in each injection payload', () => {
    for (const c of CORPUS) {
      const named = c.args.join(' ').match(/veydr-sentinel-[a-z0-9-]+/g) ?? []
      for (const name of named) expect(name, c.id).toBe(sentinelFor(c.id))
    }
    expect(CORPUS.filter((c) => c.args.some((a) => a.includes(sentinelFor(c.id)))).map((c) => c.id)).toEqual(['amp', 'pipe', 'gt', 'quote-inject'])
  })
})

describe('cmd-quote.mjs', () => {
  it('quotes arguments by the CommandLineToArgvW rules', () => {
    expect(quoteArgument('hello')).toBe('"hello"')
    expect(quoteArgument('')).toBe('""')
    expect(quoteArgument('a"b')).toBe('"a\\"b"')
    expect(quoteArgument('x\\"y')).toBe('"x\\\\\\"y"')
    expect(quoteArgument('C:\\dir\\')).toBe('"C:\\dir\\\\"')
    expect(quoteArgument('a\\b')).toBe('"a\\b"')
  })

  it('builds the expected command lines for representative cases', () => {
    const shim = 'C:\\probe\\fwd.cmd'
    expect(cmdShimCommandLine(shim, ['hello'])).toBe('""C:\\probe\\fwd.cmd" ^^^"hello^^^""')
    expect(cmdShimCommandLine(shim, ['two words', ''])).toBe('""C:\\probe\\fwd.cmd" ^^^"two words^^^" ^^^"^^^""')
    expect(cmdShimCommandLine(shim, ['x&y'])).toBe('""C:\\probe\\fwd.cmd" ^^^"x^^^&y^^^""')
    expect(cmdShimCommandLine(shim, ['%PATH%'])).toBe('""C:\\probe\\fwd.cmd" ^^^"^^^%^PATH^^^%^^^""')
    expect(cmdShimCommandLine(shim, ['100% done'])).toBe('""C:\\probe\\fwd.cmd" ^^^"100^^^%^ done^^^""')
    expect(cmdShimCommandLine(shim, ['a"b'])).toBe('""C:\\probe\\fwd.cmd" ^^^"a\\^^^"b^^^""')
    expect(cmdShimCommandLine(shim, ['C:\\dir\\'])).toBe('""C:\\probe\\fwd.cmd" ^^^"C:\\dir\\\\^^^""')
    expect(cmdShimCommandLine(shim, ['50%', 'PATH%'])).toBe('""C:\\probe\\fwd.cmd" ^^^"50^^^%^^^" ^^^"PATH^^^%^^^""')
    expect(cmdShimArgs(shim, ['hello'])).toEqual(['/d', '/v:off', '/s', '/c', '""C:\\probe\\fwd.cmd" ^^^"hello^^^""'])
  })

  // Not a substitute for the probe (cmd.exe's parser is only modelled here), but it pins the
  // properties the quoting relies on for every case the probe runs.
  const representable = CORPUS.filter((c) => c.args.every((a) => !/[\n\r]/.test(a)) && c.id !== 'long')
  // The near-limit case passes both length checks.
  expect(representable.map((c) => c.id)).toContain('near-limit')
  it.each(representable.map((c) => [c.id, c.args] as const))('keeps every metacharacter escaped through both cmd.exe parses and round-trips %s', (_id, args) => {
    const line = cmdShimCommandLine('C:\\probe\\fwd.cmd', args)
    // `/s` removes the outer quotes; the command path is quoted, the arguments follow it.
    const escaped = line.slice(1, -1).replace(/^"C:\\probe\\fwd\.cmd" /, '')
    // Parse 1 (the /c line): every metacharacter escaped, and no `%` that could start a variable
    // name, however the `%` signs of different arguments pair up.
    expect(everyMetacharacterEscaped(escaped)).toBe(true)
    expect(escaped).not.toMatch(/%(?!\^)/)
    // Parse 2 (the batch line `%*` is substituted into): still escaped.
    const afterParse1 = removeCarets(escaped)
    expect(everyMetacharacterEscaped(afterParse1)).toBe(true)
    // The target program then receives the CommandLineToArgvW quoting of the arguments.
    const received = removeCarets(afterParse1)
    expect(received).toBe(args.map(quoteArgument).join(' '))
    expect(commandLineToArgv(received)).toEqual(args)
  })

  it('escapes a lone argument the same way inside a line', () => {
    expect(escapeForShim(quoteArgument('a&b'))).toBe('^^^"a^^^&b^^^"')
  })

  it('refuses arguments and command paths that cmd.exe cannot carry', () => {
    for (const arg of ['a\nb', 'a\rb', 'a\0b']) expect(() => cmdShimCommandLine('C:\\fwd.cmd', [arg])).toThrow(/line break or NUL/)
    for (const command of ['C:\\a"b\\fwd.cmd', 'C:\\%TEMP%\\fwd.cmd', 'C:\\a\nb\\fwd.cmd']) {
      expect(() => cmdShimCommandLine(command, [])).toThrow(/cannot quote command path/)
    }
  })

  it('refuses a /c line longer than cmd.exe allows', () => {
    const shim = `C:\\${'d'.repeat(SHIM_LINE_RESERVE)}\\fwd.cmd`
    const overhead = cmdShimCommandLine(shim, ['']).length
    expect(cmdShimCommandLine(shim, ['a'.repeat(MAX_COMMAND_LINE - overhead)])).toHaveLength(MAX_COMMAND_LINE)
    expect(() => cmdShimCommandLine(shim, ['a'.repeat(MAX_COMMAND_LINE - overhead + 1)])).toThrow(/escaped line has 8192 characters, more than 8191/)
  })

  it('keeps room on the shim\'s batch line for the shim\'s own text', () => {
    const shim = 'C:\\fwd.cmd'
    // On the batch line an argument of n plain characters is `^"…^"` plus a separator: n + 5 characters.
    const fits = MAX_COMMAND_LINE - SHIM_LINE_RESERVE - 5
    expect(() => cmdShimCommandLine(shim, ['a'.repeat(fits)])).not.toThrow()
    expect(() => cmdShimCommandLine(shim, ['a'.repeat(fits + 1)])).toThrow(/more than 7167/)
  })

  it('refuses the long corpus case, whose arguments alone fit', () => {
    const shim = 'C:\\fwd.cmd'
    const long = CORPUS.find((c) => c.id === 'long')
    expect(long?.args.join(' ').length).toBeLessThan(MAX_COMMAND_LINE)
    expect(() => cmdShimCommandLine(shim, long?.args ?? [])).toThrow(/more than 8191/)
  })
})

describe('smoke-checks.mjs', () => {
  const goodUi: SmokeUi = { url: 'app://veydr/index.html', bridge: Object.keys(contract), rendered: true, sandbox: true, contextIsolation: true, devToolsOpened: false }
  const deps = (overrides: Partial<SmokeDeps> = {}): SmokeDeps => ({
    packaged: true,
    appPath: 'C:\\Veydr\\resources\\app.asar',
    configDir: () => 'C:\\Users\\dev\\AppData\\Roaming\\Veydr',
    implementation: { name: 'linux', supported: true, portInspector: { list: () => Promise.resolve({ takenAt: 0, ports: [] }) } },
    noSandbox: false,
    loadUi: () => Promise.resolve(goodUi),
    fs: { mkdir: () => Promise.resolve(), writeNew: () => Promise.resolve(), remove: () => Promise.resolve() },
    ...overrides,
  })

  it('equals the check names smoke.ts can report', () => {
    const source = readFileSync(join(root, 'src/main/app/smoke.ts'), 'utf8')
    const named = [...source.matchAll(/\bcheck\('([^']+)'|\bname: '([^']+)'/g)].map((m) => m[1] ?? m[2])
    expect(named.length).toBeGreaterThan(0)
    expect([...new Set(named)].sort()).toEqual([...SMOKE_CHECKS].sort())
  })

  it('equals the names a full run and a timed-out run report, in report order', async () => {
    const full = await runSmokeTest(deps())
    const timedOut = await runSmokeTest(deps({ loadUi: () => new Promise<SmokeUi>(() => undefined), timeoutMs: 10 }))
    const reported = [...full.checks, ...timedOut.checks].map((c) => c.name)
    expect(SMOKE_CHECKS.filter((name) => reported.includes(name))).toEqual([...new Set(reported)])
    expect(new Set(reported)).toEqual(new Set(SMOKE_CHECKS))
  })

  it('lists exactly the checks an unpackaged build skips, and those reported only on a timeout', async () => {
    const unpackaged = await runSmokeTest(deps({ packaged: false, loadUi: () => Promise.resolve({ ...goodUi, devToolsOpened: null }) }))
    expect(unpackaged.checks.map((c) => c.name)).toEqual(SMOKE_CHECKS.filter((n) => !PACKAGED_ONLY_SMOKE_CHECKS.includes(n) && !ON_TIMEOUT_SMOKE_CHECKS.includes(n)))
    const packaged = await runSmokeTest(deps())
    expect(packaged.checks.map((c) => c.name)).toEqual(SMOKE_CHECKS.filter((n) => !ON_TIMEOUT_SMOKE_CHECKS.includes(n)))
  })
})
