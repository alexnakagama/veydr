#!/usr/bin/env node
// Every check of the Windows probes (design D3), with its predicted answer. The probes report
// answers, summary.mjs derives each status from them and the predictions here, and the evidence
// tests read the same list, so the IDs cannot drift.
//
// Predictions were fixed before any probe ran (design D3). test/windows-probe/predictions.json is
// their snapshot, generated once by `node scripts/windows-probe/checks.mjs snapshot <file>` and
// never edited. A prediction changed or a check added afterwards needs an entry in REVISIONS;
// test/unit/windows-probe-summary.test.ts fails otherwise.
//
// Every check runs from a driver without a console (D9); `context.user` is the account it runs as.
// `controls` are the control checks that must answer `yes` in the same probe area and account for
// the check's answer to count (summary.mjs).
import { createHash } from 'node:crypto'
import { realpathSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CORPUS } from './cmd-corpus.mjs'
import { cmdShimCommandLine } from './cmd-quote.mjs'
import { PACKAGED_ONLY_SMOKE_CHECKS, SMOKE_CHECKS } from './smoke-checks.mjs'

/** The probe areas, one workflow job each, as named in each job's identity line. */
export const PROBE_AREAS = Object.freeze(['process-tree', 'helper', 'commands', 'environment', 'encoding', 'ports', 'electron', 'nsis'])

/** Checks of this area are run by every driver and may be reported from any probe area. */
export const CONTEXT_AREA = 'context'

/** Routes of `cmd-route-<route>-<case>`. */
export const CMD_ROUTES = Object.freeze({
  shell: "Node's `shell: true`, with the argument passed as an `args` entry",
  verbatim: '`cmd.exe /d /v:off /s /c` with `windowsVerbatimArguments` and the quoting of cmd-quote.mjs',
})

/** The fixed text each `enc-child-<tool>-<variant>` tool prints: ASCII, Latin-1, and characters outside every single-byte code page. */
export const ENCODING_TEST_STRING = 'Grüße ✓ 日本語'

export const ENCODING_TOOLS = Object.freeze({
  cmd: '`cmd /c echo`',
  node: '`node -e` writing to stdout',
  python: '`python -c` printing (NOT-TESTABLE if Python is not installed)',
})

export const ENCODING_VARIANTS = Object.freeze({
  plain: 'without any encoding setting',
  utf8: 'after `chcp 65001` (cmd, node) or with `PYTHONUTF8=1` (python)',
})

const ADMIN = { console: 'none', user: 'admin' }
const STANDARD = { console: 'none', user: 'standard' }
const BOTH = { console: 'none', user: 'both' }

const NO_CONSOLE = 'ctx-no-console'
const STANDARD_USER = 'ctx-standard-user'

/** A check the probes answer. `options.control` marks a control check; `options.context` defaults to admin. */
function check(id, area, question, [prediction, reason], feeds, { context = ADMIN, controls, control = false } = {}) {
  const defaultControls = context.user === 'standard' ? [NO_CONSOLE, STANDARD_USER] : [NO_CONSOLE]
  return { kind: 'check', id, area, question, prediction, reason, feeds, context, controls: controls ?? defaultControls, control }
}

/** A standard-user (`-std`) variant: same question, run as the temporary standard user (D9). */
function standardVariant(base, prediction, { controls } = {}) {
  return check(`${base.id}-std`, base.area, base.question, prediction, base.feeds, {
    context: STANDARD,
    controls: controls ?? base.controls.flatMap((c) => (c === NO_CONSOLE ? [NO_CONSOLE, STANDARD_USER] : [`${c}-std`])),
    control: base.control,
  })
}

/** A runner limit (D3): never answered, so it has no prediction; the summary always writes it as NOT-TESTABLE. */
const limit = (id, area, reason, verify) => ({ kind: 'limit', id, area, reason, verify })

// ---------------------------------------------------------------------------------------------
// Context (D9)

const contextChecks = [
  check(
    NO_CONSOLE,
    CONTEXT_AREA,
    'Control: does the probe driver have no console, like Electron\'s main process (`GetConsoleWindow` returns no window and `AttachConsole(ATTACH_PARENT_PROCESS)` fails)?',
    ['yes', 'launch-detached.mjs starts drivers with `detached: true` (DETACHED_PROCESS), which gives a process no console'],
    ['all probes'],
    { context: BOTH, controls: [], control: true },
  ),
  check(
    STANDARD_USER,
    CONTEXT_AREA,
    'Control: is the `-std` driver\'s token unelevated and outside Administrators, with `HKCU\\Environment` readable and the probe directory usable?',
    ['yes', 'an account created by `New-LocalUser` belongs to Users only, and CreateProcessWithLogonW with LOGON_WITH_PROFILE loads its registry hive'],
    ['all -std checks'],
    { context: STANDARD, controls: [], control: true },
  ),
  check(
    'ctx-job',
    CONTEXT_AREA,
    'Is the probe driver outside any Job Object, as Veydr is when started from Explorer?',
    ['no', 'the runner probably runs each step inside a Job Object of its own, which the driver inherits'],
    ['process-tree', 'helper'],
    { context: BOTH },
  ),
]

// ---------------------------------------------------------------------------------------------
// Process tree (W1)

