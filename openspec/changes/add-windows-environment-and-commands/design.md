# Design

## Context

See proposal.md for the motivation. The current state:

- `createWindowsPlatform` (`src/main/platform/windows/index.ts`) returns:
  - the real process tree of W1, with `spawn`, `findSurvivors` and `terminateSurvivors`;
  - the unsupported `commandResolver`, `envProvider`, `portInspector` and `launchDetached`;
  - `supported: false`, and `defaultShell: null`.

  The supervisor resolves a command before it spawns it (`src/main/supervisor/plan.ts`), so nothing starts on Windows today.
- The Linux pieces W2 mirrors:
  - **Resolver** (`linux/resolver.ts`): it checks the project folder and keeps the working directory inside it, both lexically and after symbolic links. It finds the program on `env.PATH` (`linux/executable.ts`), and shell mode runs `<shell> -c <script>`.
  - **Environment provider** (`linux/environment.ts`): it reads the login shell's `env -0`, falling back to `withoutRuntimeVariables(process.env)`.
  - **`launchDetached`** (`linux/process-tree.ts`): starts the editor in its own session, untracked.
- The W1 helper's `run <pipe> <file> [<arg>…]`:
  - builds the command line itself (`BuildCommandLine` in `veydr-helper.cs`): CRT quoting for programs, and for batch files `cmd.exe /d /e:on /v:off /s /c` with its own stricter batch quoting, which refuses `"` and `%` (W1 group 3);
  - cannot run a verbatim `cmd.exe` script.

  The protocol is version 1. `spawn` refuses a helper whose `version` differs.
- W0's decisions for W2 (`docs/windows-evidence.md`, "Shell mode (W2)"):
  - **The quoting route:** `cmd.exe /d /v:off /s /c` with `scripts/windows-probe/cmd-quote.mjs` carries every corpus case, and refuses a line break, NUL, or a line beyond 8191 characters.
  - **No `shell: true`:** Node's `shell: true` runs injected commands.
  - **`PATHEXT`:** `npm` resolves to `npm.cmd` through `PATH` and `PATHEXT`, and `cmd.exe` prefers a decoy file in the working directory.
  - **Output is not UTF-8:**
    - console children get output code page 437, even with `chcp 65001` on the same line;
    - Python writes cp1252 to a pipe;
    - Node writes UTF-8.
  - **The environment:** the registry environment does not reproduce the logon environment.
- Output decoding (`src/main/logs/splitter.ts`): one `StringDecoder('utf8')` per stream, and lines are split on text.
- `test/unit/test-platform-policy.test.ts` fails on any branch on the platform in test code, other than a `skipIf`/`runIf` guard with a `[<os>-only: <facility>]` reason. Thirteen e2e specs import Linux `/proc` helpers from `test/support/proc.ts`.
- User decisions taken while planning (2026-11-06):
  - shell mode on Windows is `cmd.exe` only;
  - the base environment is Veydr's inherited one;
  - output is UTF-8 with an ANSI fallback for each line;
  - the docs describe Windows as "preview, run from source, verified in CI".

## Goals / Non-Goals

**Goals:**
- Starting, stopping, recovering, previewing the environment of, and opening an editor for a project all work on Windows. They are verified by Windows integration and e2e tests on `windows-2025` for every pull request.
- One implementation of every Windows command line, in TypeScript, unit-tested on every system. The helper only checks the line and passes it on.
- No change to the Linux platform, the supervisor's behavior, the ledger format, or the configuration schema.

**Non-Goals:**
- PowerShell or any other shell in shell mode on Windows.
- Re-reading the registry environment, or picking up a `PATH` edit made after Veydr started.
- Port inspection on Windows (W3), packaging and helper placement in a package (W4), and signing (G-6).
- Decoding output in OEM code pages (437, 850) that no WHATWG decoder covers (D5).
- Batch files that expand `%1` themselves. Their own quoting is the user's (W0 design, D3).

## Decisions

### D1. Protocol version 2: Veydr builds the command line, the helper runs it verbatim

