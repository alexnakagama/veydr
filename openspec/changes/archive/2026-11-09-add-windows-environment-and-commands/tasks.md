# Tasks

Notes:

- Starting a command from the app on Windows stays unsupported until group 6. That group switches the platform composition and the docs together (design D6), so no earlier pull request claims more than it delivers.
- Every group ends the way foundation design D15 requires:
  1. run its verification commands;
  2. hand off to the `reviewer2` session;
  3. fix the findings, and have them re-reviewed;
  4. record the outcome here.
- These planning artifacts are committed together with group 1, which tags every new scenario, so `npm run spec-coverage` stays at zero unmapped.
- Windows behavior counts as verified only from the `windows` CI job on the pull request, never from Linux runs. When the runner is slow (W1 #35), re-run the failed job first. If it happens again, stop running the disk-heavy unit tests in parallel with `windows-probe-commands`.
- No npm dependency is added, `electron-builder.yml` is unchanged, and no helper binary is committed.

Plan review (2026-11-06): reviewer2 found 2 high, 5 medium, 5 low and 3 nits in the first draft. All are folded into the proposal, the design, the specs and the tasks below.
- high: always-quoted batch arguments broke ordinary `.bat` files (`%1`, `%~1`). Simple arguments now pass bare, and a `%1` fixture tests it (design D1).
- high: the "Windows limitations documented" scenario would contradict the lifted docs. "Documented crash limitation" is now a MODIFIED requirement.
- medium:
  - the helper and `launchDetached` keep refusing a batch file without `cmd.exe`;
  - "no shell interpretation" now has an explicit Windows batch-file exception in direct mode and the editor launch;
  - the command line goes over stdin, so the 32,767-character limit is exact;
  - the e2e work is sorted spec by spec, with Windows-specific specs and an artifact upload;
  - a check that no W2 `it.todo` remains.
- low and nits: the "where possible" wording in line handling; the UTF-8 console tested first, in group 2, with its fields in protocol version 2; the corrected libuv claim and the precise "no new console window"; the resolver details; the docs in groups 2 and 6; the multibyte cut; blank scripts; and the 8191-character prefix.
- The re-review approved the plan. Its 4 low items and 1 nit are folded in:
  - the helper reads the JSON line only after `ready`, and refuses it on the pipe;
  - a strict hand-written JSON parser with a 1 MiB limit;
  - "ASCII letters", and the qualified "Arguments passed literally" scenario;
  - the fallbacks and the merge rule if the UTF-8 console test fails;
  - the helper frees its own console before the attach.

## 1. Windows command lines and scenario mapping

- [x] 1.1 Add `src/main/platform/windows/command-line.ts` (design D1), with:
  - `quoteArgument` (the `CommandLineToArgvW` rules);
  - `batchCommandLine(cmdExe, file, args)`: simple arguments (`^[A-Za-z0-9_+\-.:/\\@]+$`) pass bare, and every other argument is quoted and escaped as `cmd-quote.mjs` does, with its refusals and the 8191-character and `SHIM_LINE_RESERVE` limits;
  - `shellCommandLine(cmdExe, script)`: `cmd.exe /d /v:off /s /c "<script>"`, verbatim, refusing an empty or blank script, a line break or NUL, and a full line beyond 8191 characters including the prefix and the closing quote.

  Each refusal throws a typed error whose message names the limit. Verify with unit tests on every system:
  - over the W0 corpus (`scripts/windows-probe/cmd-corpus.mjs`), arguments that need quoting produce exactly `cmd-quote.mjs`'s text, and simple ones the bare form;
  - `quoteArgument` round-trips through a `CommandLineToArgvW` reference parser written in the test;
  - a script of exactly the longest allowed length passes, and one character more is refused;
  - every refusal is covered, tagged `[spec:project-registry/unrepresentable-argument-refused]` and `[spec:project-registry/multi-line-script-refused-on-windows]`.
- [x] 1.2 Map every new scenario of this change:
  - add one tagged `it.todo` per scenario a later group implements, in the file where its test will live;
  - `windows-process-trees-verified-natively` keeps its existing test;
  - `start-on-windows` keeps its test until group 6, since its requirement is removed only there.

  Verify: `npm run spec-coverage` reports zero unmapped scenarios, `test-platform-policy.test.ts` passes, and `openspec validate add-windows-environment-and-commands --strict` passes.

Group 1 review (2026-11-07): reviewer2 found no high items, 1 medium, 3 low and 3 nits, and no injection path in the quoting. The re-review confirmed all fixed.
- medium: the seeded random generator lost precision, so most argument lengths were never drawn. It is now mulberry32, with a test that all lengths occur, and five mutations of the quoting are each caught.
- low:
  - a model of `cmd.exe`'s two caret and quote parses now checks bare and quoted arguments side by side (percent expansion is left to corpus parity and the group 2 Windows tests);
  - the corpus check accepts a case with no arguments;
  - unpaired surrogates are refused before the helper, naming the position, not the text.
- nits: the error-message comment is precise about paths, `\\.\` and `\\?\` paths are refused, and the batch file's type is noted as the resolver's job.
- Recorded on task 2.2: its placeholders move out of `windows-commands.test.ts` and become real tests.
- Verified on Linux: typecheck, lint, `npm test` (1096 passed, 8 todo), spec coverage 167/167, `openspec validate --strict`. Windows CI runs on the pull request.

## 2. Helper protocol version 2 and the UTF-8 console

- [x] 2.1 In `veydr-helper.cs` (design D1):
  - change `run` to `run <pipe>`;
  - read the token, connect, and send `ready`, and only then read one UTF-8 JSON line from stdin, `{"application", "commandLine"}`, with a strict hand-written parser (design D1) and a 1 MiB limit;
  - report every refusal as an `error` line on the pipe, never on stderr;
  - refuse NUL, a relative or drive-relative application, a command line beyond 32,767 characters, and a batch-file application (`IsBatchFile`, trailing dots and spaces trimmed);
  - pass both to `CreateProcess` unchanged;
  - remove `BuildCommandLine` and `BatchArgument`;
  - set `ProtocolVersion = 2`.

  `started` gains `utf8Console` and `ansiCodePage` in this version (design D5); until task 2.3, `utf8Console` is always `false`. On the TypeScript side:
  - `protocol.ts` and `helper-client.ts` move to version 2 and write the JSON line after the token;
  - `SpawnPlan` gains the optional `commandLine`;
  - `windows/process-tree.ts` uses `plan.commandLine`, or quotes `file` and `args` with `quoteArgument`, and refuses a batch-file `file` without a `commandLine`.

  Verify:
  - unit tests for the version mismatch (a version 1 helper is refused, and its message names the helper);
  - unit tests for the stdin line, the batch-file refusal, and the new `started` fields;
  - a refusal appears as an `error` message and not on the helper's stderr;
  - fake-helper and Windows tests for the parser: quotes, backslashes, every escape, non-BMP characters, a lone surrogate, duplicate and unknown keys, and trailing text refused;
  - `npm test` passes on Linux;
  - the helper builds with `/warnaserror+` in the `windows` job.
- [x] 2.2 Update the W1 Windows integration tests for the new `run` form, and add these to `windows-process-tree.test.ts`:
  - **The shim corpus:** the W0 shim corpus runs through the real helper. An `npm.cmd`-style `fwd.cmd` forwards `%*` to a Node recorder; every case arrives unchanged, and no sentinel file is created (`[spec:project-registry/shim-arguments-arrive-unchanged]`).
  - **A plain batch file:** `build.bat release C:\out\`, which tests `if "%1"=="release"` and echoes `%~2` (`[spec:project-registry/simple-batch-arguments-reach-the-batch-file-as-written]`).
  - **The batch-file refusal:** the helper refuses a batch-file application.
  - **A long line:** a direct-mode line of 32,000 characters starts.

  The `it.todo` placeholders for the shim corpus and the plain batch file sit in `test/integration/windows-commands.test.ts` (group 1), since `workflow-policy.test.ts` forbids `it.todo` in `windows-process-tree.test.ts`. Remove them there when these tests land; they must become real tests, never skips. Task 4.3 does the same for `batch-file-editor-on-windows`.

  Verify: on the pull request, the `windows` job reports every Windows integration test as run, with the W1 scenarios still passing.
- [x] 2.3 In the helper, set the command's console to output code page 65001 (design D5). Free the helper's own console first and re-register its Ctrl handling. After the suspended `CreateProcess`, attach to the leader's console, call `SetConsoleOutputCP(65001)`, re-register the Ctrl handler, detach, and resume. `started.utf8Console` reports the result, and a failure is logged as `process.windows-console-not-utf8`. Add a Windows integration test showing that `started.utf8Console` is `true`, and that `cmd /c echo` of a non-ASCII string writes its UTF-8 bytes. Verify on the `windows` job. **If `utf8Console` is `false` on the runner, pause and report it**, with the attach error and a recommendation between design D5's fallbacks (attach after the resume, or a console-owning wrapper). Group 2 does not merge until that is decided: group 5's decoding depends on it.
  - Result (2026-11-07, #38): `utf8Console` was `false`. `AttachConsole` on the suspended leader fails with error 6. The user chose fallback (b): the console host `veydr-helper console` (design D5, "Decision"). On `af8a8ea` the `windows` job passed: `utf8Console` was `true` in every run, no `process.windows-console-not-utf8` was logged, and `cmd /c echo` wrote UTF-8.
- [x] 2.4 Update `docs/dependencies.md` (the helper section: the `run` form, protocol version 2 with stdin and the batch-file refusal, and the UTF-8 console). Verify: the docs tests pass.

Group 2 review (2026-11-07): reviewer2 found no high items, 2 medium, 4 low and 3 nits, and no injection path. The re-review approved all fixes.
- medium:
  - a program path such as `C:\evil.bat\.` normalizes to a batch file while its last segment does not look like one. Both sides now refuse an empty, `.` or `..` segment, or one of only dots and spaces (`hasDotSegment`, `HasDotSegment`);
  - `AttachConsole` on the suspended leader is unverified. The raw-protocol accept cases now assert `utf8Console: true` as well, so the `windows` job fails loudly if it does not work.
- low:
  - the helper checks that argv[0] is the quoted program, and refuses `"` and line breaks in it, as `helperLaunch` does;
  - the helper reads its stdout and stderr before freeing its console, and refuses console handles;
  - a plan with both a `commandLine` and separate `args` is refused;
  - the run request ends with `\n` only.
- nits: the plan's own checks run before the helper's version is read (fixed). `helperLaunch` running twice per spawn, and a truncated message splitting a surrogate pair, are harmless and left as they are.
- Additions beyond the design, kept after review: `started.consoleError` (task 2.3 needs the attach error), and the refusal of device paths, data streams and an argv[0] other than the program.
- Verified on Linux: typecheck, lint, `npm test` (1120 passed, 8 todo), spec coverage 167/167, `openspec validate --strict`.

Group 2 on Windows (#38, 2026-11-07):
- The first `windows` run failed for two reasons:
  - The scenario cleanup started one PowerShell per scenario, which outlasted the 10 s hook limit. It now uses one query (`6e78545`).
  - Task 2.3's gate: `AttachConsole` on the suspended leader fails with error 6. Fallback (b) was implemented (`db14132`).
- Console host review: reviewer2 found 1 medium, 2 low and 2 nits. The re-review approved the fixes (`af8a8ea`):
  - medium: the host was released before the command resumed, so a stall could end the console before the command connected, and an early stop lost its Ctrl+Break. The host is now released after the resume, and gone before `started`.
  - low: the answer reader catches every exception; the answer timeout is 5 s, and D5 notes the cost.
  - nits: a leaked reader on the timeout path, and Windows Terminal delegation, left as they are. Also left as is: a command that exits within the host's 5 ms poll delays `started` by up to 2 s, which is harmless.
- Verified on the `windows` job (`af8a8ea`): the helper builds with `/warnaserror+`; `windows-process-tree.test.ts` ran all 29 tests and all passed, the W1 scenarios included; Windows unit tests 1048 passed, with only the Linux-only files skipped. `ci-ok` passed.

## 3. Windows command resolver

- [x] 3.1 Move the project-folder and working-directory checks of `linux/resolver.ts` unchanged into `src/main/platform/resolve-cwd.ts`, with the realpath function injectable, and use it from the Linux resolver. Verify: the existing Linux resolver unit and integration tests pass unchanged.
- [x] 3.2 Add `windows/resolver.ts` (design D2):
  - **Paths:** drive and UNC paths are used as given, drive-relative and root-relative paths are refused, and other paths are resolved against the working directory.
  - **Bare names:**
    - looked up in `Path` with surrounding quotes stripped and empty or relative entries skipped;
    - each directory has a 2 s limit, and a skipped directory is named;
    - the working directory is never searched;
    - `PATHEXT` is tried in order, defaulting to `.COM;.EXE;.BAT;.CMD`;
    - existence is checked with `lstat`;
    - a first match outside `.exe`, `.com`, `.bat` and `.cmd` is refused;
    - batch files are planned through `batchCommandLine`.
  - **Shell mode:** an absolute `cmd.exe` only, through `shellCommandLine`.
  - **`cmd.exe`:** `<SystemRoot>\System32\cmd.exe`, with the `C:\Windows` fallback, and `realpath.native` for the working-directory checks.

  Verify with unit tests using a fake filesystem, on every system, covering:
  - lookup order and extension handling;
  - quoted, empty and relative `Path` entries, and a directory that times out;
  - the working directory not being searched (`[spec:project-registry/working-directory-not-searched]`);
  - an extensionless `npm` beside `npm.cmd`, which is no match (as with `cmd.exe`), and a `.js` first match before `npm.cmd`, which is refused (`[spec:project-registry/unsupported-program-type-refused]`);
  - drive-relative and root-relative paths (`[spec:project-registry/drive-relative-program-path-refused]`);
  - refused shells (`[spec:project-registry/other-shell-refused-on-windows]`);
  - the `SystemRoot` fallback.
- [x] 3.3 Add Windows integration tests (`windows-commands.test.ts`, `[windows-only: cmd.exe and PATHEXT]`), each through the resolver and the real helper:
  - `npm` resolves to an `npm.cmd` on `PATH` and starts (`[spec:project-registry/program-found-through-pathext]`);
  - a decoy `npm.cmd` in the working directory is not run;
  - a shell-mode `cmd.exe` script with `&&` and `%VARIABLE%` runs and prints its result (`[spec:project-registry/cmd-exe-script-runs]`);
  - an App Execution Alias on the runner (if one exists, e.g. `winget.exe`) is found; if none exists, the test says so in its title and is not counted as evidence;
  - a refused input creates no process (checked with `Get-CimInstance`).

  Verify: `npm run test:windows` covers the new file, and the `windows` job reports every test as run.
- [x] 3.4 Document in `docs/commands.md`, under a "Windows (not yet available)" heading that group 6 lifts:
  - the resolver rules, including the refusal of a first match of another type and of drive-relative paths;
  - the `cmd.exe`-only shell mode and its 8191-character limit;
  - simple and quoted batch arguments, and batch files that read quoted arguments through `%1` themselves;
  - naming `cmd.exe` as a direct-mode program.

  Verify: the docs tests pass.

Group 3 implementation note (2026-11-07): the first draft of task 3.2 and design D2 asked for a test that refuses "an extensionless `npm` before `npm.cmd`". By D2's own lookup rule a name without an extension is tried only with `PATHEXT` extensions, as `cmd.exe` does (W0 `cmd-pathext`), so the extensionless `npm` that Node.js installs beside `npm.cmd` is no match; refusing it would make `npm` unusable on every Node.js install. The test now pins that it is ignored, and the refusal of another type with a `.js` first match (and `.vbs`, `.ps1`). Task 3.2 and D2 are reworded to match.

Group 3 review (2026-11-07): reviewer2 found no high items, 2 medium, 5 low and 3 nits, and agreed with the extensionless-`npm` note above.
- medium:
  - a timed-out `Path` directory kept checking its remaining `PATHEXT` candidates, each able to hang a libuv filesystem thread. A cancelled directory now starts no further check, and the search stops after `MAX_UNANSWERED_DIRECTORIES` (2) unanswered directories;
  - only `Path` directories were time-limited. The project folder, the working directory, and a program or shell given by path now have the same 2 s limit.
- low:
  - DOS device names (`CON`, `NUL`, `COM1`, …, with any extension) are refused in names and path segments;
  - the shell path gets the same segment checks as a program path;
  - only the segments of the path as given are checked, not the working directory's;
  - a link that leads to a directory or nowhere is no match, and an App Execution Alias (which `stat` cannot follow) still is;
  - the "no process for a refused input" test's title says what it checks, and the alias test says when it is no evidence.
- nits: `Path` is parsed as `cmd.exe` parses it (a `;` between quotes is kept); a `PATHEXT` with no usable extension is logged; the `resolve-cwd.ts` comment says what changed. New unit tests cover `EACCES` and `ENOTDIR` on a path, `python3.11` beside `python3.11.exe`, and the `npm.CMD` spelling, which the docs now mention.
- Re-review: no high items, 1 medium, 1 low and 2 nits; every earlier finding confirmed fixed.
  - medium: a hung check outlived its search, so repeated starts could still use up the filesystem threads. The resolver now remembers abandoned checks by directory or path; while one is waiting, that place counts as unanswered at once and gets no new check.
  - low: an unbalanced quote in `Path` joins the rest into one entry, as in `cmd.exe`; pinned by a test and documented.
  - nits: the follow-up `stat` of a link also stops in an abandoned search; device names as path segments are correct as they are.
- Second re-review: no high or medium items; 2 low and 1 nit, all fixed:
  - a hung UNC check is now remembered by server, so one dead server cannot hold more than one thread per kind of check; a mapped network drive is still keyed by path, which D2 notes;
  - task 6.1 requires one resolver per platform, since the memory lives in the resolver;
  - the key ignores a trailing separator.
- Verified on Linux: typecheck, lint, `npm test`, the Linux integration tests, spec coverage 167/167, `openspec validate --strict`. The Windows integration tests run on the pull request.

## 4. Windows environment and editor launch

- [x] 4.1 Add `windows/environment.ts` (design D3):
  - it starts from `withoutRuntimeVariables(process.env)`;
  - it drops empty names, names starting with `=`, and names containing NUL;
  - it merges names that differ only in case into the case-insensitive lookup's entry;
  - it logs `environment.names-merged` with the names only.

  Verify with unit tests on every system, using a fake inherited environment that holds `Path` and `PATH`, `=C:`, and `ELECTRON_RUN_AS_NODE`, tagged `[spec:project-registry/windows-base-environment]`. The effective environment with an override `PATH` holds exactly one entry.
- [x] 4.2 Add a Windows integration test showing that a started command sees exactly one path variable, with the expected value, and no `ELECTRON_*` variable. Verify: the `windows` job runs it.
- [x] 4.3 Implement `launchDetached` in `windows/process-tree.ts` (design D4):
  - `spawn` with `detached`, `stdio: 'ignore'` and `windowsVerbatimArguments`, with `commandLine`'s argv[0] stripped, then `unref` (no `windowsHide`: see the group 4 review);
  - a batch-file `file` without a `commandLine` is refused;
  - a missing program rejects with `SpawnError`.

  Verify with a unit test of the exact `spawn` arguments, and with Windows integration tests:
  - a `.cmd` editor receives a project path with spaces, `&` and `^` as one argument, and no other command runs (`[spec:project-registry/batch-file-editor-on-windows]`);
  - the editor survives the ending of a host process that launched it, inside the runner's job, and the test records whether the editor is in a job;
  - no new `ConsoleWindowClass` window appears for a batch file that starts a GUI-subsystem fixture;
  - a missing editor rejects.

  Verify: the `windows` job runs them all.
- [x] 4.4 Document in `docs/commands.md`:
  - the Windows environment: inherited, names merged, a restart needed after a `PATH` change, and **Refresh** reads nothing new;
  - the editor launch on Windows, including that a batch-file editor which starts a console program shows that program's console.

  Verify: the docs tests pass.

Group 4 review (2026-11-08): reviewer2 found 1 high, 4 medium, 5 low and 4 nits. The re-review confirmed all fixes and found 2 low items and 1 nit; both lows are fixed.
- high: `windowsHide` becomes `SW_HIDE` in the child's `STARTUPINFO`, so a GUI editor started directly could open with its first window hidden. `launchDetached` no longer passes it (`DETACHED_PROCESS` already keeps a console program from getting a console). A unit test pins it, and design D4 and task 4.3 are reworded.
- medium:
  - the editor tests' programs linger for 60 s, longer than the PowerShell checks take;
  - the control test waits for both a console host and a console window, so the "no console" check is shown to see one;
  - the survival host first supervises a command through the helper, so libuv's kill-on-close job exists, as in Veydr. The test asserts that the command and its helper end while `cmd.exe` and the editor survive;
  - the editor gets the base environment, without a command's overrides. Task 6.1's wiring must keep that.
- low:
  - a missing `error` event times out (`SPAWN_ERROR_WAIT_MS`) into a `SpawnError`, and the error listener is attached before that wait, so a late event is logged rather than crashing;
  - a `__proto__` variable is kept (null-prototype objects, no `withoutRuntimeVariables` call, whose denylist is applied case-insensitively already);
  - `base()` rejects instead of throwing;
  - the `toUpperCase` caveat is commented;
  - the docs mention dropped NUL values.
- nits: the host's options go over stdin, not its command line; the argv[0] prefix of a detached launch is checked explicitly. Left as is: the survival test finds the host's helper by the dead host's PID, which cannot be reused within its 15 s wait in practice.
- Additions beyond the design, kept after review: runtime variables are removed regardless of case, and names containing `=` anywhere are dropped (not only a leading `=`).
- Verified on Linux: typecheck, lint, `npm test` (1178 passed), spec coverage 167/167, `openspec validate --strict`. The Windows integration tests run on the pull request.

Group 4 on Windows (#41, 2026-11-08):
- The first `windows` run failed in one test: the control that shows the console check can see a console (a batch-file editor that starts Node.js). It looked for a `conhost.exe` by its parent process and for console window classes, and found neither within 30 s. `0e74ee4` reads a process's console with `AttachConsole` and `GetConsoleWindow` instead, as the W0 probes did (`pt-console-window`). A timeout now reports what the check saw.
- Verified on the `windows` job (`0e74ee4`):
  - `windows-commands.test.ts` and `windows-process-tree.test.ts` ran 41 tests, and all passed. The one todo is group 5's `console-output-on-windows` placeholder.
  - Windows unit tests: 1106 passed, with only the Linux-only files skipped.
  - `ci-ok` passed.
- Evidence recorded (design D4): the detached editor is in a job on the runner (`the detached editor is in a job: true`). It still survives the host that launched it being killed, while that host's supervised command and its helper end.

## 5. Output decoding on Windows

- [x] 5.1 `ManagedProcess` gains `outputFallbackEncoding` (design D5): on Windows, the WHATWG label of `started.ansiCodePage`, or `null`; on Linux, `null`. Verify: unit tests for the code-page-to-label table, including an unknown code page, and `npm test` passes.
- [x] 5.2 Give `createLineSplitter` an optional fallback decoder. When it is set:
  - lines are split on `\n` bytes and decoded with a fatal UTF-8 decoder, falling back for each line;
  - the 16 KiB cut drops a trailing incomplete UTF-8 sequence;
  - the partial-line display decodes the same way.

  The supervisor passes `outputFallbackEncoding` to the log service. Verify with unit tests on every system:
  - a mix of UTF-8 and windows-1252 lines (`[spec:process-logs/ansi-output-on-windows]`);
  - a Shift_JIS line, using synthetic bytes;
  - a cut through a multibyte UTF-8 character, and one through a Shift_JIS character, which shows one replacement character;
  - CRLF and partial lines;
  - Linux output unchanged (`[spec:process-logs/invalid-utf-8]` still passes).
- [x] 5.3 Add Windows integration tests:
  - a `cmd /c echo` of a non-ASCII string reaches the log unchanged (`[spec:process-logs/console-output-on-windows]`);
  - a Node fixture writing windows-1252 bytes is shown decoded.

  Verify: the `windows` job runs them.
- [x] 5.4 Document Windows output decoding in `docs/logs.md`:
  - the UTF-8 console, and what happens when it cannot be set;
  - the ANSI fallback;
  - OEM bytes written straight to a pipe;
  - a multibyte character cut at 16 KiB;
  - `PYTHONUTF8=1` and `chcp`.

  Verify: the docs tests pass.

Group 5 implementation note (2026-11-08):
- The decoded text of a line is cut again to 16 KiB of UTF-8, at a character boundary, and marked truncated. `LineListener` promises at most `MAX_LINE_BYTES` UTF-8 bytes, and the log API refuses longer text (`MAX_LINE_TEXT_LENGTH`), but a 16 KiB ANSI line decodes to up to 48 KiB. Since ANSI text never shrinks when decoded, a Shift_JIS character split by the byte cut is always dropped by this second cut. Task 5.2's "shows one replacement character" is therefore tested as "never shows part of a character", and design D5 and `docs/logs.md` say so.
- The splitter with a fallback works on bytes, so it sees the bytes of a character before the character is complete. For UTF-8 output it emits exactly what the UTF-8-only splitter emits, which a seeded comparison checks with random chunks and pauses between characters. A pause inside a character differs in two ways, each pinned by a test: a lone `\r` already restarts the line, and a partial line past the limit is already marked truncated.
- Additions beyond the design: an unsupported fallback label is logged (`logs.fallback-encoding-unsupported`), and the run is then captured as UTF-8 rather than losing its output. The supervisor passes the encoding as a fourth argument of `OutputSink.open`.

Group 5 review (2026-11-08): reviewer2 found no high or medium items, 2 low and 3 nits.
- low:
  - redaction missed a secret printed in UTF-8 on a line the fallback decodes, because of another ANSI byte or a lead byte that swallows the secret's first character. The splitter now gives such a line's UTF-8 view as well. If that view shows a secret, the log keeps it, redacted, instead of the ANSI reading, and a partial line keeps back the start of a secret found in either reading (`Redactor.exposes`, documented in `docs/logs.md`);
  - a partial line whose decoded text passed the limit was cut, but the line then went on as a new one. It is now truncated, and the rest of it up to its newline is dropped.
- nits: the comment on dividing a partial line now gives the Shift_JIS example. Left as they are: OEM bytes read as ANSI text (D5 and the docs state it), and the byte-by-byte decode of a partial ANSI line (at most one per 100 ms pause).
- Re-review: both lows and the nit confirmed fixed; no high, medium or low items, 2 nits, both fixed:
  - a pause inside the UTF-8 character after a secret's start, on an ANSI line, showed that start: the hold-back now reads the line without its incomplete last character, and keeps that character back with the secret's start;
  - the splitter's doc comment sits on the function again, not on the `Decoded` interface.
  - Noted, as documented: a line shown in its UTF-8 reading because it exposed a secret shows its ANSI characters as `�`.
- Verified on Linux: typecheck, lint, `npm test` (1261 passed), the Linux integration tests, spec coverage 167/167, `openspec validate --strict`. One local `verify` run failed in the integration stage after 444 s (output not kept) while another session loaded the machine; it passed on the three runs after. The Windows integration tests run on the pull request.

## 6. Windows platform composition and the preview

- [x] 6.1 `createWindowsPlatform({ helperPath, log, inherited })` returns `supported: true`, the D2 `defaultShell`, the resolver, the environment provider and the full process tree, and keeps the unsupported port inspector (design D6). `selectPlatform` passes `inherited`. Create exactly one Windows resolver per platform, shared by every start: the resolver remembers hung checks (design D2), which a resolver per start would forget. Verify:
  - `npm run typecheck`;
  - `npm run lint` (only the composition root and `platform/index.ts` read `process.platform`);
  - `npm test`.
- [x] 6.2 Replace `[spec:process-supervision/start-on-windows]` in `supervisor.test.ts` with a planner test over the Windows platform's resolver and environment, which plans and spawns a command. Tag it `[spec:process-supervision/command-started-on-windows]`, together with a Windows integration test that starts, logs and stops one through the composed platform. Remove the `start-on-windows` todo or tag. Verify: `npm run spec-coverage` reports zero unmapped scenarios.
- [x] 6.3 Change the smoke test's platform check: it calls `envProvider.base()` everywhere, and `portInspector.list()` unless the inspector rejects with `UnsupportedPlatformError`, in which case the check says so. In the renderer, the shell field's hint on Windows reads "cmd.exe only". Verify: unit tests for both, and `npm run build`.
- [x] 6.4 Update the README (support statement and platform table) and `docs/processes.md` to "Windows: preview. Run from source; verified in CI on Windows Server 2025. No Windows package yet.". Also:
  - add "Running from source on Windows";
  - lift the "not yet available" headings of groups 3–5;
  - extend the not-verifiable list with localized ANSI code pages, a customized `PATHEXT`, App Execution Aliases beyond the runner, and an Explorer-launched environment;
  - update `docs/deferred-checks.md`;
  - mark the W0 evidence notes that W2 resolves.

  Update the docs tests:
  - re-tag `[spec:process-supervision/windows-limitations-documented]` to require the preview label instead of "not yet reachable from the app";
  - add `[spec:process-supervision/windows-preview-documented]`, which checks that "run from source", "no Windows package" and the not-verifiable list are present, and that no support claim goes beyond them.

  Verify: `npm test`, and `grep -rn "Windows" README.md docs/` shows no claim beyond the preview.

Group 6 implementation note (2026-11-08):
- `npm run spec-coverage` read the main specs and the active changes' deltas, but not a delta's REMOVED requirements, so `start-on-windows` stayed unmapped once its test was removed. The script now leaves out the main-spec scenarios of a requirement that an active change removes (166 scenarios, all mapped).
- The planner test runs the platform's own resolver on every system. `createWindowsPlatform` therefore takes an optional `resolverFs`, which only tests pass. `SystemRoot` is read once from `inherited`, regardless of letter case.
- The smoke test's platform check reports only how many environment variables there are, never their values.
- The W0 notes that W2 resolves are marked in `docs/windows-evidence.md` (the `cmd.exe` route, `PATHEXT`, output decoding, the environment). The note on the e2e harness stays open until group 7. Until then, `docs/deferred-checks.md` says that the end-to-end suite does not run on Windows yet.

Group 6 review (2026-11-08): reviewer2 found no high items, 1 medium, 5 low and 2 nits. It confirmed that one resolver serves both starts and the editor launch, and that the editor still gets the base environment without overrides.
- medium: on Linux, `--smoke-test` now runs the login shell through `envProvider.base()`. reviewer2 preferred calling `base()` on Windows only. That would narrow task 6.3 ("calls `envProvider.base()` everywhere"), so the behavior is kept and made explicit instead:
  - the comments in `smoke.ts` and `index.ts`, `docs/install-linux.md` (the `platform` row: the login shell runs once) and the README say so;
  - a fallback passes with its warnings counted, since commands still start then, and a test pins it;
  - a provider that rejects fails the check.
- low:
  - the doc-claim tripwire no longer flags "supports Windows paths". It also catches "runs/works on Windows", "Windows 11 is supported" and "Windows users can install", and a self-test checks both directions;
  - `spec-coverage.mjs` skips fenced code blocks;
  - its header states that the exemption for removed requirements lasts only while the change is active, and that a leftover tag on a removed scenario fails as unknown (checked once);
  - an unusable `SystemRoot` is logged once (`platform.windows-system-root-fallback`, without the value; `isUsableSystemRoot`).
- nits: `inheritedValue` moved next to `windowsBaseEnvironment`, which follows the same first-entry rule, and the port inspector is a small local constant.
- Re-review: every finding confirmed fixed, and no new findings. reviewer2 agreed that keeping `base()` on every platform follows task 6.3.
- Verified on Linux after the fixes: typecheck, lint, `npm test` (1269 passed), the Linux integration tests (50 passed, Windows-only files skipped), spec coverage 166/166, `openspec validate --strict`, `npm run build`. The Windows integration tests run on the pull request.

## 7. End-to-end tests on Windows

- [x] 7.1 Add `test/support/processes.ts` (design D7):
  - `taggedProcesses`, `isAlive`, `killTagged` and `processIdentity`, through `/proc` on Linux and one `Get-CimInstance` call on Windows;
  - it throws on any other system, and on a failed or unparsable query; it never returns an empty list for a failure;
  - a sanity test on both systems requires a started tagged process to be seen;
  - the process reading is removed from `proc.ts`.

  `test-platform-policy.test.ts` allows exactly this file and exactly one dispatch, and asserts that the dispatch throws for an unknown platform. Verify:
  - the Linux e2e suite passes unchanged in the `e2e` job;
  - `test-platform-policy.test.ts` passes, and fails on a temporary platform branch added elsewhere (checked once, then reverted).
- [x] 7.2 Classify every e2e spec in a table in `docs/ci.md` (design D7) as portable, Linux-only, or Windows-specific, then port them:
  - **Portable specs:** use the portable helper and Node fixtures instead of `sh`, `sleep`, `trap` and `kill`, and read platform values from `AppInfo`.
  - **Linux-only tests:** get `skipIf` guards with `[linux-only: <facility>]` titles (network namespaces, the login shell, port inspection until W3), tagged `[spec:quality-gates/linux-only-end-to-end-test-on-windows]` where checked.
  - **Windows-only specs** (`windows-*.spec.ts`) assert behavior that differs:
    - crash recovery: the trees end, so no survivors are shown;
    - the Ports view's unavailable state;
    - that the started app found the helper (which checks that `app.getAppPath()` is the repository root).
  - **A sandbox test** asserts that the renderer runs sandboxed (`[spec:quality-gates/windows-end-to-end-tests-keep-the-sandbox]`).
  - **`offline.spec.ts` counts itself:** its runner re-runs the file in a network namespace and requires exactly `1 passed` and `1 skipped`. Every test added to that file, a guard or a placeholder, changes those counts, so update the runner's expectation with it. Group 1's placeholder broke the `e2e` job on #37 this way, and now sits in `ports.spec.ts`.

  Verify: `npm run test:e2e` passes on Linux, and the table lists every spec file.
- [x] 7.3 In `ci.yml`'s `windows` job:
  - set `electron: "true"`;
  - add "Windows end-to-end tests" (`npm run test:e2e`) after the integration tests, with `if:` requiring the helper build's success;
  - add an `upload-artifact` step for `test-results/` on failure;
  - raise `timeout-minutes` to 45.

  Extend `workflow-policy.test.ts` for the steps, their conditions, and the absence of `--no-sandbox` and `VEYDR_ALLOW_SKIP_OFFLINE`, and update the check-set test for the modified scenario (`[spec:quality-gates/pull-request-runs-the-full-check-set]`). Document the steps in `docs/ci.md`. Verify on the pull request:
  - the `windows` job runs the e2e step;
  - every Windows e2e test is reported as passed or as skipped with a `[linux-only: …]` reason, and none fails for lack of porting;
  - `ci-ok` passes.

Group 7 implementation note (2026-11-09):
- `test/support/processes.ts` reads processes through `/proc` on Linux and one `Get-CimInstance Win32_Process` call per query on Windows. The tag is an environment variable, which Win32_Process does not expose, so each candidate's environment block is read from its PEB by a small C# reader, compiled once per test process into a private temporary directory. A Windows query must first read its own environment, or it throws. Console hosts and `veydr-helper.exe` carry a command's environment, but they are not counted as its processes. `commandLines` was added for the sandbox test, and `linuxProcess` keeps the `/proc/<pid>/stat` fields for `[linux-only: /proc]` tests.
- The fixture ledger records `pgid`, `sid` and `starttime` only where `/proc` exists, and `LedgerEntry` marks them optional. `isAlive` throws without a start time.
- Two harness gaps that design D7 did not name, both fixed in test code only:
  - **The configuration directory.** On Windows, Electron ignores `XDG_CONFIG_HOME`, so every test would share `%APPDATA%\Veydr`. `test/e2e/support/config-home.cjs` sets `appData`, and only that: a `-r` preload runs before Electron derives `userData`, and setting `userData` too pinned `<home>/Electron`. That first attempt failed 40 Linux tests, and the fix was checked by launching Electron directly.
  - **Temporary paths.** The runner's `%TEMP%` is an 8.3 short path, so `test/e2e/support/temp.ts` uses real paths, and its cleanup retries for files Chromium still holds.
- `commandProcesses` leaves out Chromium's `--type=` processes, which inherit a tag that a test gives Veydr itself. Their environment is readable on Windows.
- POSIX shell output in the portable specs comes from the new `test/fixtures/proc/print.mjs`. `tree.mjs --ignore-term` also ignores Ctrl+Break.
- The classification table is in `docs/ci.md` ("End-to-end tests on Windows"). `test-platform-policy.test.ts` checks it against the specs' guards: one row per spec, a file-wide guard for Linux-only and Windows-specific specs, and the listed reasons equal to the guards' reasons. That test is tagged `[spec:quality-gates/linux-only-end-to-end-test-on-windows]`. The policy allows exactly one dispatch, in `processes.ts`, and a test checks that the dispatch throws on darwin, freebsd and aix. A temporary branch added in `test/e2e/support/temp.ts`, and a second one in `processes.ts`, each failed the policy (checked once, then reverted).
- Windows-specific specs:
  - `windows-recovery.spec.ts` (`veydr-ends-abnormally-on-windows`);
  - `windows-ports.spec.ts`;
  - `windows-app.spec.ts` (the app path is the repository root, the helper is found, and a command starts, logs and stops).

  `security.spec.ts` checks on Windows that every renderer is sandboxed below medium integrity (`windows-end-to-end-tests-keep-the-sandbox`, together with `workflow-policy.test.ts`).
- Verified on Linux: typecheck, lint, `npm test` (1279 passed), the Linux integration tests (50 passed), `npm run test:e2e` (72 passed; 5 skipped: the inner offline test, as before, and 4 Windows-only tests), spec coverage 166/166, `openspec validate --strict`, and actionlint. Task 7.3's Windows verification runs on the pull request. No Windows e2e test has run yet.

Group 7 review (2026-11-09): reviewer2 found 1 high, 4 medium, 6 low and 3 nits. Every Windows claim was checked by reading the code; nothing ran on Windows.
- high: the C# matcher threw on the empty entries that end every environment block, which would have failed every Windows query. Entries shorter than two characters are skipped now. Each tag query also first checks the matcher on its own environment: it must find an entry under another letter case, and must not find a different value.
- medium:
  - a process that could not be read was dropped silently. `Status` now tells Gone from Unreadable, and `taggedFromRows` fails the query when an unreadable process was started by a tagged one, unit-tested on every system;
  - an exited process could still count as alive. Queries by PID now keep only live processes (`Exists`: `GetExitCodeProcess`);
  - `commandLines` on Linux now tolerates `ESRCH`;
  - query latency: a query slower than 5 s is reported on stderr, for the first Windows run.
- low:
  - the compiled reader is written to a temporary name, then copied and renamed;
  - PowerShell writes its output as UTF-8;
  - `commandProcesses` leaves out only Electron's own executable started with `--type=`;
  - the Windows stop text (`Exited with code 3221225786`, STATUS_CONTROL_C_EXIT) is pinned in `windows-app.spec.ts`;
  - `launchVeydr` fails unless `userData` is `<configHome>/Veydr`, on every system;
  - the sandbox metrics are read after the window loaded.
- nits: the comment on the temporary directory no longer calls it private. The other two needed no change.
- reviewer2 judged both harness additions (`config-home.cjs` and `temp.ts`) justified.
- Verified on Linux after the fixes: typecheck, lint, `npm test` (1280 passed), and `npm run test:e2e` (72 passed, 5 skipped).

Group 7 re-review (2026-11-09): reviewer2 confirmed every finding fixed and raised 2 new mediums-to-lows, both fixed:
- N1 (medium): the unreadable-child check could fail on Chromium's own sandboxed processes when a test starts Veydr with the tag. Processes of `electron.exe` started with `--type=` are exempt, and a unit test covers both the exemption and a command process that only carries the argument.
- N2 (low): a null `CreationDate` would have ended the query. A tag query now prints only unreadable processes that a tagged one started, and the timestamp is guarded.
- N3 is documented in `taggedFromRows`: the check is one level deep. N4 is the first thing to check on the pull request: whether the Windows stop text was pinned right.
- Verified on Linux: lint, `npm test`. Everything Windows-specific waits for the pull request's `windows` job.

Group 7, first Windows run (#45, 2026-11-09): typecheck, lint, the unit tests (the process-helper sanity test included) and the Windows integration tests passed; the e2e step failed, with 48 failed, 11 passed and 18 skipped. Every Linux-only skip carried its reason. No process query was slower than 5 s. Causes:
- **Product: outbound activity on Windows.** 44 tests passed their own assertions and failed only the closing network check. Chromium followed the runner's "Automatically detect settings" and resolved the host `wpad` (WPAD), probing IPv6 reachability with a UDP connect to Google's public DNS on the way. This violates desktop-shell "No outbound connections" on Windows. Fix: `disableProxyDiscovery` appends `--no-proxy-server` before `ready`. Veydr makes no requests, so it needs no proxy. Unit-tested, and documented in `network-isolation.md`.
- **Product: the shell field's accessible name.** On Windows it was "Shell cmd.exe only", because the hint inside the label was read as part of the name as well as being the description. The field is now named by its caption (`aria-labelledby`), and a renderer test pins it.
- **Harness: Playwright starts Electron through `cmd.exe` on Windows** (`shell: true`), so `app.process()` is the wrapper.
  - `windows-recovery` killed the wrapper, not Veydr, so the tree rightly stayed. There was no product fault.
  - `keyboard` counted Veydr's main process as a command.

  `VeydrApp.mainPid` (read from the app) and `VeydrApp.kill()` now target the real process, and `commandProcesses` leaves out both PIDs.
- **Harness: handle inheritance.** On Windows, Node starts children with every inheritable handle, so the detached editor inherited the stdio pipes Playwright waits on. `close()` then hung for as long as the editor ran. The editor test now quits Veydr itself and waits for the main process to end. In production this only matters when Veydr's own stdio are pipes, which happens when it is run from source. Noted, not changed.
- Confirmed on the runner: the stop text `Exited with code 3221225786`, the environment reader, `config-home.cjs`, the real-path temporary directories, and the Windows-only Ports and sandbox assertions (each of those tests reached its closing network check).
- Verified on Linux after the fixes: typecheck, lint, `npm test` (1281 passed), `npm run test:e2e` (72 passed, 5 skipped), spec coverage 166/166.

Review of the first-run fixes (2026-11-09): reviewer2 found no high items, 1 medium, 4 low and 3 nits.
- medium: `--no-proxy-server` is the right single fix, so `session.setProxy` is not added. If the IPv6 probe still shows on the next run, use the host-resolver rule `MAP * ~NOTFOUND, EXCLUDE localhost`.
- low:
  - the editor test now ends the editor in `finally`, so a failed assertion cannot hang the cleanup;
  - a rejected `app.quit()` evaluation is tolerated;
  - the handle-inheritance limit is recorded in `docs/deferred-checks.md`;
  - `exited()` rejects after 30 s with the PID.
- nits: the `commandProcesses` comment is reworded. No other editor field has a hint inside its label.
- Verified on Linux: typecheck, lint, `npm test` (1281 passed), and the affected e2e specs (commands, quit, recovery, keyboard: 16 passed).

Group 7 on Windows (#45, run 42571528735, 2026-11-09): every check passed, `ci-ok` included.
- The `windows` job ran the e2e step: 59 passed, 18 skipped, none failed.
- Every skip carries a `[linux-only: …]` reason: network namespaces, POSIX signals, POSIX file modes, port inspection, a POSIX shell, the login shell, shebang scripts and POSIX sessions, and processes outliving a crashed Veydr. None was skipped for lack of porting.
- The Windows-only tests passed: `windows-recovery` (`veydr-ends-abnormally-on-windows`), `windows-ports`, `windows-app`, and the renderer sandbox test (`windows-end-to-end-tests-keep-the-sandbox`).
- `--no-proxy-server` removed the `wpad` lookup and the IPv6 probe.
- In the same job: 1209 unit tests passed (79 skipped, the Linux-only ones), and the 44 Windows integration tests passed. No process query was reported slower than 5 s.

## 8. Integration check

- [x] 8.1 Run `npm run verify` on Linux, and check the `windows` job and `ci-ok` on the pull request. Verify:
  - all pass;
  - every Windows integration test is reported as run;
  - every Windows e2e skip carries a `[linux-only: …]` reason;
  - spec coverage reports zero unmapped scenarios;
  - `grep -rn "it.todo" test/` shows no `it.todo` tagged with a scenario of this change.
- [x] 8.2 Check what is claimed and what is unchanged:
  - `grep -rn "Windows" README.md docs/` shows the preview statement, CI notes, the evidence document and the not-verifiable list, and nothing claiming a Windows package or full support;
  - `electron-builder.yml` and `package-lock.json` are unchanged;
  - the Linux e2e and packaging jobs are unchanged in what they run.

  Verify: the checks hold, and they are recorded in the pull request and here.

Group 8 on Linux (2026-11-09, branch `tasks/windows-commands-integration-check` at `4b6389d` plus the docs fix below):
- `npm run verify` passed: typecheck, lint, the unit tests (1281 passed, 7 skipped, each `[windows-only: …]`), the integration tests (50 passed, 44 skipped: the Windows integration tests), and spec coverage (166 scenarios, 0 unmapped).
- `npm run test:e2e` passed: 72 passed, 5 skipped (the inner offline test, and 4 `[windows-only: …]` tests), as in group 7.
- `grep -rn "it.todo" test/` finds no `it.todo` tagged with a scenario of this change: only a comment in `windows-commands.test.ts`, and a string literal in `processes-docs.test.ts`.
- `grep -rn "Windows" README.md docs/` shows the preview statement in the README (support statement, platform table, "Running from source on Windows"), `processes.md`, `commands.md`, `logs.md` and `deferred-checks.md`, the CI notes in `ci.md`, the evidence document, and the not-verifiable lists. Nothing claims a Windows package or full support. Two dated rows of `deferred-checks.md` (2026-10-27 and 2026-11-03) still said "Windows remains not yet supported" with no forward pointer, unlike the 2026-10-25 and 2026-11-06 rows; both now point to the Windows preview section. They stay dated records, which `processes-docs.test.ts` already exempts.
- Since the change began (`850bf6f`), `electron-builder.yml`, `package.json` and `package-lock.json` are unchanged. In `.github/`, only the `windows` job of `ci.yml` changed; the setup action and `playwright.config.ts` are unchanged, so the Linux `e2e` and `package` jobs run what they ran before.
- The Linux app's behavior changed in three places. The passing Linux unit, integration and e2e runs above cover all three, `no-network.spec.ts` included:
  - `--no-proxy-server` applies on every system, and is recorded in design D7;
  - the Linux resolver's working-directory checks moved unchanged into `resolve-cwd.ts` (task 3.1);
  - the line splitter's fallback decoder is off on Linux, because `outputFallbackEncoding` is `null` there.

Group 8 review (2026-11-09): reviewer2 read the diff and found nothing high or medium: 3 low items, 3 nits, and one procedural point.
- low:
  - the undated row at the top of `deferred-checks.md` now opens with the Windows preview, and keeps the rest as history;
  - `windows-evidence.md` no longer says the preview statement ships with W4. It ships in W2, and W4 ships the packaged version;
  - the 8.2 note lists the Linux-visible changes, and design D7 records the proxy switch;
  - CI artifacts (`test-results/` on failure, in `e2e` and `windows`): checked, and no change is needed. The Playwright config enables no trace, screenshot or video, no spec attaches anything, the e2e secrets are dummy literals, and neither job, nor the setup action, uses a `secrets.*` value (`release.yml` does, but it uploads nothing from the e2e tests).
- nits:
  - the JSDoc in `spec-coverage.mjs` moved to `removedRequirements()`;
  - the dated 2026-10-27 row and `windows-evidence.md`'s probe record stay as they are, as the reviewer advised.
- procedure: 8.1 and 8.2 are ticked only after the `windows` job's own counts are recorded below.
- Verified on Linux after the fixes: `npm test` (1281 passed), lint, spec coverage 166/166, and `openspec validate --strict`.

- Re-review (2026-11-09): reviewer2 confirmed every finding resolved. Two nits remained: the 2026-10-27 clause of the top `deferred-checks.md` row is now in the past tense, and the secrets note above is scoped to `ci.yml`. Then recording the `windows` job's own counts, below.

Group 8 on Windows (#46, run 42648253547 at `232d7b6`, 2026-11-09): every check passed, `ci-ok` included (static, unit, integration, e2e, package, windows, codeql, dependency-review).
- The Windows integration tests: 44 passed, none skipped. Every one ran.
- The Windows unit tests: 1209 passed, 79 skipped (the Linux-only ones).
- The Windows e2e tests: 59 passed, 18 skipped, none failed. Every skip carries a `[linux-only: …]` reason: login shell; shebang scripts and POSIX sessions; POSIX file modes; port inspection and a POSIX shell; network namespaces (2); port inspection (4); POSIX signals (6); processes outliving a crashed Veydr (2).
- The Windows-specific tests passed: `windows-app`, `windows-ports`, `windows-recovery` (`veydr-ends-abnormally-on-windows`), and the renderer sandbox test (`windows-end-to-end-tests-keep-the-sandbox`).
- No process query was reported slower than 5 s.
- Tasks 8.1 and 8.2 are complete. The change is ready to archive once #46 is merged.

## Workflow follow-up

- Archive the change once its last pull request is merged.
- W3 `add-windows-port-inspection`: `ports` in the helper (`GetExtendedTcpTable`), lifting "Windows port inspection not yet supported", and the e2e Ports tests on Windows.
- W4: packaging (NSIS), the helper outside `app.asar` with its install directory's permissions checked, the standard-user smoke test, signing (G-6), and the shipped preview statement in place of "run from source".
- Optional CI hardening carried over from W1: fail a Windows test step when vitest reports an unexpected skip.