const PT_CONTROL = 'pt-control'
const ptOptions = { controls: [NO_CONSOLE, PT_CONTROL] }

const ptControl = check(
  PT_CONTROL,
  'process-tree',
  'Control: does every stop method the probe uses end a single plain child that has no descendants?',
  ['yes', 'TerminateProcess, `taskkill /F` and TerminateJobObject each end a lone process'],
  ['all process-tree checks'],
  { control: true },
)

const ptJobTerminate = check(
  'pt-job-terminate',
  'process-tree',
  'Does an own Job Object, assigned right after spawn, contain all later descendants, including orphans, and does `TerminateJobObject` end them all?',
  ['yes', 'our job is the leader\'s innermost job and allows no breakaway, so later descendants stay in it whatever libuv\'s job allows'],
  ['W1', 'G-4'],
  ptOptions,
)

/** Children of `pt-ctrl-break-attach-<child>`, each running a script whose SIGBREAK handler writes a marker and exits 0. */
const ATTACH_CHILDREN = {
  node: {
    what: '`node` running the script',
    prediction: ['yes', 'the child has a hidden console of its own, event 0 reaches every process on it, and Node runs the SIGBREAK handler'],
    standard: ['yes', 'attaching to the console of one\'s own process needs no administrator rights'],
    feeds: ['W1 graceful stop', 'G-4'],
  },
  npm: {
    what: '`npm run` of a package script running it (through `npm.cmd`)',
    prediction: ['no', 'npm.cmd is a batch file: on Ctrl+Break cmd.exe asks "Terminate batch job (Y/N)?" and waits on the piped stdin, so the tree does not exit'],
    standard: ['no', 'the batch-job prompt does not depend on the account'],
    feeds: ['W1 graceful stop', 'G-4'],
  },
  cmd: {
    what: '`cmd /c` running the script with `node` (a program, not a batch file)',
    prediction: ['yes', 'cmd.exe /c running a program, not a batch file, does not prompt and exits when the program exits'],
    standard: ['yes', 'attaching to the console of one\'s own process needs no administrator rights'],
    feeds: ['W1 graceful stop'],
  },
}

function ctrlBreakAttachChecks() {
  return Object.entries(ATTACH_CHILDREN).flatMap(([child, { what, prediction, standard, feeds }]) => {
    const base = check(
      `pt-ctrl-break-attach-${child}`,
      'process-tree',
      `For ${what}, started with \`windowsHide: true\` and not detached, does an attaching helper (\`SetConsoleCtrlHandler(NULL, TRUE)\`, \`FreeConsole\`, \`AttachConsole(childPid)\`, \`GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, 0)\`) stop it gracefully, meaning the script's SIGBREAK handler writes its marker and the child's whole tree exits within 5 s, while the driver and the helper keep running?`,
      prediction,
      feeds,
      ptOptions,
    )
    return [base, standardVariant(base, standard)]
  })
}

const processTreeChecks = [
  ptControl,
  standardVariant(ptControl, ['yes', 'ending one\'s own processes needs no administrator rights']),
  check(
    'pt-libuv-job',
    'process-tree',
    'Is a child spawned with `child_process.spawn` inside a Job Object that the driver did not create (libuv\'s own job), per `IsProcessInJob`?',
    ['yes', 'libuv assigns every child not spawned `detached` to a global job of its own'],
    ['W1'],
    ptOptions,
  ),
  check(
    'pt-libuv-breakaway',
    'process-tree',
    'Can a grandchild started with `CREATE_BREAKAWAY_FROM_JOB` leave libuv\'s job?',
    ['yes', 'libuv\'s job sets JOB_OBJECT_LIMIT_BREAKAWAY_OK and JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK'],
    ['W1'],
    ptOptions,
  ),
  check(
    'pt-kill-leader',
    'process-tree',
    'After `child.kill()` (TerminateProcess on the leader), are the leader\'s descendants ended too?',
    ['no', 'TerminateProcess ends one process; Windows does not end a process\'s descendants with it'],
    ['W1'],
    ptOptions,
  ),
  check(
    'pt-taskkill-tree',
    'process-tree',
    'Does `taskkill /T /F` on a live leader end every descendant?',
    ['yes', '`/T` walks the parent-PID links from a live leader, which reach every descendant whose parent is alive'],
    ['W1', 'G-4'],
    ptOptions,
  ),
  check(
    'pt-taskkill-orphan',
    'process-tree',
    'Does `taskkill /T /F` on the leader also end a grandchild whose parent already exited?',
    ['no', 'an orphan\'s parent PID names an exited process, so the walk from the leader does not reach it'],
    ['W1', 'G-4'],
    ptOptions,
  ),
  ptJobTerminate,
  standardVariant(ptJobTerminate, ['yes', 'creating and assigning a job for one\'s own processes needs no administrator rights']),
  check(
    'pt-parent-exit-leader',
    'process-tree',
    'When the spawning process is killed with TerminateProcess (as a crash would end Veydr), does its direct child (the leader) keep running?',
    ['no', 'the leader is in libuv\'s job, which has JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so it ends when the parent\'s job handle closes'],
    ['W1'],
    ptOptions,
  ),
  check(
    'pt-parent-exit-descendant',
    'process-tree',
    'When the spawning process is killed with TerminateProcess (as a crash would end Veydr), does a grandchild started by its leader keep running?',
    ['yes', 'libuv\'s job has JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK, so the grandchild is outside that job and is not ended with it'],
    ['W1'],
    ptOptions,
  ),
  check(
    'pt-job-race',
    'process-tree',
    'Is a grandchild created between spawn and job assignment still contained by the job?',
    ['no', 'assigning a process to a job does not move descendants it already created'],
    ['W1', 'G-4'],
    ptOptions,
  ),
  check(
    'pt-ctrl-break-direct',
    'process-tree',
    'From the console-less parent, does `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT)` reach a child started in a new process group?',
    ['no', 'a console control event reaches only processes on the caller\'s console, and the driver has none'],
    ['W1 graceful stop'],
    ptOptions,
  ),
  ...ctrlBreakAttachChecks(),
  check(
    'pt-ctrl-break-detached',
    'process-tree',
    'Can the attaching helper make a child started with `detached: true` (no console of its own) exit gracefully?',
    ['no', 'a detached child has no console, so there is nothing to attach to and no console event can reach it'],
    ['W1'],
    ptOptions,
  ),
  check(
    'pt-ctrl-c',
    'process-tree',
    'Is Ctrl+C ignored by a process started in a new process group, as documented?',
    ['yes', 'CREATE_NEW_PROCESS_GROUP disables Ctrl+C handling in the new group\'s first process'],
    ['W1 graceful stop'],
    ptOptions,
  ),
  check(
    'pt-console-window',
    'process-tree',
    'With `windowsHide: true`, does a console child of the console-less parent get a console without a visible window?',
    ['yes', '`windowsHide` starts the child with SW_HIDE, so the console Windows creates for it has a hidden window'],
    ['W1', 'W2'],
    ptOptions,
  ),
  check(
    'pt-identity',
    'process-tree',
    'Is PID plus creation time (`GetProcessTimes`) stable for a process across reads?',
    ['yes', 'a process\'s creation time is fixed when it starts'],
    ['W1 identity', 'W3'],
    ptOptions,
  ),
  check(
    'pt-identity-reuse',
    'process-tree',
    'When a PID is reused, does the new process have a different creation time?',
    ['yes', 'a PID is reused only after its process has ended, so the new process started later'],
    ['W1 identity'],
    ptOptions,
  ),
]