**The `run` form.**
- `run` becomes `run <pipe>`.
- After the token line on the helper's stdin, Veydr writes one JSON line, `{"application": …, "commandLine": …}`, and then closes stdin:
  - `application` is a fully qualified program path;
  - `commandLine` is the complete `CreateProcess` command line, argv[0] included.
- Neither field appears in the helper's own argv, so libuv's re-quoting cannot lengthen them, and the 32,767-character `CreateProcess` limit applies to `commandLine` exactly.
- **Reading order.** The helper reads the token line, connects, proves itself and sends `ready`, and only then reads the JSON line. Every refusal of that line is reported as an `error` line on the control pipe and never on stderr, which belongs to the command and goes into its log.
- **Parsing.** C# 5 has no JSON parser without extra references, so the helper parses the line by hand, strictly:
  - exactly one object with the two string fields `application` and `commandLine`, in that order;
  - the escapes `\" \\ \/ \b \f \n \r \t \uXXXX`;
  - a lone surrogate, a duplicate or unknown key, or trailing text is refused;
  - the line is read as UTF-8 with its own limit of 1 MiB (escaping can make it about six times longer than 32,767 characters), separate from the token line's limit.

**The helper's checks.** The helper refuses each of these with an `error` line before anything starts:
- NUL in either field;
- a relative or drive-relative application;
- a command line beyond 32,767 characters;
- a batch file (`IsBatchFile` of W1, which trims trailing dots and spaces) given as the application.

  `CreateProcess` would otherwise start `cmd.exe` implicitly, with its own unsafe quoting. A batch file can only arrive as part of a `cmd.exe` command line, whose application is a file named `cmd.exe`. W1's `BuildCommandLine` and `BatchArgument` are removed.

**The protocol version.** `ProtocolVersion` becomes 2 on both sides together. Version 2 also carries D5's `started` fields (`utf8Console`, `ansiCodePage`) from group 2 on, so no later group changes the protocol without another bump. A stale helper is refused with the existing version-mismatch `SpawnError`.

**`SpawnPlan`.** It gains one optional, platform-neutral field: `commandLine?: string`. It holds a Windows command line built by the resolver, and the Linux platform ignores it. When it is absent, the Windows process tree quotes `file` and `args` itself by the `CommandLineToArgvW` rules. That path exists only for a plan whose file is not a batch file: the process tree refuses a batch-file `file` without a `commandLine`, as the helper does.

**`src/main/platform/windows/command-line.ts`** holds all quoting:
- `quoteArgument`: the `CommandLineToArgvW` rules, as in `cmd-quote.mjs` and the W1 C# `AppendQuoted`.
- `batchCommandLine(cmdExe, file, args)`: `cmd.exe /d /v:off /s /c "<…>"`.
  - An argument matching W1's `BareBatchArgumentPattern` (`^[A-Za-z0-9_+\-.:/\\@]+$`) is passed bare. It carries no character `cmd.exe` interprets, so it reaches `%1` and `%~1` as written, and a `%*` forwarder's program reads it unchanged.
  - Every other argument is quoted and escaped exactly as `cmd-quote.mjs` does. That form is validated for `%*` forwarders; a batch file that reads such an argument through `%1` itself sees it escaped, which the W0 design leaves out of scope and the docs say.
  - The `"`/`%` refusal for the batch path, line breaks and NUL, the 8191-character limit, and `SHIM_LINE_RESERVE` are kept.
- `shellCommandLine(cmdExe, script)`: `cmd.exe /d /v:off /s /c "<script>"` with the script verbatim.
  - It refuses an empty or blank script, a line break or NUL (`cmd.exe /c` would run only the first line), and a full line beyond 8191 characters, counting the `cmd.exe /d /v:off /s /c "` prefix and the closing quote.

**Tests.**
- A unit test runs `batchCommandLine` and `scripts/windows-probe/cmd-quote.mjs` over the W0 corpus (`cmd-corpus.mjs`). For each argument that needs quoting it requires identical text, and for each simple one, the bare form.
- The Windows integration tests run the shim corpus through the real helper. They also run a batch fixture that tests `if "%1"=="release"` and `%~2` with simple arguments, so the bare rule is checked on Windows.

