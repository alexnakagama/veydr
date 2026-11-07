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

- [ ] 2.1 In `veydr-helper.cs` (design D1):
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
- [ ] 2.2 Update the W1 Windows integration tests for the new `run` form, and add these to `windows-process-tree.test.ts`:
  - **The shim corpus:** the W0 shim corpus runs through the real helper. An `npm.cmd`-style `fwd.cmd` forwards `%*` to a Node recorder; every case arrives unchanged, and no sentinel file is created (`[spec:project-registry/shim-arguments-arrive-unchanged]`).
  - **A plain batch file:** `build.bat release C:\out\`, which tests `if "%1"=="release"` and echoes `%~2` (`[spec:project-registry/simple-batch-arguments-reach-the-batch-file-as-written]`).
  - **The batch-file refusal:** the helper refuses a batch-file application.
  - **A long line:** a direct-mode line of 32,000 characters starts.

  The `it.todo` placeholders for the shim corpus and the plain batch file sit in `test/integration/windows-commands.test.ts` (group 1), since `workflow-policy.test.ts` forbids `it.todo` in `windows-process-tree.test.ts`. Remove them there when these tests land; they must become real tests, never skips. Task 4.3 does the same for `batch-file-editor-on-windows`.

  Verify: on the pull request, the `windows` job reports every Windows integration test as run, with the W1 scenarios still passing.
- [ ] 2.3 In the helper, set the command's console to output code page 65001 (design D5). Free the helper's own console first and re-register its Ctrl handling. After the suspended `CreateProcess`, attach to the leader's console, call `SetConsoleOutputCP(65001)`, re-register the Ctrl handler, detach, and resume. `started.utf8Console` reports the result, and a failure is logged as `process.windows-console-not-utf8`. Add a Windows integration test showing that `started.utf8Console` is `true`, and that `cmd /c echo` of a non-ASCII string writes its UTF-8 bytes. Verify on the `windows` job. **If `utf8Console` is `false` on the runner, pause and report it**, with the attach error and a recommendation between design D5's fallbacks (attach after the resume, or a console-owning wrapper). Group 2 does not merge until that is decided: group 5's decoding depends on it.
- [ ] 2.4 Update `docs/dependencies.md` (the helper section: the `run` form, protocol version 2 with stdin and the batch-file refusal, and the UTF-8 console). Verify: the docs tests pass.

## 3. Windows command resolver

- [ ] 3.1 Move the project-folder and working-directory checks of `linux/resolver.ts` unchanged into `src/main/platform/resolve-cwd.ts`, with the realpath function injectable, and use it from the Linux resolver. Verify: the existing Linux resolver unit and integration tests pass unchanged.
- [ ] 3.2 Add `windows/resolver.ts` (design D2):
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
  - an extensionless `npm` before `npm.cmd`, which is refused (`[spec:project-registry/unsupported-program-type-refused]`);
  - drive-relative and root-relative paths (`[spec:project-registry/drive-relative-program-path-refused]`);
  - refused shells (`[spec:project-registry/other-shell-refused-on-windows]`);
  - the `SystemRoot` fallback.
- [ ] 3.3 Add Windows integration tests (`windows-commands.test.ts`, `[windows-only: cmd.exe and PATHEXT]`), each through the resolver and the real helper:
  - `npm` resolves to an `npm.cmd` on `PATH` and starts (`[spec:project-registry/program-found-through-pathext]`);
  - a decoy `npm.cmd` in the working directory is not run;
  - a shell-mode `cmd.exe` script with `&&` and `%VARIABLE%` runs and prints its result (`[spec:project-registry/cmd-exe-script-runs]`);
  - an App Execution Alias on the runner (if one exists, e.g. `winget.exe`) is found; if none exists, the test says so in its title and is not counted as evidence;
  - a refused input creates no process (checked with `Get-CimInstance`).

  Verify: `npm run test:windows` covers the new file, and the `windows` job reports every test as run.
- [ ] 3.4 Document in `docs/commands.md`, under a "Windows (not yet available)" heading that group 6 lifts:
  - the resolver rules, including the refusal of a first match of another type and of drive-relative paths;
  - the `cmd.exe`-only shell mode and its 8191-character limit;
  - simple and quoted batch arguments, and batch files that read quoted arguments through `%1` themselves;
  - naming `cmd.exe` as a direct-mode program.

  Verify: the docs tests pass.

## 4. Windows environment and editor launch

- [ ] 4.1 Add `windows/environment.ts` (design D3):
  - it starts from `withoutRuntimeVariables(process.env)`;
  - it drops empty names, names starting with `=`, and names containing NUL;
  - it merges names that differ only in case into the case-insensitive lookup's entry;
  - it logs `environment.names-merged` with the names only.

  Verify with unit tests on every system, using a fake inherited environment that holds `Path` and `PATH`, `=C:`, and `ELECTRON_RUN_AS_NODE`, tagged `[spec:project-registry/windows-base-environment]`. The effective environment with an override `PATH` holds exactly one entry.
- [ ] 4.2 Add a Windows integration test showing that a started command sees exactly one path variable, with the expected value, and no `ELECTRON_*` variable. Verify: the `windows` job runs it.
- [ ] 4.3 Implement `launchDetached` in `windows/process-tree.ts` (design D4):
  - `spawn` with `detached`, `windowsHide`, `stdio: 'ignore'` and `windowsVerbatimArguments`, with `commandLine`'s argv[0] stripped, then `unref`;
  - a batch-file `file` without a `commandLine` is refused;
  - a missing program rejects with `SpawnError`.

  Verify with a unit test of the exact `spawn` arguments, and with Windows integration tests:
  - a `.cmd` editor receives a project path with spaces, `&` and `^` as one argument, and no other command runs (`[spec:project-registry/batch-file-editor-on-windows]`);
  - the editor survives the ending of a host process that launched it, inside the runner's job, and the test records whether the editor is in a job;
  - no new `ConsoleWindowClass` window appears for a batch file that starts a GUI-subsystem fixture;
  - a missing editor rejects.

  Verify: the `windows` job runs them all.
- [ ] 4.4 Document in `docs/commands.md`:
  - the Windows environment: inherited, names merged, a restart needed after a `PATH` change, and **Refresh** reads nothing new;
  - the editor launch on Windows, including that a batch-file editor which starts a console program shows that program's console.

  Verify: the docs tests pass.

## 5. Output decoding on Windows

- [ ] 5.1 `ManagedProcess` gains `outputFallbackEncoding` (design D5): on Windows, the WHATWG label of `started.ansiCodePage`, or `null`; on Linux, `null`. Verify: unit tests for the code-page-to-label table, including an unknown code page, and `npm test` passes.
- [ ] 5.2 Give `createLineSplitter` an optional fallback decoder. When it is set:
  - lines are split on `\n` bytes and decoded with a fatal UTF-8 decoder, falling back for each line;
  - the 16 KiB cut drops a trailing incomplete UTF-8 sequence;
  - the partial-line display decodes the same way.

  The supervisor passes `outputFallbackEncoding` to the log service. Verify with unit tests on every system:
  - a mix of UTF-8 and windows-1252 lines (`[spec:process-logs/ansi-output-on-windows]`);
  - a Shift_JIS line, using synthetic bytes;
  - a cut through a multibyte UTF-8 character, and one through a Shift_JIS character, which shows one replacement character;
  - CRLF and partial lines;
  - Linux output unchanged (`[spec:process-logs/invalid-utf-8]` still passes).
- [ ] 5.3 Add Windows integration tests:
  - a `cmd /c echo` of a non-ASCII string reaches the log unchanged (`[spec:process-logs/console-output-on-windows]`);
  - a Node fixture writing windows-1252 bytes is shown decoded.

  Verify: the `windows` job runs them.
- [ ] 5.4 Document Windows output decoding in `docs/logs.md`:
  - the UTF-8 console, and what happens when it cannot be set;
  - the ANSI fallback;
  - OEM bytes written straight to a pipe;
  - a multibyte character cut at 16 KiB;
  - `PYTHONUTF8=1` and `chcp`.

  Verify: the docs tests pass.

## 6. Windows platform composition and the preview

- [ ] 6.1 `createWindowsPlatform({ helperPath, log, inherited })` returns `supported: true`, the D2 `defaultShell`, the resolver, the environment provider and the full process tree, and keeps the unsupported port inspector (design D6). `selectPlatform` passes `inherited`. Verify:
  - `npm run typecheck`;
  - `npm run lint` (only the composition root and `platform/index.ts` read `process.platform`);
  - `npm test`.
- [ ] 6.2 Replace `[spec:process-supervision/start-on-windows]` in `supervisor.test.ts` with a planner test over the Windows platform's resolver and environment, which plans and spawns a command. Tag it `[spec:process-supervision/command-started-on-windows]`, together with a Windows integration test that starts, logs and stops one through the composed platform. Remove the `start-on-windows` todo or tag. Verify: `npm run spec-coverage` reports zero unmapped scenarios.
- [ ] 6.3 Change the smoke test's platform check: it calls `envProvider.base()` everywhere, and `portInspector.list()` unless the inspector rejects with `UnsupportedPlatformError`, in which case the check says so. In the renderer, the shell field's hint on Windows reads "cmd.exe only". Verify: unit tests for both, and `npm run build`.
- [ ] 6.4 Update the README (support statement and platform table) and `docs/processes.md` to "Windows: preview. Run from source; verified in CI on Windows Server 2025. No Windows package yet.". Also:
  - add "Running from source on Windows";
  - lift the "not yet available" headings of groups 3–5;
  - extend the not-verifiable list with localized ANSI code pages, a customized `PATHEXT`, App Execution Aliases beyond the runner, and an Explorer-launched environment;
  - update `docs/deferred-checks.md`;
  - mark the W0 evidence notes that W2 resolves.

  Update the docs tests:
  - re-tag `[spec:process-supervision/windows-limitations-documented]` to require the preview label instead of "not yet reachable from the app";
  - add `[spec:process-supervision/windows-preview-documented]`, which checks that "run from source", "no Windows package" and the not-verifiable list are present, and that no support claim goes beyond them.

  Verify: `npm test`, and `grep -rn "Windows" README.md docs/` shows no claim beyond the preview.

## 7. End-to-end tests on Windows

- [ ] 7.1 Add `test/support/processes.ts` (design D7):
  - `taggedProcesses`, `isAlive`, `killTagged` and `processIdentity`, through `/proc` on Linux and one `Get-CimInstance` call on Windows;
  - it throws on any other system, and on a failed or unparsable query; it never returns an empty list for a failure;
  - a sanity test on both systems requires a started tagged process to be seen;
  - the process reading is removed from `proc.ts`.

  `test-platform-policy.test.ts` allows exactly this file and exactly one dispatch, and asserts that the dispatch throws for an unknown platform. Verify:
  - the Linux e2e suite passes unchanged in the `e2e` job;
  - `test-platform-policy.test.ts` passes, and fails on a temporary platform branch added elsewhere (checked once, then reverted).
- [ ] 7.2 Classify every e2e spec in a table in `docs/ci.md` (design D7) as portable, Linux-only, or Windows-specific, then port them:
  - **Portable specs:** use the portable helper and Node fixtures instead of `sh`, `sleep`, `trap` and `kill`, and read platform values from `AppInfo`.
  - **Linux-only tests:** get `skipIf` guards with `[linux-only: <facility>]` titles (network namespaces, the login shell, port inspection until W3), tagged `[spec:quality-gates/linux-only-end-to-end-test-on-windows]` where checked.
  - **Windows-only specs** (`windows-*.spec.ts`) assert behavior that differs:
    - crash recovery: the trees end, so no survivors are shown;
    - the Ports view's unavailable state;
    - that the started app found the helper (which checks that `app.getAppPath()` is the repository root).
  - **A sandbox test** asserts that the renderer runs sandboxed (`[spec:quality-gates/windows-end-to-end-tests-keep-the-sandbox]`).

  Verify: `npm run test:e2e` passes on Linux, and the table lists every spec file.
- [ ] 7.3 In `ci.yml`'s `windows` job:
  - set `electron: "true"`;
  - add "Windows end-to-end tests" (`npm run test:e2e`) after the integration tests, with `if:` requiring the helper build's success;
  - add an `upload-artifact` step for `test-results/` on failure;
  - raise `timeout-minutes` to 45.

  Extend `workflow-policy.test.ts` for the steps, their conditions, and the absence of `--no-sandbox` and `VEYDR_ALLOW_SKIP_OFFLINE`, and update the check-set test for the modified scenario (`[spec:quality-gates/pull-request-runs-the-full-check-set]`). Document the steps in `docs/ci.md`. Verify on the pull request:
  - the `windows` job runs the e2e step;
  - every Windows e2e test is reported as passed or as skipped with a `[linux-only: …]` reason, and none fails for lack of porting;
  - `ci-ok` passes.

## 8. Integration check

- [ ] 8.1 Run `npm run verify` on Linux, and check the `windows` job and `ci-ok` on the pull request. Verify:
  - all pass;
  - every Windows integration test is reported as run;
  - every Windows e2e skip carries a `[linux-only: …]` reason;
  - spec coverage reports zero unmapped scenarios;
  - `grep -rn "it.todo" test/` shows no `it.todo` tagged with a scenario of this change.
- [ ] 8.2 Check what is claimed and what is unchanged:
  - `grep -rn "Windows" README.md docs/` shows the preview statement, CI notes, the evidence document and the not-verifiable list, and nothing claiming a Windows package or full support;
  - `electron-builder.yml` and `package-lock.json` are unchanged;
  - the Linux e2e and packaging jobs are unchanged in what they run.

  Verify: the checks hold, and they are recorded in the pull request and here.

## Workflow follow-up

- Archive the change once its last pull request is merged.
- W3 `add-windows-port-inspection`: `ports` in the helper (`GetExtendedTcpTable`), lifting "Windows port inspection not yet supported", and the e2e Ports tests on Windows.
- W4: packaging (NSIS), the helper outside `app.asar` with its install directory's permissions checked, the standard-user smoke test, signing (G-6), and the shipped preview statement in place of "run from source".
- Optional CI hardening carried over from W1: fail a Windows test step when vitest reports an unexpected skip.