// ---------------------------------------------------------------------------------------------
// Helper (G-4 option C)

const helperCscBuild = check(
  'helper-csc-build',
  'helper',
  'Does `csc.exe` from .NET Framework 4.8 compile a minimal C# helper, and does that helper, started from the console-less parent, create a Job Object, assign a child, and end the child and its grandchild?',
  ['yes', '.NET Framework 4.8 and its `csc.exe` are part of Windows Server 2025, and the Job Object APIs need no privileges'],
  ['G-4 option C'],
)

const helperChecks = [helperCscBuild, standardVariant(helperCscBuild, ['yes', 'compiling into and running from a directory the user owns needs no administrator rights'])]

// ---------------------------------------------------------------------------------------------
// Commands (W2)

/** Predicted answer per route and corpus case. */
const ROUTE_PREDICTIONS = {
  shell: {
    plain: ['yes', 'nothing in the argument is special to cmd.exe'],
    space: ['no', 'Node joins the arguments with spaces and does not quote them, so the argument is split'],
    tab: ['no', 'the unquoted tab splits the argument'],
    amp: ['no', 'the unquoted `&` runs the command after it'],
    pipe: ['no', 'the unquoted `|` pipes into the command after it'],
    lt: ['no', 'the unquoted `<` redirects input from a missing file, so the shim does not run'],
    gt: ['no', 'the unquoted `>` redirects output into the sentinel'],
    caret: ['no', 'cmd.exe removes unquoted carets'],
    paren: ['yes', 'parentheses outside a command block are literal'],
    'percent-var': ['no', 'cmd.exe expands a defined variable on the `/c` command line'],
    'percent-substitution': ['no', 'cmd.exe performs the substitution on the defined variable PATH'],
    'percent-lone': ['yes', 'a single `%` names no variable and is left as it is on a command line'],
    'percent-split': ['no', 'the unescaped `%PATH%` in the second argument is expanded'],
    'percent-across': ['yes', 'the two `%` enclose " PATH", which is not defined, so cmd.exe leaves them as they are'],
    'batch-params': ['yes', 'batch parameters are not expanded on a command line, and `%*`\'s substituted text is not expanded again'],
    'bang-var': ['yes', 'delayed expansion is off by default'],
    'quote-embedded': ['no', 'the target program removes the unescaped quotes'],
    'quote-unbalanced': ['no', 'the target program removes the unescaped quote'],
    'quote-inject': ['no', 'the quotes protect `&`, but the target program removes them'],
    'backslash-trailing': ['yes', 'unquoted, the trailing backslash is literal to cmd.exe and to the target program, so the next argument stays separate'],
    'backslash-quote': ['no', 'the target program reads `\\"` as an escaped quote and drops the backslash'],
    delimiters: ['yes', '`%*` keeps `,`, `;` and `=`, and the target program does not split on them'],
    newline: ['no', 'cmd.exe ends a command line at a line break'],
    'carriage-return': ['no', 'cmd.exe strips carriage returns from a command line'],
    'non-ascii': ['yes', 'cmd.exe passes its UTF-16 command line on unchanged'],
    empty: ['no', 'Node passes an empty argument as nothing, so it disappears'],
    'near-limit': ['yes', 'plain characters need no quoting, and the line stays within cmd.exe\'s 8191 characters'],
    long: ['no', 'each unquoted `&` runs the following `a` as a command'],
  },
  verbatim: Object.fromEntries(
    CORPUS.map((c) => [c.id, ['yes', 'the candidate quotes for the target program and escapes every metacharacter for both cmd.exe parses']]),
  ),
}

