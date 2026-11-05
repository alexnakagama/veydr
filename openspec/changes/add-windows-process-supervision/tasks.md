# Tasks

Notes:

- Starting a command from the app on Windows stays unsupported throughout (design D6). The README and docs keep "Windows not yet supported".
- Gate G-4 was approved on 2026-11-03 for option C, with the helper built in CI and shipped (design D5). No helper binary is ever committed.
- Every group ends the way foundation design D15 requires:
  1. run its verification commands;
  2. hand off to the `reviewer2` session;
  3. fix the findings, and have them re-reviewed;
  4. record the outcome here.
- These planning artifacts are committed together with group 1, which tags every new scenario so `npm run spec-coverage` stays at zero unmapped (design, first risk).
- Windows behavior counts as verified only from the `windows` CI job on the pull request, never from Linux runs.

## 1. Helper build, CI lane, and scenario mapping

- [x] 1.1 Add `src/main/platform/windows/helper/veydr-helper.cs` with only the `version` subcommand, which prints the protocol version (design D5). Add `scripts/build-windows-helper.mjs`. It:
  - compiles the helper with the .NET Framework 4.8 `csc.exe` (`/nologo /optimize+ /warnaserror+ /target:exe`) into `out-helper/veydr-helper.exe`;
  - stores the source's SHA-256 next to the binary and skips the build when it matches;
  - exits 1 with the compiler output when compilation fails, and exits 1 with "the Windows helper can only be built on Windows" on other systems.

  Add `out-helper/` to `.gitignore`. Add unit tests for the script's paths, the up-to-date check, and the non-Windows message. Verify: `npm test` passes on Linux, and the `windows` job builds the helper.
- [x] 1.2 Add `npm run test:windows` (`vitest run --project integration windows-`). Add `test/integration/windows-process-tree.test.ts`, guarded with `describe.skipIf(process.platform !== 'win32')` and titled `[windows-only: Job Objects]`. For now it holds:
  - a test that runs the built helper's `version`;
  - one tagged `it.todo` for each new `process-supervision` scenario of this change that a later group implements, including `windows-limitations-documented` and `windows-process-trees-verified-natively`, whose tests land in other files in group 6. Group 6 then removes those two todos.

  Verify: on Linux the file is reported as skipped with its reason, `test-platform-policy.test.ts` passes, and `npm run spec-coverage` reports zero unmapped scenarios.
- [x] 1.3 In `.github/workflows/ci.yml`'s `windows` job, add "Build Windows helper" and "Windows integration tests" after the unit tests (design D8). The test step must also require the build step's success. Extend `test/unit/workflow-policy.test.ts` with two tests:
  - `[spec:quality-gates/helper-build-failure-fails-the-windows-check]`: checks the steps and their conditions;
  - `[spec:quality-gates/no-committed-helper-binary]`: fails if `git ls-files` lists a `*.exe`, `*.dll` or `*.pdb` under `src/main/platform/windows/` or `out-helper/`.

  Update the pull-request check-set test for the modified scenario. Verify: `npm test` passes, a temporary committed `.exe` fixture makes the policy test fail (checked once, then reverted), and on the pull request the `windows` job runs both new steps.
- [x] 1.4 Document the helper:
  - in `docs/dependencies.md`, the G-4 decision: what the helper is, that it is built from source with `csc.exe`, never committed, and unsigned until G-6;
  - in `docs/ci.md`, the two new `windows` steps and `npm run test:windows`.

  Verify: `readme-docs.test.ts` and the docs tests pass.

Group 1 outcome (not committed yet): `npm run typecheck`, `npm run lint`, `npm test` (68 files) and `npm run spec-coverage` (zero unmapped) pass on Linux, and the temporary committed `.exe` fixture made the policy test fail before it was removed. The reviewer2 pass found one defect, fixed with a test: the source hash was taken before `csc.exe` read the source, so an edit in between could store a hash that does not match the binary. Not verified on Linux and still to be checked on the pull request: that the C# compiles with `/warnaserror+`, that `windows-process-tree.test.ts` runs (not skipped) and passes, and that the `windows` job runs both new steps.

## 2. Control protocol and TypeScript client

