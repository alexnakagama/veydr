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

- [ ] 2.1 Add `src/main/platform/windows/protocol.ts`. It parses and encodes the version-1 JSON lines of design D2:
  - helper to Veydr: `ready`, `started`, `members`, `exited`, `stopped`, `error`;
  - Veydr to helper: `stop`, `list`;
  - the token handshake.

  It rejects malformed or unknown lines with a typed error. Add `identity.ts` for the Windows `ProcessIdentity`: the PID plus the creation time as a decimal FILETIME string (design D4). Verify: unit tests cover every message, malformed input, and identity equality.
- [ ] 2.2 Add `src/main/platform/windows/helper-client.ts`. It:
  - creates a random named pipe with `net.createServer`, accepts exactly one connection, and only with the one-time token;
  - passes the pipe name as an argument and the token as one line on the helper's stdin, then closes that stdin, so the token never appears on a command line;
  - spawns the helper with `windowsHide: true`, never `detached`;
  - turns helper messages into a `ManagedProcess` (`onExit`, `onDescendantsChange`, `attributed`, `remaining`, `stop`, with concurrent stops sharing one);
  - treats an early close, a malformed line, or a version mismatch as a helper failure (design D2).

  The pipe path and the spawn function are injectable. Verify: unit tests drive it with a fake helper over a real local socket on Linux and Windows, including the failure cases, and `npm test` passes on both.

## 3. Job containment and forced stop

- [ ] 3.1 Implement the helper's `run` subcommand (design D1, D2). It:
  - creates a Job Object with `KILL_ON_JOB_CLOSE` and no breakaway;
  - starts the command with `CREATE_SUSPENDED | CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT` and `SW_HIDE`, passing exactly its own stdout and stderr and a `NUL` stdin through `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`;
  - assigns the command to the job, then resumes it;
  - reports `started`, `members` (from the job's completion port), and `exited`;
  - stays alive until the job is empty.

  Verify: the helper builds with `/warnaserror+` in the `windows` job.
- [ ] 3.2 Implement the forced part of `stop`: `TerminateJobObject`, then a wait of up to 1 s for the job to empty, then a `stopped` report with the members still alive (design D3, graceful attempt still absent). Add `src/main/platform/windows/process-tree.ts`, whose `spawn` uses the helper client and rejects with `SpawnError` when the helper is missing or does not match the protocol version. Verify: unit tests for the missing and mismatched helper.
- [ ] 3.3 Replace the `it.todo`s in `windows-process-tree.test.ts` with tests built from Node fixture trees (design D7). Each test checks independently with `Get-CimInstance Win32_Process`, starts a sentinel process that must survive, and repeats `VEYDR_STRESS` times. The tests are:
  - `[spec:process-supervision/children-and-grandchildren-stopped-on-windows]`;
  - `[spec:process-supervision/orphaned-descendant-stopped-on-windows]`;
  - `[spec:process-supervision/descendant-started-immediately]`;
  - `[spec:process-supervision/uncooperative-process-on-windows]`.

  Also test that output reaches `stdout` and `stderr` unchanged and that no console window is created (`MainWindowHandle` is 0). Verify: the `windows` job passes on the pull request, with every test reported as run, not skipped.

## 4. Graceful stop

- [ ] 4.1 Implement the graceful part of `stop` in the helper (design D3). It:
  - attaches to the console of the leader, or of the oldest live member;
  - ignores the event in itself, sends `CTRL_BREAK_EVENT` to group 0, and detaches;
  - waits `graceMs`, then falls back to the forced stop of 3.2;
  - reports `graceful: 'yes'` only when the job emptied before the forced step;
  - when `AttachConsole` fails, or no live member shares the command's console, goes straight to the forced stop without waiting `graceMs`, and reports `graceful: 'no'`.

  Verify: the helper builds in the `windows` job.
- [ ] 4.2 Add integration tests:
  - `[spec:process-supervision/cooperative-process-on-windows]`: a Node tree that exits on `SIGBREAK` stops gracefully, and no window appears;
  - `[spec:process-supervision/batch-file-command-stopped-gracefully]`: a `.cmd` file that starts Node stops gracefully, without waiting on the batch prompt;
  - a test that Veydr's own test process and a second running command receive no event;
  - a test that a tree whose processes have all called `FreeConsole` is stopped forced, with `graceful: 'no'`, well before `graceMs` has passed.

  Verify: the `windows` job passes on the pull request.

## 5. Abnormal exit and survivors

- [ ] 5.1 In the helper, terminate the job and exit when the control channel closes before `exited` (design D1). Add the `inspect` and `terminate` subcommands (design D4):
  - `inspect` reads identities on stdin and reports the live, matching ones with their image names;
  - `terminate` re-verifies each survivor and attaches to its console where it has one. It sends Ctrl+Break only if `GetConsoleProcessList` lists nothing but verified survivors; otherwise it detaches without sending. It then waits, re-verifies, and calls `TerminateProcess`.

  Implement `findSurvivors` and `terminateSurvivors` in `process-tree.ts` with them. Verify: unit tests for parsing their output, run through the fake helper.
- [ ] 5.2 Add integration tests:
  - `[spec:process-supervision/veydr-ends-abnormally-on-windows]`: a Node host process owns a running tree through the Windows process tree, records its ledger entry, and is ended with `taskkill /F`. The test checks that no tree process remains and that `findSurvivors` on the recorded entry returns nothing.
  - `[spec:process-supervision/helper-ends-abnormally-on-windows]`: only the helper of a running command is ended with `taskkill /F`. The test checks that the tree ends and that the `ManagedProcess` reports the stop as unverified.
  - `[spec:process-supervision/reused-pid-on-windows]`: an identity with a live PID but a different creation time is neither reported nor ended.
  - a test that `terminateSurvivors` ends a process kept alive outside any Veydr job (a tree started directly by the test) after re-verifying it;
  - a test where a survivor shares its console with a sentinel process that is not a survivor. No Ctrl+Break is sent, the sentinel keeps running, and the survivor is ended by `TerminateProcess`.

  Verify: the `windows` job passes on the pull request.

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