/**
 * Corpus cases the candidate quoting refuses before spawning, because cmd.exe cannot carry them
 * unchanged. On the verbatim route the check asks whether the case is refused, so a route whose
 * cases all pass can be adopted (D5) with these inputs rejected up front.
 */
const VERBATIM_REFUSED = {
  newline: 'cmd.exe ends a command line at a line feed',
  'carriage-return': 'cmd.exe strips carriage returns from a command line',
  long: 'escaped, the arguments exceed cmd.exe\'s 8191-character line',
}

/** Whether cmd-quote.mjs refuses the case, so VERBATIM_REFUSED cannot drift from the code. */
function refusedByCandidate(c) {
  try {
    cmdShimCommandLine('C:\\probe\\fwd.cmd', c.args)
    return false
  } catch {
    return true
  }
}

function routeChecks() {
  return Object.entries(CMD_ROUTES).flatMap(([route, routeDescription]) =>
    CORPUS.map((c) => {
      const id = `cmd-route-${route}-${c.id}`
      if (route === 'verbatim' && (c.id in VERBATIM_REFUSED) !== refusedByCandidate(c)) {
        throw new Error(`checks.mjs: VERBATIM_REFUSED and cmd-quote.mjs disagree on corpus case ${c.id}`)
      }
      if (route === 'verbatim' && c.id in VERBATIM_REFUSED) {
        return check(
          id,
          'commands',
          `Does the candidate quoting of cmd-quote.mjs refuse corpus case ${c.id} (${c.description}) before anything is spawned, since cmd.exe cannot carry it unchanged?`,
          ['yes', `${VERBATIM_REFUSED[c.id]}, and cmd-quote.mjs throws for it`],
          ['W2'],
        )
      }
      const prediction = ROUTE_PREDICTIONS[route][c.id]
      if (prediction === undefined) throw new Error(`checks.mjs: no prediction for corpus case ${c.id} on route ${route}`)
      return check(
        id,
        'commands',
        `Through ${routeDescription}, does corpus case ${c.id} (${c.description}) arrive unchanged in the program behind an npm-style \`.cmd\` shim, with no injected command run?`,
        prediction,
        ['W2'],
      )
    }),
  )
}

const commandChecks = [
  check(
    'cmd-direct-spawn',
    'commands',
    'Is spawning `x.cmd` without a shell refused with `EINVAL` (CVE-2024-27980 hardening)?',
    ['yes', 'Node 18.20.2, 20.12.2 and later refuse `.cmd` and `.bat` files without `shell`'],
    ['W2'],
  ),
  ...routeChecks(),
  check(
    'cmd-pathext',
    'commands',
    'Is `npm` resolved to `npm.cmd` through `PATH` and `PATHEXT`?',
    ['yes', 'cmd.exe tries each `PATHEXT` extension in each `PATH` directory, and `.CMD` is in the default `PATHEXT`'],
    ['W2'],
  ),
  check(
    'cmd-pathext-cwd',
    'commands',
    'When the working directory holds an `npm.cmd` decoy that is not on `PATH`, is the decoy left unused by `cmd.exe /d /s /c npm --version`?',
    ['no', 'cmd.exe searches the current directory before `PATH` unless NoDefaultCurrentDirectoryInExePath is set, which it is not by default'],
    ['W2'],
  ),
]

// ---------------------------------------------------------------------------------------------
// Environment (W2)

const envRegistry = check(
  'env-registry',
  'environment',
  'For every variable defined both in the registry environment (user over machine, except `Path`, which is the machine value followed by the user value; `REG_EXPAND_SZ` expanded) and in the driver\'s inherited environment, are the values equal?',
  ['no', 'setup steps prepend to `PATH` through GITHUB_PATH, which changes the job\'s environment but not the registry'],
  ['W2'],
)

const environmentChecks = [
  envRegistry,
  standardVariant(envRegistry, [
    'yes',
    'the driver is started by CreateProcessWithLogonW with LOGON_WITH_PROFILE and no environment block (D9), which Windows documents as building the environment from that user\'s profile, as at logon',
  ]),
  check(
    'env-path-case',
    'environment',
    'When `child_process.spawn` gets an environment whose only path variable is spelled `PATH`, does the child see exactly one path variable, with that value?',
    ['yes', 'Windows looks up environment variables case-insensitively and Node passes the single entry on as given'],
    ['W2'],
  ),
]

// ---------------------------------------------------------------------------------------------
// Encoding (W2)