- [x] 2.1 Add `src/main/platform/windows/protocol.ts`. It parses and encodes the version-1 JSON lines of design D2:
  - helper to Veydr: `ready`, `started`, `members`, `exited`, `stopped`, `error`;
  - Veydr to helper: `stop`, `list`;
  - the token handshake.

  It rejects malformed or unknown lines with a typed error. Add `identity.ts` for the Windows `ProcessIdentity`: the PID plus the creation time as a decimal FILETIME string (design D4). Verify: unit tests cover every message, malformed input, and identity equality.
- [x] 2.2 Add `src/main/platform/windows/helper-client.ts`. It:
  - creates a random named pipe with `net.createServer`, accepts exactly one connection, and only with the one-time token;
  - passes the pipe name as an argument and the token as one line on the helper's stdin, then closes that stdin, so the token never appears on a command line;
  - spawns the helper with `windowsHide: true`, never `detached`;
  - turns helper messages into a `ManagedProcess` (`onExit`, `onDescendantsChange`, `attributed`, `remaining`, `stop`, with concurrent stops sharing one);
  - treats an early close, a malformed line, or a version mismatch as a helper failure (design D2).

  The pipe path and the spawn function are injectable. Verify: unit tests drive it with a fake helper over a real local socket on Linux and Windows, including the failure cases, and `npm test` passes on both.

Group 2 outcome (not committed yet): `npm run typecheck`, `npm run lint`, `npm test` (71 files) and `npm run spec-coverage` (zero unmapped) pass on Linux, and the Windows unit tests passed 10 repeated runs.
- During implementation, a defect was fixed: concurrent `attributed()` callers received the latest `members` instead of the answer to their own request.
- The reviewer2 pass found 2 medium, 4 low, and 4 nits. All are fixed with tests, and they were re-reviewed:
  - the stop deadline overflowed `setTimeout` for very large `graceMs`;
  - `list` during a long stop was unspecified; design D2 and task 3.1 now require the helper to answer `list` at any time, and they record the `answer` flag on `members`;
  - idle pipe connections were unbounded in time and could lock out the helper; each now has a 2 s handshake timer, and the oldest of more than 16 is evicted;
  - nothing bounded the channel after the helper exited; a 1 s drain now does;
  - a helper started without pipes leaked;
  - an unreadable image gave a blank name; it is now shown as `PID <n>`.
- The re-review found one low nit: an evicted connection stayed in the pending set until its close event. It is fixed.
- The `windows` CI job then failed two client tests:
  - A real race: a named pipe reports the client connected before the server accepts the connection, so the helper's exit could arrive first and hide its `error` line. Before `started`, the client now waits up to the 1 s drain for the helper's connection, and the test reproduces the order on Linux.
  - A test that expected a refused connection after the handshake: on Windows, the client instead waits for a free pipe instance that never comes. The test now asserts only that nothing connects.
  - reviewer2 re-reviewed both fixes with no findings. A helper that exits before connecting now reports its `SpawnError` after the 1 s drain, which was accepted.

Not verified on Linux, and still to be checked on the pull request: that these unit tests pass on Windows, and the default DACL of the control pipe.

## 3. Job containment and forced stop