**Alternatives considered:**
- *Always quote, as `cmd-quote.mjs` does.* That breaks ordinary batch files: `release` arrives in `%1` as `^"release^"` (reviewer2, W2 plan review). Rejected.
- *Keep the helper's quoting and add a `shell` mode to it.* That keeps two quoting implementations, neither unit-testable on Linux. Rejected.
- *Pass the command line as a helper argument.* libuv re-quotes it, and quotes and backslashes can double its length, so a long direct-mode line fails at the helper spawn with a misleading message. Rejected.

### D2. Windows resolver: shared working-directory checks, `PATHEXT` lookup, `cmd.exe` only

- **The folder checks are shared.** The project-folder and working-directory checks of `linux/resolver.ts` move unchanged into `src/main/platform/resolve-cwd.ts`. Both resolvers use it.
  - The realpath function is injectable: Linux uses `realpath`, and Windows uses `realpath.native`, which expands 8.3 short names.
  - On Windows, `node:path` compares without regard to case, and the native realpath follows junctions and symbolic links.
- **Direct mode:**
  - **Paths:**
    - A program with a drive or UNC prefix is used as given.
    - A drive-relative path (`C:tool`) or a root-relative path (`\tool`) is refused.
    - Any other path containing `\` or `/` is resolved against the working directory.
  - **A bare name** is looked up in each directory of the effective `Path`, with the name looked up regardless of case.
    - Surrounding double quotes are stripped from each entry, as `cmd.exe` does.
    - Entries left empty or relative are skipped.
    - Each directory check has a time limit of 2 s, so an unreachable UNC share in `Path` delays a start but cannot block it. A directory that times out is skipped and named in the diagnostic if nothing is found.
    - Once a directory's time is up, no further check is started in it. After 2 unanswered directories the search stops with a diagnostic: each unanswered check holds one of libuv's four filesystem threads until Windows gives up on the share (group 3 review).
    - The project folder, the working directory, and a program or shell given by path have the same 2 s limit.
    - The resolver remembers checks that did not answer and are still running, by directory or path, across starts. While one is waiting, that place counts as unanswered at once and gets no new check (group 3 re-review), so repeated starts cannot use up the threads either. A UNC path is remembered by its server, any other path by itself (letter case and a trailing separator ignored), so several paths on one dead mapped drive can still each hold a thread. The memory lives in the resolver, so the platform creates one resolver for all starts.
    - `Path` is read as `cmd.exe` reads it: quotes removed, a `;` between them kept. Names and path segments are refused when Windows would read them as another file: a trailing dot or space, `:` or a wildcard, or a DOS device name (`CON`, `NUL`, `COM1`, …). A link that leads to a directory or nowhere is no match.
  - **Extensions:** in each directory, the name is tried as given if it has an extension, then with each `PATHEXT` extension in order (default `.COM;.EXE;.BAT;.CMD`). The first existing file wins, as with `cmd.exe`.
  - **Existence:** it is checked with `lstat`, so App Execution Aliases (zero-byte reparse points under `WindowsApps`, for which `stat` can fail with `EACCES` or `UNKNOWN`) are found.
  - **No working directory:** the working directory is never searched (W0 `cmd-pathext-cwd`).
  - **Accepted types:** the first match must be `.exe`, `.com`, `.bat` or `.cmd`.
    - Any other type is refused with a diagnostic naming the file and the accepted types. It is not skipped, which differs from `cmd.exe`, on purpose: Veydr never starts a later match the user did not expect. A test pins this with an `npm.js` found before `npm.cmd` (`PATHEXT=.JS;.CMD`). An extensionless `npm` beside `npm.cmd`, as Node.js installs it, is no match at all, since a name without an extension is tried only with the `PATHEXT` extensions.
  - **Plans:** a batch file gets `file = <cmd.exe>` and a `commandLine` from `batchCommandLine`. A program gets its own path and no `commandLine`.
  - **`cmd.exe` as the program:** naming `cmd.exe` itself as a direct-mode program with `/c` arguments gives CRT-quoted arguments that `cmd.exe` parses again. That is the user's own choice of program, documented, and shell mode is the supported way to run a script.
- **Shell mode:**
  - The configured shell must be absolute, and its file name must be `cmd.exe` (compared regardless of case). Anything else is refused with "On Windows, shell mode supports cmd.exe only".
  - The plan's `file` is the configured `cmd.exe`, and its `commandLine` comes from `shellCommandLine`.
- **The default shell** is `<SystemRoot>\System32\cmd.exe`, where `SystemRoot` is read once from Veydr's environment; `C:\Windows` is used when it is unset or not absolute. `%ComSpec%` is not used, since any process of the user can change it.
- **`cmd.exe` for batch files:** batch files use the same default path. The user's shell setting does not apply to direct mode.

**Alternatives considered:**
- *Let `cmd.exe` resolve bare names in shell-free direct mode.* That brings back the working-directory decoy. Rejected.
- *Accept PowerShell.* The user chose `cmd.exe` only for W2.

### D3. Windows environment: Veydr's inherited environment, names merged regardless of case

`windows/environment.ts`:
- `base()` returns `withoutRuntimeVariables(process.env)`, minus names that are empty, start with `=` (the per-drive `=C:` entries), or contain NUL;
- variables whose names differ only in case are merged into one entry: the spelling and value that a case-insensitive lookup in `process.env` returns;
- a merge is logged as `environment.names-merged`, with the names but no values.

There is no fallback warning, because nothing is resolved that could fail. `effectiveEnvironment` then applies overrides under the `case-insensitive` rule as today. So a plan's `env` holds each variable once, and the helper's `{ ...plan.env }` spread (reviewer2's W1 note) cannot pass both `Path` and `PATH`.

The AppImage cleanup in `withoutRuntimeVariables` is a no-op on Windows, since `APPDIR` is unset. The docs say that a `PATH` change made after Veydr started needs a Veydr restart (an Explorer-started app inherits the logon environment), and that **Refresh** re-reads nothing new on Windows.

**Alternative considered:** *Re-read the registry environment on every refresh.* W0 showed that it differs from the logon environment (`env-registry-std`), and it would need the user-over-machine and `Path` concatenation rules plus `REG_EXPAND_SZ` expansion. Rejected by the user for W2.

### D4. Editor launch on Windows

`launchDetached` lives in `windows/process-tree.ts` and does not go through the helper. It applies the same batch-file refusal as the helper (D1):
- it uses Node's `spawn` with `detached: true`, `stdio: 'ignore'`, `shell: false` and `windowsVerbatimArguments: true`;
- it does not use `windowsHide`: `DETACHED_PROCESS` already keeps a console program from getting a console, and libuv turns `windowsHide` into `SW_HIDE` in the child's `STARTUPINFO`, which a GUI editor started directly (`Code.exe`) would apply to its first window (group 4 review);
- it unrefs the child.

Node adds argv[0] itself, so `commandLine`'s argv[0] (the quoted application) is stripped before the rest is passed as one verbatim argument. A unit test pins the exact command line handed to `spawn`.

**Survival.** A detached child is not in the job libuv puts Veydr's other children in, so it survives Veydr. If Veydr itself runs inside an outside job with `KILL_ON_JOB_CLOSE` (as the CI runner may), the editor could still end with that job. The survival test therefore runs inside the runner's own job, as Veydr would, and asserts survival there. The breakaway behavior is recorded, not assumed: the test reports whether the editor is in a job.

**Hidden.** `DETACHED_PROCESS` gives `cmd.exe` no console, and a console-subsystem program the batch file starts would then get a new, visible console. So the requirement is "no new console window":
- for a batch file that starts a GUI program (`code.cmd` and `Code.exe`), nothing appears;
- the test checks that no new window of class `ConsoleWindowClass` (or a Windows Terminal host) appears for the launched tree;
- the docs say that a batch-file editor that starts a console program shows that program's console.

A batch-file editor (`code.cmd`) is resolved by D2 into `cmd.exe` with a `batchCommandLine`. The project path is quoted if it is not a simple argument.

**The integration tests check:**
- the project path arrives as one unchanged argument;
- the editor survives the ending of the process that launched it;
- no new console window appears;
- a missing editor rejects with `SpawnError`.

### D5. Output on Windows: a UTF-8 console, then ANSI per line

**The UTF-8 console (helper).**
- The helper first calls `FreeConsole` on its own console and re-registers its Ctrl handling (`CtrlEvents.Ignore()`). W1 freed it only inside a stop, so the helper must now do it before the start.
- After `CreateProcess(CREATE_SUSPENDED | CREATE_NEW_CONSOLE …)`, it attaches to the suspended leader's console, calls `SetConsoleOutputCP(65001)`, re-registers its Ctrl handler (W1 group 4's rule after every attach), and detaches. Then it resumes the command.
- `started` reports `utf8Console` (whether that worked) and `ansiCodePage` (`GetACP()`).
- If the attach fails, the command still starts with `utf8Console: false`, and `process.windows-console-not-utf8` is logged.
- W0 showed that the code page works when set before `cmd.exe` starts (`enc-child-cmd-utf8`). Whether `AttachConsole` succeeds on a suspended process, before it has connected to its console, is unverified. This decides the whole encoding approach, so group 2, which already changes the helper, tests it on the runner first (task 2.3). Group 5 builds only on a passing result.

**If the test fails on the runner.** Group 2's merge waits for a decision between two fallbacks, rather than merging with `utf8Console` always `false`, since the ANSI fallback is wrong for `cmd.exe` output:
- **(a)** attach right after the resume. That races the command's first output, so the earliest lines may still be OEM, and the docs would say so;
- **(b)** start the command through a small console-owning wrapper, as W0's probes did, which sets the code page before the command starts. That costs one more process per run, and needs W1's console rules re-checked.

The pause report gives the attach error and recommends one of them.

**Decision (2026-11-07).** On the runner, `AttachConsole` on the suspended leader failed with "The handle is invalid (error 6)" in every run: a console created for a process exists only once that process runs. The user chose fallback (b), built so that the leader stays the command itself:
- `run` starts `veydr-helper console`, the same binary, in a new hidden console of its own, outside the command's job. The host refuses a console it shares with other processes, sets its output code page to 65001, and answers `ok` over a pipe.
- The helper attaches to the host's console only while it creates the suspended command without `CREATE_NEW_CONSOLE`, so the command inherits that console, and detaches before resuming it. That is the same window in which the original design attached, so the helper is still never on the command's console while the command runs.
- Only once the command is resumed does the helper close the host's stdin. The host waits until the command is on its console (at most 2 s) and exits, and the helper waits for that exit, ending a host still there after 2.5 s, before it reports `started`. So the console outlives the host until the command has connected to it, and by the time a stop can arrive it holds only the command's processes, as W1's Ctrl+Break step requires (reviewer2, group 2).
- If any step fails, the command gets a console of its own as in W1, with `utf8Console: false` and the reason in `consoleError`.

The cost is one short-lived process per run: a second .NET Framework process start, usually well under a second, before `started`. A host that has not answered within 5 s counts as failed, and the command gets a console of its own. The protocol, the leader, the job, the stop and crash recovery are unchanged.

**The fallback decoder.** `ManagedProcess` gains `outputFallbackEncoding: string | null`, which is `null` on Linux. On Windows it is a WHATWG label:
- when `utf8Console` is true: the ANSI code page's label:
  - `windows-874` and `windows-1250` through `windows-1258`;
  - `shift_jis` (932), `gbk` (936), `euc-kr` (949) and `big5` (950);
  - `null` for any other code page;
- when `utf8Console` is false: still the ANSI label. Console programs then write in the OEM code page (437 or 850), for which no WHATWG decoder exists. Their non-ASCII text is shown wrong, which is logged and documented. The CI test keeps that case from shipping unnoticed.

The supervisor passes the fallback to the log service when a run starts.

**The splitter with a fallback.**
- It splits each stream on `\n` bytes and decodes each completed or flushed line with a fatal UTF-8 `TextDecoder`. A line that fails is decoded with the fallback decoder.
- The 16 KiB truncation cuts bytes and then drops a trailing incomplete UTF-8 sequence before deciding. A cut can still split a multibyte ANSI character (Shift_JIS, GBK, …); the decoder then shows one replacement character at the cut, which the docs note.
- The partial-line display decodes the held bytes the same way.
- Without a fallback, the splitter keeps today's `StringDecoder` path, so Linux is unchanged.

**What this covers.**
- `cmd.exe` and other console programs: UTF-8 through the console.
- Node: UTF-8 already.
- Python: cp1252, through the ANSI fallback.
- Not covered: programs that write OEM bytes straight to a pipe. `PYTHONUTF8=1` and `chcp` are suggested in `docs/logs.md`.
- The runner's code pages are 1252 and 437, so the multibyte ANSI code pages are tested with synthetic bytes only, which the not-verifiable list records.

**Alternatives considered:**
- *Decode with the OEM code page.* No WHATWG decoder exists, and it would be wrong for Python, which writes ANSI. Rejected.
- *Set `PYTHONUTF8=1` in the command's environment.* It silently changes the user's environment. Rejected.
- *The helper creates its own console with `AllocConsole` and passes it on.* That conflicts with W1's rule that the helper is never a member of the command's console. Rejected.

### D6. Platform composition and the preview

- **Composition:** `createWindowsPlatform({ helperPath, log, inherited })` returns:
  - `supported: true`;
  - conventions `{ envNames: 'case-insensitive', defaultShell: <cmd.exe of D2>, directorySync: false }`;
  - the D2 resolver, the D3 environment provider, and the full process tree including `launchDetached`;
  - the unsupported `portInspector` (W3).

  `selectPlatform` passes `inherited` on Windows too.
- **The interface:** the renderer's "not supported" banner follows `supported` and disappears. The Ports view keeps its "not yet available on this platform" state. The shell field's hint on Windows says "cmd.exe only".
- **The smoke check:** the `--smoke-test` platform check calls `envProvider.base()` on every platform, and `portInspector.list()` only where it does not reject with `UnsupportedPlatformError`. On Windows it reports "port inspection not yet available".
- **The docs:**
  - README, the platform table and `docs/processes.md` say: **"Windows: preview. Run from source; verified in CI on Windows Server 2025. No Windows package yet."**;
  - a new "Running from source on Windows" section lists Node, `npm ci`, `node scripts/build-windows-helper.mjs`, then `npm run dev`;
  - the not-verifiable list stays, and gains:
    - localized ANSI code pages: the runner uses 1252 and 437, so 932, 936, 949 and 950 are tested with synthetic bytes only;
    - a user-customized `PATHEXT`;
    - App Execution Aliases;
    - the environment of an Explorer-launched Veydr compared with the inherited one;
    - the shell, environment and encoding limits of D2, D3 and D5;
  - the `docs/dependencies.md` helper section describes protocol version 2 (group 2);
  - `docs/deferred-checks.md` keeps W4's packaging and helper-placement row.

### D7. End-to-end tests on Windows

**The portable process helper.**
- `test/support/processes.ts` replaces the process-inspection half of `test/support/proc.ts`, with the functions `taggedProcesses`, `isAlive`, `killTagged` and `processIdentity`.
- Linux reads `/proc` as today. Windows makes one `Get-CimInstance Win32_Process` call per query, as `windows-process-tree.test.ts` does, and takes the PID plus creation time as the identity. Any other system throws.
- A failed query (missing PowerShell, an error exit, or unparsable output) throws and never returns an empty list. Otherwise a "no process remains" assertion would pass vacuously.
- A sanity test on both systems starts a tagged process and requires the helper to see it.
- The ledger, fixture and scenario helpers stay in `proc.ts`, which no longer reads `/proc`.

**The policy exception.** `test-platform-policy.test.ts` gains exactly one allowed platform dispatch:
- it is pinned by file (`test/support/processes.ts`) and by count (one dispatch);
- the test asserts that the dispatch throws for an unknown platform;
- the policy otherwise stays unchanged.

**Sorting the specs** (task 7.2). Each of the e2e specs is classified in a table in `docs/ci.md`:
- **portable:** it runs on both systems unchanged, apart from using the portable helper and portable fixtures. POSIX fixture commands (`sh`, `sleep`, `trap`, `kill`) are replaced with Node fixtures.
- **Linux-only:** guarded with `skipIf(process.platform !== 'linux')` and a `[linux-only: <facility>]` title. This covers network namespaces (`offline`, `no-network`), the login shell, and port inspection until W3.
- **Windows-specific:** where the behavior differs, a Windows-only spec (`windows-*.spec.ts`, `[windows-only: …]`) asserts the Windows behavior. Examples are crash recovery (the trees end, so no survivors are shown) and the Ports view's unavailable state. The Linux spec then becomes Linux-only for that test.

The policy forbids branching in tests, so differing expectations are never written as a condition. A value the app reports, such as the platform label or the default shell, is read from `AppInfo`. No spec may fail on Windows for lack of porting: an unclassified spec is a task failure, not a skip.

**The app path.** The Playwright launch is checked to resolve `app.getAppPath()` to the repository root, where `out-helper/` is. A test asserts that the started app found the helper, by starting a command.

**CI.** The `windows` job:
- gains `electron: "true"` in its setup, which installs dependencies only on Windows;
- gains a "Windows end-to-end tests" step after the integration tests, running `npm run test:e2e` with `if:` requiring the helper build's success;
- gains an `upload-artifact` step for `test-results/` on failure, as the Linux `e2e` job has;
- has its timeout raised from 30 to 45 minutes.

`workflow-policy.test.ts` checks the steps, their conditions, and the absence of `--no-sandbox` and `VEYDR_ALLOW_SKIP_OFFLINE`. The Linux `e2e` job is unchanged.

**Alternative considered:** *Separate `processes.linux.ts` and `processes.windows.ts` files.* They still need one selection point, so they add a file without removing the exception. Rejected.

## Risks / Trade-offs

- [Attaching to a suspended process's console may fail if the console is created only when the process starts] → Group 2 tests it first on the runner (task 2.3), before anything builds on it. A failure pauses the change for a design decision rather than weakening the test. At run time a failure is non-fatal (`utf8Console: false`, logged), and OEM output is then shown wrong, as documented.
- [Some legacy console programs misbehave under output code page 65001] → Only the output code page changes (stdin is `NUL`). The docs name the setting, and a command that needs another code page can run `chcp` itself in shell mode.
- [A byte-wise ANSI decode of a line that is neither UTF-8 nor ANSI shows the wrong characters rather than U+FFFD] → It is documented as best effort, and capture never stops.
- [`PATHEXT` or `Path` controlled by the user's environment points to a hostile directory] → Relative and empty entries are skipped, the working directory is never searched, and only four executable types are started. The environment is the user's own, as on Linux.
- [A `Path` entry on an unreachable network share] → Each directory check has a 2 s limit (D2), so a start is delayed but never blocked, and the diagnostic names the skipped directory.
- [A bug or a new caller passes a batch file without `cmd.exe`] → The helper and `launchDetached` both refuse a batch-file application (D1), so `CreateProcess` never runs a batch file implicitly.
- [The 8191-character `cmd.exe` limit refuses long npm commands] → It is refused before spawning with a message naming the limit (W0 `cmd-route-verbatim-long`); direct-mode `.exe` programs get the 32,767-character `CreateProcess` limit, exactly, since the command line goes over stdin (D1).
- [The e2e suite on Windows is slow (Electron launches plus PowerShell process queries)] → One CIM query per assertion point, `REPETITIONS` stays 5, and the job timeout is 45 minutes. Runner slowness already caused a flaky unit-test timeout once (W1 #35). If it recurs, the disk-heavy tests stop running in parallel with `windows-probe-commands`, as recorded in W1.
- [The preview claim is read as a Windows release] → The README and docs say "run from source" and "no Windows package", and keep the not-verifiable list. W4 owns the shipped statement.
- [A stale helper (version 1) in `out-helper/`] → The build script rebuilds when the source hash changes, and `spawn` refuses a version mismatch with a message naming the helper.

## Migration Plan

There is no data or configuration migration: the configuration schema and ledger format are unchanged. A Windows user's saved shell commands keep their configured shell. One that is not `cmd.exe` now fails at start with the D2 message instead of failing as unsupported. Rollout is one pull request per task group. Rollback is a revert, after which Windows reports unsupported again; the helper's protocol version moves with the code.