/** Predicted answer per tool and variant. */
const ENCODING_PREDICTIONS = {
  cmd: {
    plain: ['no', 'cmd.exe writes to a pipe in the console code page, the OEM code page 437 on English Windows, which lacks ✓ and 日本語'],
    utf8: ['yes', 'after `chcp 65001` cmd.exe writes UTF-8'],
  },
  node: {
    plain: ['yes', 'Node always writes strings to a pipe as UTF-8'],
    utf8: ['yes', 'Node always writes strings to a pipe as UTF-8'],
  },
  python: {
    plain: ['no', 'Python writes to a pipe in the ANSI code page (1252 on English Windows), which cannot encode ✓ or 日本語'],
    utf8: ['yes', '`PYTHONUTF8=1` makes Python write UTF-8'],
  },
}

function encodingChildChecks() {
  return Object.entries(ENCODING_TOOLS).flatMap(([tool, toolDescription]) =>
    Object.entries(ENCODING_VARIANTS).map(([variant, variantDescription]) => {
      const prediction = ENCODING_PREDICTIONS[tool]?.[variant]
      if (prediction === undefined) throw new Error(`checks.mjs: no prediction for encoding tool ${tool}, variant ${variant}`)
      return check(
        `enc-child-${tool}-${variant}`,
        'encoding',
        `Does ${toolDescription}, ${variantDescription}, deliver the fixed test string as valid UTF-8 that decodes to exactly that string?`,
        prediction,
        ['W2'],
      )
    }),
  )
}

const encodingChecks = [
  check(
    'enc-codepages',
    'encoding',
    'Is the console output code page of a console child of the console-less parent UTF-8 (65001) without any `chcp`?',
    ['no', 'a new console starts in the OEM code page (437 on English Windows) unless the system-wide UTF-8 option is on, which it is not by default'],
    ['W2'],
  ),
  ...encodingChildChecks(),
]

// ---------------------------------------------------------------------------------------------
// Ports (W3)

const PORT_CONTROL = 'port-control'
const portOptions = { controls: [NO_CONSOLE, PORT_CONTROL] }
const STANDARD_PORT_CONTROLS = [NO_CONSOLE, STANDARD_USER, `${PORT_CONTROL}-std`]

const portControl = check(
  PORT_CONTROL,
  'ports',
  'Control: does at least one method list the probe helper\'s own listening sockets with its PID?',
  ['yes', 'a process can always see its own sockets in the system\'s TCP table'],
  ['all ports checks'],
  { control: true },
)

const portPs = check(
  'port-ps',
  'ports',
  'Does `Get-NetTCPConnection` list each of the helper\'s listeners on `127.0.0.1`, `::1` and `0.0.0.0` with the helper\'s PID?',
  ['yes', 'Get-NetTCPConnection reports the listening sockets with their owning PIDs'],
  ['W3'],
  portOptions,
)

const portApi = check(
  'port-api',
  'ports',
  'Does `GetExtendedTcpTable` (P/Invoke) list each of the helper\'s listeners on `127.0.0.1`, `::1` and `0.0.0.0` with the helper\'s PID?',
  ['yes', 'the owner-PID TCP tables (IPv4 and IPv6) list every listening socket'],
  ['W3', 'G-4'],
  portOptions,
)

const portOwnerIdentity = check(
  'port-owner-identity',
  'ports',
  'Can the probe read the owning process\'s name and creation time for every listener on the machine?',
  ['yes', 'an elevated administrator can open every process, including services and System, for limited query'],
  ['W3'],
  portOptions,
)

const portChecks = [
  portControl,
  standardVariant(portControl, ['yes', 'a process can always see its own sockets in the system\'s TCP table']),
  check(
    'port-netstat',
    'ports',
    'Does `netstat -ano` list each of the helper\'s listeners on `127.0.0.1`, `::1` and `0.0.0.0` with the helper\'s PID?',
    ['yes', '`-a` lists listening sockets and `-o` their owning PIDs'],
    ['W3'],
    portOptions,
  ),
  portPs,
  standardVariant(portPs, ['yes', 'the CIM class behind Get-NetTCPConnection is readable by standard users'], { controls: STANDARD_PORT_CONTROLS }),
  portApi,
  standardVariant(portApi, ['yes', 'GetExtendedTcpTable needs no privileges'], { controls: STANDARD_PORT_CONTROLS }),
  check(
    'port-ps-latency',
    'ports',
    'As a standard user, is the median of 10 `Get-NetTCPConnection` calls at most 300 ms, and the slowest at most 1 s?',
    ['no', 'Get-NetTCPConnection goes through CIM (WMI), whose calls take hundreds of milliseconds, and the first call also loads its module'],
    ['W3'],
    { context: STANDARD, controls: STANDARD_PORT_CONTROLS },
  ),
  check(
    'port-api-latency',
    'ports',
    'As a standard user, is the median of 10 `GetExtendedTcpTable` calls at most 300 ms, and the slowest at most 1 s?',
    ['yes', 'one call copies a kernel table, which takes milliseconds'],
    ['W3'],
    { context: STANDARD, controls: STANDARD_PORT_CONTROLS },
  ),
  portOwnerIdentity,
  standardVariant(portOwnerIdentity, ['no', 'a standard user cannot open processes of SYSTEM and service accounts, which own some listeners'], {
    controls: STANDARD_PORT_CONTROLS,
  }),
]

// ---------------------------------------------------------------------------------------------
// Electron and installer (W1–W4 CI, W4)