- [x] 3.1 Implement the helper's `run` subcommand (design D1, D2). It:
  - creates a Job Object with `KILL_ON_JOB_CLOSE` and no breakaway;
  - starts the command with `CREATE_SUSPENDED | CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT` and `SW_HIDE`, passing exactly its own stdout and stderr and a `NUL` stdin through `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`;
  - assigns the command to the job, then resumes it;
  - reports `started`, `members` (from the job's completion port, with `answer: false`), and `exited`;
  - answers each `list` with exactly one `members` carrying `answer: true`, in order, at any time until it exits, including during a stop (design D2);
  - stays alive until the job is empty.

  Verify: the helper builds with `/warnaserror+` in the `windows` job.
- [x] 3.2 Implement the forced part of `stop`: `TerminateJobObject`, then a wait of up to 1 s for the job to empty, then a `stopped` report with the members still alive (design D3, graceful attempt still absent). Add `src/main/platform/windows/process-tree.ts`, whose `spawn` uses the helper client and rejects with `SpawnError` when the helper is missing or does not match the protocol version. Verify: unit tests for the missing and mismatched helper.
- [x] 3.3 Replace the `it.todo`s in `windows-process-tree.test.ts` with tests built from Node fixture trees (design D7). Each test checks independently with `Get-CimInstance Win32_Process`, starts a sentinel process that must survive, and repeats `VEYDR_STRESS` times. The tests are:
  - `[spec:process-supervision/children-and-grandchildren-stopped-on-windows]`;
  - `[spec:process-supervision/orphaned-descendant-stopped-on-windows]`;
  - `[spec:process-supervision/descendant-started-immediately]`;
  - `[spec:process-supervision/uncooperative-process-on-windows]`.

  Also test that output reaches `stdout` and `stderr` unchanged and that no console window is created (`MainWindowHandle` is 0). Verify: the `windows` job passes on the pull request, with every test reported as run, not skipped.

Group 3 outcome (not committed yet): `npm run typecheck`, `npm run lint`, `npm test` (72 files) and `npm run spec-coverage` (zero unmapped) pass on Linux; `npm run test:windows` is skipped there with its reason.
- Added during implementation, beyond the task text:
  - a batch file runs explicitly through `cmd.exe /d /e:on /v:off /s /c`, with its arguments passed bare or quoted, and `"`, `%`, line breaks, NUL and a trailing backslash refused (implicit `CreateProcess` batch handling allows argument injection);
  - the helper refuses a control pipe not served by its parent process, and connects anonymously;
  - any helper failure, including the control channel closing, ends the job and exits 1 (part of 5.1, whose tests stay in group 5);
  - `spawn` checks for a full program path, an existing program and working directory, and NUL characters, so a missing working directory does not read as a missing helper.
- The reviewer2 pass found 3 medium and 5 low items; 6 were fixed and re-reviewed, and 2 were kept with reasons, which were accepted:
  - batch arguments were too strict for npm-style shims; they are now quoted;
  - the integration tests may count `conhost.exe` as a job member; they now accept console hosts as extra members, judged per answer so a host that comes or goes cannot make them flaky, and the fixture children share the command's console (no `windowsHide`);
  - the sentinel had a console of its own and could not detect a stray event; it now shares the runner's console, and the test asserts this with `GetConsoleProcessList`;
  - `MainWindowHandle` cannot see a console window; the test enumerates visible windows of the tree, its console hosts, and the helper (Windows Terminal hosts are not covered; the CI runner has none);
  - a second abort could exit before the first had reported; it now waits;
  - `spawn` used the platform's `isAbsolute`; it now applies the helper's drive-or-UNC rule, to the helper path too;
  - kept: a helper `error` before `started` is already a `SpawnError` (`other`); a finer reason needs an error code in a later protocol version;
  - kept: a `members` line can still exceed 1 MiB beyond about 20,000 processes, which fails the helper and so ends the job.
- The re-review of the fixes found no further issues.
- Open for group 4: a child that a command's tool starts with `windowsHide` gets a console of its own, so the Ctrl+Break of design D3 does not reach it, and only the forced step ends it.

On the pull request (alexnakagama/veydr#30, merged), every check passed, `ci-ok` included. In the `windows` job, "Build Windows helper" succeeded, so the helper compiles with `/warnaserror+`, and "Windows integration tests" succeeded. The step's vitest summary was not read, because the log needs a GitHub sign-in. So it is not confirmed that every Windows integration test was reported as run rather than skipped (expected: 9 passed, 7 todo), and the run does not show whether `conhost.exe` joined the job. Check this on the next `windows` run.

## 4. Graceful stop

- [x] 4.1 Implement the graceful part of `stop` in the helper (design D3). It:
  - attaches to the console of the leader, or of the oldest live member;
  - ignores the event in itself, sends `CTRL_BREAK_EVENT` to group 0, and detaches;
  - waits `graceMs`, then falls back to the forced stop of 3.2;
  - reports `graceful: 'yes'` only when the job emptied before the forced step;
  - when `AttachConsole` fails, or no live member shares the command's console, goes straight to the forced stop without waiting `graceMs`, and reports `graceful: 'no'`.

  Verify: the helper builds in the `windows` job.
- [x] 4.2 Add integration tests:
  - `[spec:process-supervision/cooperative-process-on-windows]`: a Node tree that exits on `SIGBREAK` stops gracefully, and no window appears;
  - `[spec:process-supervision/batch-file-command-stopped-gracefully]`: a `.cmd` file that starts Node stops gracefully, without waiting on the batch prompt;
  - a test that Veydr's own test process and a second running command receive no event;
  - a test that a tree whose processes have all called `FreeConsole` is stopped forced, with `graceful: 'no'`, well before `graceMs` has passed.

  Verify: the `windows` job passes on the pull request.

Group 4 outcome (not committed yet): `npm run typecheck`, `npm run lint`, `npm test` (72 files) and `npm run spec-coverage` (149 scenarios, zero unmapped) pass on Linux; `npm run test:windows` is skipped there with its reason.
- Added during implementation, beyond the task text:
  - Ctrl+Break is sent only to a console whose processes, apart from the helper, are all members of the job, and at least one is; a process that cannot be opened counts as foreign. This keeps Veydr, other commands, and any process that attached itself to the command's console from receiving the event.
  - The candidates are the live members oldest first (the leader while it lives), skipping a member that has no console or whose console is unfit, with consoles told apart by their window. One event is sent, to the first fit console. At most 64 members are tried, and failed attaches count too: a job with more than 64 members without a console listed before the one with it is stopped forced only, which is safe.
  - `SetConsoleCtrlHandler(NULL, TRUE)` covers only Ctrl+C, so the helper also registers a handler that swallows Ctrl+C and Ctrl+Break, for its whole life. It frees its own console first and never takes it back.
  - The FreeConsole test uses a PowerShell fixture (`test/fixtures/windows/free-console.ps1`), since Node cannot call `FreeConsole`.
- The reviewer2 pass found no high or medium items and 4 low ones, all addressed:
  - the "no window during the stop" check ran before the helper had the `stop`; it now samples until the stop settles, at least twice;
  - the `SIGBREAK` listener is meaningful only on a main thread; the test now asserts that it runs on one;
  - the batch test depends on cmd.exe's prompt reading end-of-file; a comment says to check that first if it fails on CI;
  - the 64-attempt limit counting failed attaches is recorded above.
  - Also, as suggested, `WaitForEmptyJob` sleeps briefly if `jobEmpty` is set while the job is not empty, so it cannot spin.
- The re-review of the fixes found no further issues.
- Noted, not changed: `exited` reports `forced: false` when the leader exits during the grace window, even if the forced step then ends the rest; `stopped.forced` carries that (unchanged since group 3).
- Still open: a child that a tool starts with `windowsHide` has a console of its own and gets only the forced step.
- The first Windows run (2026-11-05, before commit) failed 7 tests: the helper was ended by its own Ctrl+Break (exit code 0xC000013A), so its job closed. Attaching to a console resets the process's control handling to the default one, and the helper also detached before its own copy of the event arrived; W0's probe did neither. The helper now registers its handler again after every attach and detach, stays attached until it has handled its copy (at most 1 s), and counts that time against `graceMs`. The cooperative test also left a failed stop unhandled while it sampled windows; the stop is now handled from the start.
- reviewer2 reviewed the fix with no high or medium findings. One low item: re-registering removed the handler before adding it, leaving a moment without one. Its suggested order (add, then remove) would delete the only registration whenever attaching had reset the list, so the helper now only adds. A duplicate is harmless, because the first handler that returns TRUE ends the chain.

- The Windows rerun after the fix (2026-11-05, maintainer's machine, helper rebuilt) passed every test of `npm run test:windows`.

On the pull request (alexnakagama/veydr#32, at 2663917), every check passed, `ci-ok` and `windows` included. "Build Windows helper" succeeded, so the helper compiles with `/warnaserror+`. The `windows` job's vitest summary for `windows-process-tree.test.ts` reads 13 passed and 5 todo, none skipped; all four group 4 tests ran and passed. The log was read with `gh run view --log`, which also settles group 3's open check (9 passed, 7 todo then). Stop durations are not logged on their own, but the batch-file test took 6.4 s for 5 repetitions, each with a start, several PowerShell process listings and a stop, which leaves no room for a 1 s wait per stop: the helper receives its own event. Still unverified: a Windows Terminal (ConPTY) default console, which the runner does not have.

## 5. Abnormal exit and survivors

- [x] 5.1 In the helper, terminate the job and exit when the control channel closes before `exited` (design D1). Add the `inspect` and `terminate` subcommands (design D4):
  - `inspect` reads identities on stdin and reports the live, matching ones with their image names;
  - `terminate` re-verifies each survivor and attaches to its console where it has one. It sends Ctrl+Break only if `GetConsoleProcessList` lists nothing but verified survivors; otherwise it detaches without sending. It then waits, re-verifies, and calls `TerminateProcess`.

  Implement `findSurvivors` and `terminateSurvivors` in `process-tree.ts` with them. Verify: unit tests for parsing their output, run through the fake helper.
- [x] 5.2 Add integration tests:
  - `[spec:process-supervision/veydr-ends-abnormally-on-windows]`: a Node host process owns a running tree through the Windows process tree, records its ledger entry, and is ended with `taskkill /F`. The test checks that no tree process remains and that `findSurvivors` on the recorded entry returns nothing.
  - `[spec:process-supervision/helper-ends-abnormally-on-windows]`: only the helper of a running command is ended with `taskkill /F`. The test checks that the tree ends and that the `ManagedProcess` reports the stop as unverified.
  - `[spec:process-supervision/reused-pid-on-windows]`: an identity with a live PID but a different creation time is neither reported nor ended.
  - a test that `terminateSurvivors` ends a process kept alive outside any Veydr job (a tree started directly by the test) after re-verifying it;
  - a test where a survivor shares its console with a sentinel process that is not a survivor. No Ctrl+Break is sent, the sentinel keeps running, and the survivor is ended by `TerminateProcess`.

  Verify: the `windows` job passes on the pull request.

Group 5 outcome (not committed yet): `npm run typecheck`, `npm run lint`, `npm test` (72 files, 1064 tests) and `npm run spec-coverage` (149 scenarios, zero unmapped) pass on Linux; `npm run test:windows` is skipped there with its reason.
- The control-channel close of 5.1 was already implemented in group 3 (it ends the job and exits 1); it is unchanged, and the two abnormal-exit tests now cover it.
- `inspect` and `terminate` read one ASCII line on stdin, a JSON array of `{"pid","created"}` in exactly the form `encodeIdentities` writes (at most 65,536, at most 4 MiB, parsed strictly), and print one JSON line (`inspected`, `terminated`). Exit codes are 0, 1 (failure, on stderr) and 2 (usage).
- Added during implementation, beyond the task text:
  - `terminate` holds a handle to each verified survivor from the first check to the end, so its PID cannot be reused; Ctrl+Break, `TerminateProcess` and the final check all act on that process. A survivor it may only query is reported, not ended.
  - It sends no event once `graceMs` has passed, and waits only for the survivors that received one; when none did, it ends them at once.
  - The console-event code moved from `run` into a shared `CtrlEvents` class, unchanged in behavior (confirmed by reviewer2 against group 4's code).
  - On the TypeScript side, a helper answer that names a process it was not asked about fails the call; output is capped at 8 MiB, must be valid UTF-8, and each call has a time limit after which the helper is killed. More than 65,536 identities take several calls.
  - The Veydr-ends-abnormally test runs a bundled host (`test/integration/support/windows-tree-host.ts`) that owns the run through the real process tree and runtime ledger.
- The reviewer2 pass found no high items, 3 medium, 6 low, and 5 nits. All were addressed and re-reviewed with no further findings:
  - the `terminate` time limit was capped at 2^31−1 ms, which could kill the helper during a grace period near the maximum; long delays now chain timers;
  - the Windows tests started one PowerShell per creation time; they now read a tree's identities in one call;
  - several `terminate` calls each got the full grace period and validated answers against all calls; the grace now counts from the first call, and each answer is checked against its own call;
  - `forced` was reported when no `TerminateProcess` was called (a survivor the helper may not end); it is now set only when one was, and `graceful` is tracked on its own;
  - `inspectTimeoutMs` and `stopMarginMs` are now validated;
  - kept, with reasons accepted: a failed `inspect` or `terminate` only rejects, since the recovery and quit callers already log it, keep the runs, and check again;
  - comments now record the ASCII-only stdin (a byte order mark is refused) and the time bound of `terminate`; the host test closes its line reader and refuses a missing stdout.
- Also noted, not changed: processes that survivors start after Veydr's end are not ended by `terminateSurvivors`, since no job of Veydr holds them (design D4 ends only the recorded survivors).

On the pull request (alexnakagama/veydr#33):
- The first `windows` run (at 753688b) built the helper, so the new C# compiles with `/warnaserror+`. It failed one test: the Veydr-ends-abnormally test compared processes before the fixtures had written their ready files, and counted the host, whose command line carries the scenario marker in its options.
- Fixed in the test at 19944fe: it now waits for the ready files and for the whole tree in the ledger on disk, and leaves the host out of the comparison. A console host can join the job and count as one of the two descendants the host waits for, so its `ready` alone does not mean both children are recorded. This fix changes only the test and was not re-reviewed by reviewer2.
- At 19944fe every check passed, `ci-ok` and `windows` included. "Build Windows helper" succeeded, and the `windows` job's vitest summary for `windows-process-tree.test.ts` reads 20 passed and 2 todo, none skipped (read with `gh run view --log`). All seven group 5 tests ran and passed, including the bundled host. The remaining todos belong to group 6.

## 6. Platform composition and documentation

- [ ] 6.1 Change `createWindowsPlatform(options)` to take `helperPath` and `log`, and to return the real `processTree` (with `launchDetached` still unsupported) together with `supported: false` and the unsupported resolver, environment, and port inspector (design D6). The composition root and `selectPlatform` pass `<app path>/out-helper/veydr-helper.exe`. Verify: `npm run typecheck`, `npm run lint` (only the composition root and `platform/index.ts` read `process.platform`), and `npm test` pass.
- [ ] 6.2 Rewrite `supervisor.test.ts` › `[spec:process-supervision/start-on-windows]` to use the Windows platform's resolver and a spy process tree, and to assert that the start fails with `UnsupportedPlatformError` and that `spawn` was never called. Tag the CI test that runs the Windows integration step with `[spec:process-supervision/windows-process-trees-verified-natively]`. Verify: `npm test` passes on Linux and Windows.
- [ ] 6.3 Add a "Windows (not yet available)" section to `docs/processes.md`. It covers:
  - Job Object containment, the Ctrl+Break graceful stop, and the forced stop;
  - an abnormal exit that ends the tree, and survivors only as a fallback;
  - the image path shown instead of the command line, and one helper process per command;
  - what the runner could not verify: a desktop session, logoff and shutdown, a parent outside any Job Object, and a CI job that runs as administrator only.

  Extend the existing documentation test with `[spec:process-supervision/windows-limitations-documented]`, and make sure `[spec:process-supervision/limitation-documented]` still passes. In `docs/deferred-checks.md`, add a "Windows process supervision" row: implemented and verified in CI, not reachable from the app until W2, with the unsigned-helper and antivirus risk. Verify: `npm test` passes.

## 7. Integration check

- [ ] 7.1 Run `npm run verify` on Linux, and check the `windows` CI job and `ci-ok` on the pull request. Verify: all pass, the `windows` job reports every Windows integration test as run (none skipped), and spec coverage reports zero unmapped scenarios.
- [ ] 7.2 Check that nothing claims Windows support: `grep -rn "Windows" README.md docs/` shows only "not yet supported" statements, CI notes, the evidence document, and the "not yet available" section of `docs/processes.md`. Also check that `start-on-windows` passes and that `electron-builder.yml` and `package-lock.json` are unchanged. Verify: the checks hold, and are recorded in the pull request.

## Workflow follow-up

- Archive the change once its pull request is merged.
- Start W2 `add-windows-environment-and-commands`: the resolver, the environment, `launchDetached`, and lifting "Windows supervision not yet supported" (making Windows `supported`). W3 `add-windows-port-inspection` adds `ports` to the same helper.
