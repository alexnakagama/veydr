// Injection corpus for the `cmd-route-<route>-<case>` checks (design D3). Each case is a list of
// arguments passed to `fwd.cmd`, an npm-style shim (`@node "%~dp0record.mjs" %*`). A case passes on
// a route only if `record.mjs` receives exactly `args` and the case's sentinel file was not created.
// Check IDs are generated from these case IDs in checks.mjs, so an ID is never renamed.

/** The file an injected command in a case's arguments would create, in the probe's working directory. */
export const sentinelFor = (caseId) => `veydr-sentinel-${caseId}`

/** A command that creates `caseId`'s sentinel, as an injection would run it. */
const createSentinel = (caseId) => `type nul>${sentinelFor(caseId)}`

/** Longer than cmd.exe's 8191-character command line once escaped, though not before. */
const LONG_ARG = 'a&'.repeat(2000)

/** Just within cmd-quote.mjs's limits, and within cmd.exe's line on the shell route too. */
const NEAR_LIMIT_ARG = 'x'.repeat(7000)

export const CORPUS = Object.freeze(
  [
    { id: 'plain', args: ['hello'], description: 'a plain word: the baseline every route must pass' },
    { id: 'space', args: ['two words'], description: 'an embedded space, which must not split the argument' },
    { id: 'tab', args: ['two\twords'], description: 'an embedded tab, which must not split the argument' },
    { id: 'amp', args: [`x&${createSentinel('amp')}`], description: '`&` followed by a command that creates the sentinel' },
    { id: 'pipe', args: [`x|${createSentinel('pipe')}`], description: '`|` piping into a command that creates the sentinel' },
    { id: 'lt', args: ['a<b'], description: '`<`, which would redirect input from a file named b' },
    { id: 'gt', args: [`x>${sentinelFor('gt')}`], description: '`>`, which would redirect output into the sentinel' },
    { id: 'caret', args: ['a^b^^c^'], description: 'single, doubled and trailing `^` (a trailing caret continues the line)' },
    { id: 'paren', args: ['a)b(c'], description: 'unbalanced `)` and `(`' },
    { id: 'percent-var', args: ['%PATH%'], description: '`%PATH%`, which must not be expanded' },
    { id: 'percent-substitution', args: ['%PATH:\\=/%'], description: '`%PATH:\\=/%`, a substitution of a defined variable' },
    { id: 'percent-lone', args: ['100%'], description: 'a single `%`' },
    { id: 'percent-split', args: ['100%', '%PATH%'], description: 'a lone `%` in one argument before `%PATH%` in the next' },
    { id: 'percent-across', args: ['50%', 'PATH%'], description: 'two `%` in different arguments that would pair up around PATH' },
    { id: 'batch-params', args: ['%1', '%*', '%~dp0'], description: 'batch parameter references, which the shim must not expand' },
    { id: 'bang-var', args: ['!PATH!'], description: '`!PATH!`, which delayed expansion would expand' },
    { id: 'quote-embedded', args: ['say "hi"'], description: 'balanced embedded double quotes' },
    { id: 'quote-unbalanced', args: ['a"b'], description: 'a single embedded double quote' },
    {
      id: 'quote-inject',
      args: [`a"&${createSentinel('quote-inject')}&"b`],
      description: 'quotes that end a naively quoted argument early, then `&` and a command that creates the sentinel',
    },
    { id: 'backslash-trailing', args: ['C:\\dir\\', 'next'], description: 'a trailing backslash, which naive quoting turns into an escaped quote that swallows the next argument' },
    { id: 'backslash-quote', args: ['x\\"y'], description: 'a backslash directly before a double quote' },
    { id: 'delimiters', args: ['a,b;c=d'], description: '`,`, `;` and `=`, which cmd treats as delimiters in some positions' },
    { id: 'newline', args: ['a\nb'], description: 'a line feed, which ends a cmd command line' },
    { id: 'carriage-return', args: ['a\rb'], description: 'a carriage return, which cmd strips' },
    { id: 'non-ascii', args: ['grüße-日本語'], description: 'non-ASCII text outside every single-byte code page' },
    { id: 'empty', args: [''], description: 'an empty argument, which must arrive as one empty argument' },
    { id: 'near-limit', args: [NEAR_LIMIT_ARG], description: '7,000 plain characters, just within the line cmd-quote.mjs accepts, which must arrive intact' },
    { id: 'long', args: [LONG_ARG], description: '4,000 characters of `a&`, beyond cmd.exe\'s 8191-character line once escaped' },
  ].map((c) => Object.freeze({ ...c, args: Object.freeze(c.args) })),
)