/** Predicted answer per smoke check, for both the built app and the installed one. */
const SMOKE_PREDICTIONS = {
  'process-sandbox': ['yes', 'nothing on Windows adds `--no-sandbox`'],
  'config-dir-writable': ['yes', 'the user\'s AppData directory is writable'],
  platform: ['no', 'Windows has no platform implementation yet, so the smoke test reports it as unsupported'],
  'ui-loaded': ['yes', 'the bundled UI does not depend on the platform implementation to render'],
  'preload-bridge': ['yes', 'the preload exposes the same API groups on every OS'],
  'renderer-isolation': ['yes', 'sandbox and context isolation are set in code, not per OS'],
  'devtools-disabled': ['yes', 'DevTools are disabled in packaged builds on every OS'],
  timeout: ['yes', 'the smoke test\'s checks finish well within its 30 s limit'],
}

function smokeChecks(prefix, area, what, { packaged }) {
  return SMOKE_CHECKS.filter((name) => packaged || !PACKAGED_ONLY_SMOKE_CHECKS.includes(name)).map((name) => {
    const prediction = SMOKE_PREDICTIONS[name]
    if (prediction === undefined) throw new Error(`checks.mjs: no prediction for smoke check ${name}`)
    const question =
      name === 'timeout'
        ? `Did ${what}'s \`--smoke-test\` finish within its time limit, with no \`timeout\` entry in its report?`
        : `Did ${what}'s \`--smoke-test\` report its \`${name}\` check as passed?`
    return check(`${prefix}-smoke-${name}`, area, question, prediction, area === 'nsis' ? ['W4'] : ['W1–W4 CI'])
  })
}

const electronChecks = [
  check(
    'electron-launch',
    'electron',
    'Does the built app start on the runner, and does `--smoke-test` print its `VEYDR_SMOKE_TEST` report?',
    ['yes', 'Electron supports Windows Server, and the smoke test reports an unsupported platform instead of exiting early'],
    ['W1–W4 CI'],
  ),
  ...smokeChecks('electron', 'electron', 'the built (unpackaged) app', { packaged: false }),
  check(
    'ctx-electron-no-console',
    'electron',
    'Does Electron\'s main process run without a console, confirming that the console-less launcher reproduces Veydr\'s parent?',
    ['yes', '`electron.exe` is a GUI-subsystem program, for which Windows creates no console'],
    ['all probes'],
  ),
  check(
    'electron-playwright',
    'electron',
    'Does `test/windows-probe/launch.spec.ts` pass under Playwright\'s Electron launcher on the runner, with the window rendered and showing `windows` in the unsupported-platform state?',
    ['yes', 'Playwright\'s Electron launcher supports Windows and the spec uses nothing Linux-specific'],
    ['W1–W4 CI'],
  ),
  check(
    'ffi-koffi-electron',
    'electron',
    'Does `koffi` load inside Electron\'s main process from an ASAR-packaged app on the runner (only if approved under gate G-4, design D6)?',
    ['yes', 'koffi ships prebuilt Windows x64 binaries, and electron-builder unpacks `.node` files from the ASAR archive'],
    ['G-4 option B'],
  ),
]

const nsisChecks = [
  check(
    'nsis-build',
    'nsis',
    'Does `electron-builder --win nsis` build a per-user, one-click installer from command-line options, with `electron-builder.yml` unchanged?',
    ['yes', 'electron-builder downloads NSIS itself and accepts the NSIS options on the command line'],
    ['W4'],
  ),
  check(
    'nsis-install',
    'nsis',
    'Do a silent install (`/S`), a `--smoke-test` launch of the installed app with its exit code and smoke report readable, and a silent uninstall that removes the install directory all work?',
    ['yes', 'a per-user one-click installer needs no elevation, and a GUI-subsystem program can write to inherited pipes'],
    ['W4'],
  ),
  ...smokeChecks('nsis', 'nsis', 'the installed app', { packaged: true }),
]

// ---------------------------------------------------------------------------------------------
// Runner limits (D3, D7)

const limits = [
  limit(
    'env-desktop-launch',
    'environment',
    'the runner has no interactive desktop session, so no app can be started from Explorer',
    'start Veydr from Explorer on a Windows 10/11 desktop and compare its environment with the registry environment',
  ),
  limit(
    'pt-logoff',
    'process-tree',
    'a runner job cannot log off its user or shut Windows down and observe the result',
    'log off, and shut down, a Windows 10/11 desktop with commands running in Veydr, then check that none survive',
  ),
  limit(
    'ux-uac-prompt',
    CONTEXT_AREA,
    'UAC elevation prompts need an interactive desktop; running as a standard user is covered by the -std checks',
    'run Veydr as a standard user on a Windows 10/11 desktop and start a command that requests elevation',
  ),
  limit(
    'l10n-console',
    'encoding',
    'the runner image is English only',
    'repeat the encoding and port probes on a localized Windows install (e.g. Japanese or German)',
  ),
  limit(
    'av-third-party',
    'nsis',
    'the runner has Microsoft Defender only',
    'install and run Veydr on a machine with third-party antivirus',
  ),
  limit(
    'smartscreen',
    'nsis',
    'SmartScreen prompts for downloaded files on an interactive desktop, which the runner lacks',
    'download the unsigned installer with a browser on a Windows 10/11 desktop and run it',
  ),
]

export const CHECKS = Object.freeze(
  [
    ...contextChecks,
    ...processTreeChecks,
    ...helperChecks,
    ...commandChecks,
    ...environmentChecks,
    ...encodingChecks,
    ...portChecks,
    ...electronChecks,
    ...nsisChecks,
    ...limits,
  ].map((entry) => Object.freeze(entry)),
)

/**
 * Changes after the snapshot in test/windows-probe/predictions.json (design D3), oldest first. Each
 * has `id`, `reason` and `date` ('YYYY-MM-DD'), and one of:
 * - `change: 'prediction', from, to`: the prediction changed from `from` to `to` (`yes`/`no`);
 * - `change: 'question', from, to`: the question changed; `from`/`to` are `questionHash`es;
 * - `change: 'added', to, question`: a check added later, with its prediction and question hash;
 * - `change: 'removed', from`: a check retired, with the prediction it had.
 */
export const REVISIONS = Object.freeze([])

// ---------------------------------------------------------------------------------------------
// Validation (test/unit/windows-probe-summary.test.ts)

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const ANSWERS = ['yes', 'no']
const nonEmpty = (value) => typeof value === 'string' && value.trim() !== ''
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Problems with the catalog's entries; empty when every entry is well formed. */
export function catalogProblems(checks) {
  const problems = []
  const byId = new Map()
  for (const entry of checks) {
    if (byId.has(entry.id)) problems.push(`${entry.id}: duplicate ID`)
    byId.set(entry.id, entry)
  }
  const areas = [CONTEXT_AREA, ...PROBE_AREAS]
  for (const entry of checks) {
    const where = entry.id
    if (!ID.test(entry.id)) problems.push(`${where}: ID is not lower-case words joined by "-"`)
    if (!areas.includes(entry.area)) problems.push(`${where}: unknown area ${entry.area}`)
    if (!nonEmpty(entry.reason)) problems.push(`${where}: no reason`)
    if (entry.kind === 'limit') {
      if ('prediction' in entry) problems.push(`${where}: a limit has no prediction`)
      if (!nonEmpty(entry.verify)) problems.push(`${where}: a limit says what would verify it`)
      continue
    }
    if (entry.kind !== 'check') {
      problems.push(`${where}: unknown kind ${entry.kind}`)
      continue
    }
    if (!nonEmpty(entry.question) || !entry.question.endsWith('?')) problems.push(`${where}: the question must end with "?"`)
    if (!ANSWERS.includes(entry.prediction)) problems.push(`${where}: prediction must be yes or no`)
    if (!Array.isArray(entry.feeds) || entry.feeds.length === 0 || !entry.feeds.every(nonEmpty)) problems.push(`${where}: feeds nothing`)
    if (entry.context?.console !== 'none' || !['admin', 'standard', 'both'].includes(entry.context?.user)) {
      problems.push(`${where}: context must be console none and user admin, standard or both`)
    }
    if (entry.id.endsWith('-std') && entry.context?.user !== 'standard') problems.push(`${where}: a -std check runs as the standard user`)
    if (typeof entry.control !== 'boolean') problems.push(`${where}: control must be true or false`)
    if (entry.control && entry.controls.length > 0 && entry.area === CONTEXT_AREA) problems.push(`${where}: a context control depends on nothing`)
    for (const id of entry.controls ?? []) {
      const control = byId.get(id)
      if (control === undefined || control.kind !== 'check' || !control.control) {
        problems.push(`${where}: depends on ${id}, which is not a control check`)
        continue
      }
      if (control.area !== CONTEXT_AREA && control.area !== entry.area) problems.push(`${where}: depends on ${id} of another area`)
      if (control.context.user !== 'both' && control.context.user !== entry.context?.user) {
        problems.push(`${where}: depends on ${id}, which runs as ${control.context.user}`)
      }
    }
    // Every result counts only from a driver whose context was established (D9).
    if (entry.id !== NO_CONSOLE && entry.id !== STANDARD_USER) {
      if (!entry.controls.includes(NO_CONSOLE)) problems.push(`${where}: must depend on ${NO_CONSOLE}`)
      if (entry.context?.user === 'standard' && !entry.controls.includes(STANDARD_USER)) problems.push(`${where}: must depend on ${STANDARD_USER}`)
    }
  }
  return problems
}

/** A short hash of a check's question, so the snapshot shows when a question's wording changed. */
export function questionHash(question) {
  return createHash('sha256').update(question).digest('hex').slice(0, 16)
}

const byIdOrder = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)

/** `{ id: { prediction, question } }` of every check, sorted by ID: the content of test/windows-probe/predictions.json. */
export function snapshotPredictions(checks) {
  const entries = checks.filter((c) => c.kind === 'check').map((c) => [c.id, { prediction: c.prediction, question: questionHash(c.question) }])
  return Object.fromEntries(entries.sort(byIdOrder))
}

const HASH = /^[0-9a-f]{16}$/

/**
 * Problems with the catalog compared to the snapshot: a prediction or question that differs from it,
 * a check missing from it, or a snapshot entry that is no longer a check, without matching
 * revisions; or a revision that does not fit. Empty when every difference is recorded in `revisions`.
 */
export function revisionProblems(checks, snapshot, revisions) {
  const problems = []
  const catalog = new Map(checks.filter((c) => c.kind === 'check').map((c) => [c.id, { prediction: c.prediction, question: questionHash(c.question) }]))
  const limits = new Set(checks.filter((c) => c.kind === 'limit').map((c) => c.id))

  // Each check's recorded state: the snapshot, then the revisions applied in order.
  const recorded = new Map()
  for (const [id, entry] of Object.entries(snapshot)) {
    if (limits.has(id)) problems.push(`${id}: the snapshot holds a limit, which has no prediction`)
    if (!isPlainObject(entry) || !ANSWERS.includes(entry.prediction) || typeof entry.question !== 'string' || !HASH.test(entry.question)) {
      problems.push(`${id}: snapshot entry must be {"prediction":"yes"|"no","question":"<16 hex digits>"}`)
      continue
    }
    recorded.set(id, { prediction: entry.prediction, question: entry.question })
  }
  for (const [i, revision] of revisions.entries()) {
    const where = `revision ${i + 1} (${String(revision.id)})`
    const state = recorded.get(revision.id)
    if (!nonEmpty(revision.reason)) problems.push(`${where}: no reason`)
    if (typeof revision.date !== 'string' || !DATE.test(revision.date)) problems.push(`${where}: date must be YYYY-MM-DD`)
    switch (revision.change) {
      case 'prediction':
        if (state === undefined) problems.push(`${where}: changes a check that is not recorded`)
        else if (state.prediction !== revision.from) problems.push(`${where}: changes the prediction from ${String(revision.from)}, but it was ${state.prediction}`)
        if (!ANSWERS.includes(revision.to)) problems.push(`${where}: "to" must be yes or no`)
        else if (revision.from === revision.to) problems.push(`${where}: changes nothing`)
        if (state !== undefined) recorded.set(revision.id, { ...state, prediction: revision.to })
        break
      case 'question':
        if (state === undefined) problems.push(`${where}: changes a check that is not recorded`)
        else if (state.question !== revision.from) problems.push(`${where}: changes the question from ${String(revision.from)}, but it was ${state.question}`)
        if (typeof revision.to !== 'string' || !HASH.test(revision.to)) problems.push(`${where}: "to" must be a question hash`)
        else if (revision.from === revision.to) problems.push(`${where}: changes nothing`)
        if (state !== undefined) recorded.set(revision.id, { ...state, question: revision.to })
        break
      case 'added':
        if (state !== undefined) problems.push(`${where}: marked as added, but it is already recorded`)
        if (!ANSWERS.includes(revision.to)) problems.push(`${where}: "to" must be yes or no`)
        if (typeof revision.question !== 'string' || !HASH.test(revision.question)) problems.push(`${where}: "question" must be a question hash`)
        recorded.set(revision.id, { prediction: revision.to, question: revision.question })
        break
      case 'removed':
        if (state === undefined) problems.push(`${where}: removes a check that is not recorded`)
        else if (state.prediction !== revision.from) problems.push(`${where}: removes a check predicted ${state.prediction}, not ${String(revision.from)}`)
        recorded.delete(revision.id)
        break
      default:
        problems.push(`${where}: change must be "prediction", "question", "added" or "removed"`)
    }
  }
  for (const id of recorded.keys()) {
    if (!catalog.has(id) && !limits.has(id)) problems.push(`${id}: recorded but no longer a check; record its removal in REVISIONS`)
  }
  for (const [id, current] of catalog) {
    const state = recorded.get(id)
    if (state === undefined) {
      problems.push(`${id}: not in the snapshot and no revision marks it as added later`)
      continue
    }
    if (state.prediction !== current.prediction) {
      problems.push(`${id}: predicted ${current.prediction}, but the snapshot and revisions say ${state.prediction}; record the change in REVISIONS`)
    }
    if (state.question !== current.question) {
      problems.push(`${id}: question hash ${current.question} differs from the recorded ${state.question}; record the change in REVISIONS`)
    }
  }
  return problems
}

// ---------------------------------------------------------------------------------------------
// `node scripts/windows-probe/checks.mjs snapshot <file>`: writes the snapshot once; refuses to
// overwrite it. Exit codes: 0 written, 1 failure, 2 usage error.

function main(args) {
  const [command, file, ...rest] = args
  if (command !== 'snapshot' || file === undefined || rest.length > 0) {
    console.error(`usage: checks.mjs snapshot <file> (got: ${args.join(' ')})`)
    return 2
  }
  const problems = catalogProblems(CHECKS)
  if (problems.length > 0) {
    console.error(`checks.mjs: the catalog is invalid:\n${problems.join('\n')}`)
    return 1
  }
  try {
    writeFileSync(file, `${JSON.stringify(snapshotPredictions(CHECKS), null, 2)}\n`, { flag: 'wx' })
  } catch (error) {
    const message = error?.code === 'EEXIST' ? `${file} exists; the snapshot is never regenerated (design D3)` : String(error?.message ?? error)
    console.error(`checks.mjs: ${message}`)
    return 1
  }
  console.log(`checks.mjs: wrote ${file}`)
  return 0
}

/** True when Node runs this file as the entry point. Node resolves symlinks for `import.meta.url`, so argv[1] is too. */
function isEntryPoint() {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isEntryPoint()) process.exitCode = main(process.argv.slice(2))
