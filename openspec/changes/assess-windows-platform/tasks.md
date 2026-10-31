# Tasks

Notes:

- No product code changes in this change. The README and docs keep "Windows not yet supported" throughout.
- Every group ends the way foundation design D15 requires:
  1. run its verification commands;
  2. hand off to the `reviewer2` session;
  3. fix the findings, and have them re-reviewed;
  4. record the outcome here.
- Probe groups (3–7) are verified by a `windows-probe.yml` run on the change's branch (`--ref`), which is possible only after groups 1–2 are merged to `master` (design D1).
- Every probe driver runs without a console, and the privilege-dependent ones also run as a standard user (design D9). A result recorded from the wrong context is a bug in the probe, not evidence.
- Every `.ps1` probe script runs under Windows PowerShell 5.1 (`powershell.exe -NoProfile -ExecutionPolicy Bypass -File …`), never under PowerShell 7 (design D2).

## 1. Shared probe infrastructure

- [x] 1.1 Add the data the check IDs are generated from:
  - `scripts/windows-probe/cmd-corpus.mjs`: the injection corpus of design D3 as data. Each case has an ID, its intended argument, and a description.
  - `scripts/windows-probe/cmd-quote.mjs`: the candidate quoting algorithm of design D3 (`CommandLineToArgvW` quoting per argument, metacharacters escaped by `^` for both cmd.exe parses, wrapped for `cmd.exe /d /v:off /s /c`, and refusing what cmd.exe cannot carry).
  - The list of the smoke test's check names, taken from `src/main/app/smoke.ts`.

  Add `test/unit/windows-probe-corpus.test.ts`. It checks that every corpus case has a unique ID and a non-empty description, and that `cmd-quote.mjs` produces the expected command lines for representative cases. It also checks that the smoke-check list equals the names `smoke.ts` can report, so it fails when a smoke check is added or renamed. Add `scripts/windows-probe/*.mjs` to the ESLint default-project list. Verify: `npm test`, `npm run lint`, and `npm run typecheck` pass.
- [x] 1.2 Add `scripts/windows-probe/checks.mjs` with every check ID from design D3, including:
  - the context checks (`ctx-no-console`, `ctx-standard-user`, `ctx-electron-no-console`, `ctx-job`);
  - `helper-csc-build`;
  - the `-std` variants;
  - the IDs generated from the corpus, the encoding tools and variants, and the smoke-check list.

  Each entry records its yes/no question, its **predicted answer** (`yes` or `no`; there is no "unknown") with a one-line reason for the prediction, its area, what it feeds, its required context (`console: none`; `admin`, `standard`, or both), and the control it depends on. The runner's limits from design D3 (`env-desktop-launch`, `pt-logoff`, `ux-uac-prompt`, `l10n-console`, `av-third-party`, `smartscreen`) are entries of kind `limit`, with a fixed reason, a description of what would verify them, and no prediction. Add an empty `REVISIONS` list for later prediction changes. Also generate the snapshot `test/windows-probe/predictions.json` from `checks.mjs` (design D3); it is never edited afterwards. Add a check to `test/unit/windows-probe-summary.test.ts`: every prediction in `checks.mjs` equals the snapshot, unless `REVISIONS` lists the change, and every check missing from the snapshot has a `REVISIONS` entry marking it as added later. The same test also checks that every entry other than a limit has a question ending in `?`, a prediction of `yes` or `no`, and a non-empty reason; that every limit has a reason and no prediction; and that the snapshot holds no limits. Verify: `npm test` and `npm run typecheck` pass, and changing one prediction without a `REVISIONS` entry makes the test fail (checked once, then reverted). This task lands on `master` with group 2, before any probe runs, so the predictions are fixed before the evidence exists (design D3).
- [x] 1.3 Add `scripts/windows-probe/summary.mjs` with a `.d.mts` declaration (design D4). It:
  - parses probe JSON lines (`id`, `answer`, `detail`, `data.context`);
  - derives each status from the answer and the check's prediction: `yes` → `PASS`, `no` → `EXPECTED-FAIL` if predicted, otherwise `FAIL`, and `null` → `NOT-TESTABLE`;
  - rejects unknown IDs, answers other than `yes`/`no`/`null`, a `no` or `null` without a reason, and a context that differs from the check's required context;
  - marks an area invalid when its control failed;
  - turns every check depending on a failed or missing context control into `NOT-TESTABLE`, naming the control;
  - writes a `NOT-TESTABLE` line with the fixed reason for every limit, and rejects a probe line that answers a limit;
  - treats a check that no probe answered as `NOT-TESTABLE` ("no result: probe did not report it"), so a crashed or skipped probe shows up as missing evidence and is not silently omitted;
  - reads each job's identity line (`ImageOS`, `ImageVersion`, Windows build, Node version, negative-control flag) and never uses the summary job's own environment for it;
  - lists every distinct Windows image version with the areas measured on it;
  - prints a check with a `REVISIONS` entry as revised;
  - formats `summary.txt` with its header: commit SHA, run ID, the Windows image version and build, Node version, the hash of `checks.mjs`, the negative-control flag, and the date.

  Add `test/unit/windows-probe-summary.test.ts` covering:
  - parsing, status derivation for every prediction, and each rejection;
  - the context mismatch and both control rules;
  - identity lines with one and with several image versions;
  - a revised prediction;
  - sorting and the header.

  Verify: `npm test` passes.

Group 1 review (`reviewer2`, 2026-10-27): two rounds. The first round's 12 findings were all fixed: split `pt-parent-exit` and `pt-ctrl-break-attach`, multi-argument corpus, `/v:off` and line limits, refusal semantics on the verbatim route, question hashes and `removed` revisions in the snapshot, BOM/UTF-16 handling, and CLI tests. The second round had 3 findings, also fixed: `env-registry-std` now rests on `CreateProcessWithLogonW` (design D9), the batch line keeps `SHIM_LINE_RESERVE` free (`near-limit` case), and `PACKAGED_ONLY_SMOKE_CHECKS` is tied to `smoke.ts` by a test. The third round confirmed all three and added two notes for group 3, both now in D9: console-less start through the launcher, and the `seclogon` service and non-interactive window station. Nothing blocking remained. Verified: `npm test`, `npm run lint`, `npm run typecheck`.

## 2. Probe workflow and CI setup

- [x] 2.1 In `.github/actions/setup/action.yml`, add `runner.os == 'Linux'` to the `if:` of "Install Xvfb", "Enable unprivileged user namespaces", and "Disable core dumps" (design D8). Update the exact-condition assertions in `test/unit/workflow-policy.test.ts`. Extend `launchesElectron` there to also match a direct `--smoke-test` launch and `scripts/ensure-electron.cjs`, with a test case for each. Verify: `npm test` passes, and the Linux jobs of `ci.yml` stay green on the pull request.
- [x] 2.2 Add `test/windows-probe/results/*.jsonl -binary text eol=lf diff merge` to `.gitattributes`, after the `*.jsonl binary` line (design D4). `binary` is a macro for `-diff -merge -text`, so `text eol=lf` alone would leave `binary` set; the line unsets it and sets `diff` and `merge` back. Verify: `git check-attr text binary -- test/windows-probe/results/x.jsonl` reports text and not binary, and `git check-attr binary -- test/fixtures/x.jsonl` still reports binary.
- [x] 2.3 Add `.github/workflows/windows-probe.yml` (design D1):
  - triggered by `workflow_dispatch` only, with one boolean input, `negative-control` (default `false`, design D9), and `permissions: {}` at the top level;
  - one job per probe area on `windows-2025`, each with `contents: read`, a timeout, pinned checkout with `persist-credentials: false`, an identity line as the first line of its results (design D4), and an upload of its result lines that runs even when the probe fails;
  - a `summary` job on `ubuntu-24.04`, which runs whatever happened to the probe jobs, merges their results with `summary.mjs`, and uploads `summary.txt`.

  At this stage each probe job runs a placeholder that reports its checks as `NOT-TESTABLE` ("probe not implemented yet"). Extend `workflow-policy.test.ts`: the workflow has only the manual trigger and no write permission, it is not in `ci-ok`'s needs, it never commits or pushes, and Electron-launching jobs run setup with `electron: "true"`. Verify: `npm test` passes, and the pinned actionlint reports no errors.
- [x] 2.4 Document the probe workflow in `docs/ci.md`:
  - a pipeline table row and its purpose;
  - how to start it (`gh workflow run windows-probe.yml --ref <branch>`), and the `negative-control` input, whose runs are never committed;
  - that it is never required;
  - that some jobs create and remove a temporary local standard user;
  - how its artifact becomes committed evidence.

  Also add `windows-probe.yml` to the "Used in" column of the pinned-actions table for `actions/checkout`, `actions/upload-artifact`, and `actions/download-artifact`; no test checks that table. Verify: `npm test` passes, including the docs tests, and the table names every workflow that uses each action (checked with `grep -l` over `.github/workflows`).
- [x] 2.5 Merge groups 1–2 to `master`. Then start the workflow on the change's branch. Verify: the run completes, and its `summary.txt` artifact lists every check ID with a valid line.

Group 2 review (`reviewer2`, 2026-10-29): two rounds. The first round found nothing blocking and raised 3 low findings, all fixed: the `docs/ci.md` standard-user bullet is marked as planned (tasks 3.2–6.2); `summary.mjs` reports a missing results directory as "no .jsonl results" instead of failing on ENOENT; and the policy test asserts every `windows-probe.yml` job's setup inputs (`electron: "true"` for `electron` and `nsis`, `dependencies: "false"` for the others). The second round confirmed all three, with no further findings. Notes: 2.2 uses `-binary text eol=lf diff merge`, because `binary` is a macro and `text` alone leaves it set (design D4 updated). The probe jobs start their results with `scripts/windows-probe/identity.mjs` and, until each area's probe exists, run `scripts/windows-probe/placeholder.mjs`. Verified: `npm test`, `npm run lint`, `npm run typecheck`, `npm run spec-coverage`, and the pinned actionlint. Groups 1–2 were merged to `master` in #12 (`e346b04`), with every `ci.yml` job passing (2.1). Task 2.5's run was [Windows probe run 40946307627](https://github.com/alexnakagama/veydr/actions/runs/40946307627), on 2026-10-29. It was started on branch `docs/fix` at `a7ff1e9`, the merged code; the probe scripts are unchanged since. All nine jobs succeeded. The `summary.txt` header names commit `a7ff1e9`, `negative-control false`, one image (`win25-vs2026` 20261021.278.1, build 10.0.26100.33650, Node v24.22.1) for all eight areas, and the `checks.mjs` hash of the current file. The summary has exactly one line per ID in `checks.mjs` (136), all `NOT-TESTABLE`, and no "no result" line. Its 130 check lines carry "probe not implemented yet", and the 6 limits carry their fixed reasons. Rerunning `summary.mjs` locally on the downloaded results reproduces the summary byte for byte, apart from the date line. These are placeholder results, so they are not committed as evidence.

## 3. Execution contexts

- [x] 3.1 Add `scripts/windows-probe/launch-detached.mjs` (design D9). It starts a probe driver with `detached: true` and `windowsHide: true`, sends the driver's result lines to a file, waits for the driver to exit within a timeout, and reports a driver that did not finish as a failed run. Add `scripts/windows-probe/context.ps1`, which provides `GetConsoleWindow`, `AttachConsole(ATTACH_PARENT_PROCESS)`, and the token's elevation and Administrators membership. `context.ps1` also provides the driver's Job Object membership (`IsProcessInJob` with no job handle) and, where readable, the job's limits. Make `ctx-no-console` and `ctx-job` the first checks of every driver started through the launcher. Verify:
  - a normal probe run reports `ctx-no-console` `PASS` and `ctx-job` with the membership in `data`;
  - a separate run with `negative-control: true` starts one driver on the job shell's console, as if straight from the shell (design D9: the launcher starts the `process-tree` administrator driver attached). It reports `ctx-no-console` `FAIL`, the summary turns that area's checks into `NOT-TESTABLE` naming the control, and its header marks it as a negative-control run. That run is not committed.
- [x] 3.2 Add `scripts/windows-probe/standard-user.ps1`. It:
  - creates the local account `veydr-probe` outside Administrators (`New-LocalUser`). Its password:
    - is 32 characters from a cryptographic random generator, with at least one upper-case letter, lower-case letter, digit, and symbol, as Windows Server's default complexity rules require (design D9);
    - is masked with `::add-mask::` before any other step uses it.

    A creation failure is reported with Windows' error message, which never contains the password;
  - copies the probe files to `C:\veydr-probe-std`, with access granted to that account only among non-administrators (Administrators and SYSTEM keep access, design D9), and checks that the Node runtime's directory is readable to it;
  - runs `Start-Service seclogon`, then runs a given driver as that user through the console-less launcher, started with an absolute `node.exe` path by `CreateProcessWithLogonW` (P/Invoke, `LOGON_WITH_PROFILE`, `CREATE_NO_WINDOW`, null environment block and desktop; design D9), so the user's registry hive (`HKCU`) exists and the environment is built from the user's profile. A failure of either step is reported in `ctx-standard-user`'s detail;
  - collects the result file;
  - removes the account in a `finally` block.

  `ctx-standard-user` runs first in such a driver. It confirms the token is unelevated and outside Administrators, that `HKCU\Environment` is readable, and that the probe directory is usable. If the account cannot be created or used, every `-std` check is `NOT-TESTABLE` with the error. Extend `workflow-policy.test.ts` so the password never appears in a workflow file, an `echo`, or an uploaded path. Verify: a probe run reports `ctx-standard-user` `PASS`, the job log shows the password only masked, and the account no longer exists at the end of the job (checked by a final step). Generate 1,000 passwords once and check that each satisfies the complexity rule; record that check in the task's review notes.

Group 3 review (`reviewer2`, 2026-10-29): two rounds, both by reading, then Windows runs on `group3/tasks`. Both tasks are verified; the runs are below. The first round found no blockers and raised 12 findings, all fixed:
- `ctx-standard-user` checks that the user's hive is loaded (`HKCU\Software`), and records `HKCU\Environment` only as data, since a new profile may lack it.
- `standard-user.ps1 -Cleanup` replaces `-CheckRemoved`. The job's last step before the upload removes an account a killed step left, and fails. The script's waits fit within its step's timeout. It removes the profile and `C:\veydr-probe-std` too.
- The P/Invoke helper compiles inside the error handling, so a compile error gives the `--unavailable` fallback.
- The standard-user step runs with `!cancelled()`.
- Smaller fixes: an exit-code hint for 0xC0000142; the standard user's log is echoed with a prefix, so it cannot issue workflow commands; `context.ps1` runs fit the launcher's timeout; the context checks are ordered `ctx-no-console`, `ctx-job`, `ctx-standard-user`; a driver that writes no result line fails its run; the entry-point check ignores case on Windows; `docs/ci.md` explains `data.context`; and the script header covers a mid-run launcher failure.

The three deviations were settled in design D9 and in tasks 3.1–3.2:
- The negative control starts its driver attached, from the launcher, because the workflow policy allows no conditional probe step.
- Administrators and SYSTEM keep access to the probe directory.
- The `ctx-standard-user` reason in `checks.mjs` names `LOGON_WITH_PROFILE`; its prediction and question are unchanged.

The second round confirmed all of them and left four nits. Two are fixed: the unavailable path stops the launcher's whole tree on timeout, and the header says `-Cleanup` deletes the directory whoever created it. One is accepted: `-Cleanup` leaves the directory if the account cannot be removed, and fails. The fourth is to be checked on the first Windows run: that `[VeydrProbeLogon]::Run` resolves after `Initialize-Logon`.

Verified on Linux: `npm test`, `npm run lint`, `npm run typecheck`, `npm run spec-coverage`, and the pinned actionlint. Verified on the runner, all on image `win25-vs2026` 20261021.278.1 (build 10.0.26100.33650, Node v24.22.1), with no "no result" line:
- [Windows probe run 40969180838](https://github.com/alexnakagama/veydr/actions/runs/40969180838) (`7a82c5c`) and [run 40971167924](https://github.com/alexnakagama/veydr/actions/runs/40971167924) (`ee5f1cd`), both normal runs. `ctx-no-console` is `PASS` for all 12 drivers (8 as administrator, 4 as the standard user). `ctx-job` is `EXPECTED-FAIL` for all of them, with `inJob: true` in `data`. `ctx-standard-user` is `PASS` in all four areas: unelevated, Administrators absent, hive loaded (`HKCU\Environment` present, 3 values), probe directory usable. So `CreateProcessWithLogonW` worked without a desktop, and a fresh profile has `HKCU\Software`.
- [Run 40969529732](https://github.com/alexnakagama/veydr/actions/runs/40969529732) (`7a82c5c`), with `negative-control: true`. `ctx-no-console` is `FAIL` for `process-tree/admin` only: the job shell has a console without a window (`AttachConsole` succeeded, window `0x0`). That area's checks are `NOT-TESTABLE` naming the control, and the header says `negative-control true`. Not committed.

Finding: the job's limits cannot be read on this runner. Windows PowerShell 5.1 started detached (without a console) does not run `context.ps1` at all: it exits with 0 having written nothing (`contextHelperDetachedError`, run 40971167924). Every measurement comes from the attached fallback, which is inside libuv's job. Task 3.1 asks for the limits only where readable; a compiled helper (task 4.4) could read them, and `pt-libuv-breakaway` records job limits in group 4.

Verified for 3.2, as reported by the maintainer on 2026-10-29: every job of run 40971167924 succeeded, including the four steps that remove the standard user (`-Cleanup` fails if the account is left). In that run's "Probe as a standard user" logs, a search finds neither `add-mask` nor `***`, and no password shows in clear. The check of 1,000 passwords passed in the `windows` CI job at `dba4e20`. It runs `standard-user.ps1 -CheckPasswords 1000` as a Windows-only unit test in `windows-probe-jobs.test.ts`, so it runs again on every pull request.

## 4. Process-tree probes

- [x] 4.1 Implement `scripts/windows-probe/process-tree.ps1`: C# P/Invoke for Job Objects, `IsProcessInJob`, `GetProcessTimes`, and an attaching control-event helper (`FreeConsole`, `AttachConsole(childPid)`, `GenerateConsoleCtrlEvent`). Implement `scripts/windows-probe/process-tree.mjs`, started through the console-less launcher. It builds process trees with `child_process.spawn` (leader → child → grandchild, plus an orphaned grandchild) and runs:
  - `pt-libuv-job`, `pt-libuv-breakaway`, `pt-kill-leader`, `pt-taskkill-tree`, `pt-taskkill-orphan`, `pt-job-terminate`, and `pt-identity`;
  - `pt-parent-exit-leader` and `pt-parent-exit-descendant`: a separate parent process spawns a tree; the parent is then killed with `TerminateProcess`, as a crash would end it, and the probe records which descendants are still running;
  - `pt-identity-reuse`: spawn and end short-lived processes until a PID recurs or the bound (1,000 processes or 60 s) is reached; `NOT-TESTABLE` if none recurs;
  - a control check: a single plain child, which every stop method must end.

  Verify: a probe run reports every one of these IDs, the controls pass, and each result line's `data` names the PIDs and creation times involved. Each answer is `yes`/`no` as the question in design D3 is phrased.
- [x] 4.2 Add `pt-job-race`: is a grandchild created between spawn and job assignment still contained by the job? Also record in `data` whether an assigned-while-suspended start, done from the PowerShell helper, closes that gap. Verify: the run reports the ID with both variants in `data`.
- [ ] 4.3 Add the graceful-stop and console checks:
  - `pt-ctrl-break-direct`, and `pt-ctrl-break-attach-node`, `-npm`, and `-cmd` for `node`, `npm run`, and `cmd /c` children, started with `windowsHide: true` and not `detached`, as W1 would start them. The helper calls `SetConsoleCtrlHandler(NULL, TRUE)` before attaching. The attach check also verifies that the probe driver and the helper received no event and kept running;
  - `pt-ctrl-break-detached`: the same helper against a child started with `detached: true`;
  - `pt-ctrl-c`;
  - `pt-console-window`, with and without `windowsHide`. It is `NOT-TESTABLE` with the reason if the session has no desktop.

  Run `pt-job-terminate-std` and the `pt-ctrl-break-attach-<child>-std` checks through the standard-user runner. Verify: a probe run reports every one of these IDs with its context in `data`, and the driver survived the attach checks.
- [x] 4.4 Implement `helper-csc-build` (design D2). It compiles `scripts/windows-probe/job-helper.cs` with `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe` into the job's temporary directory; the binary is never committed. It then starts the helper from the console-less launcher. The helper creates a Job Object, starts a child with a grandchild inside it, and terminates the job; the probe checks that both are gone. Run `helper-csc-build-std` through the standard-user runner. Verify: a probe run reports both IDs, and `data` records the compiler version and the helper's exit code.

Group 4 review (`reviewer2`, 2026-10-31): two rounds, by reading only; no Windows run yet. The first round found no blocker in the C# or PowerShell and raised 5 medium findings on what the checks prove, plus notes, all handled. The second round accepted the three deviations (the helper's event count does not fail an answer, the breakaway control's null rule, and `data.nonOrphansEnded`) and raised one finding and one nit, both fixed: a process unreadable at the final read makes an attach check `null`, and driver events are counted per send. Verified on Linux: `npm test`, `npm run lint`, `npm run typecheck`, `npm run spec-coverage`. Not run: the pinned actionlint.

[Windows probe run 41171471857](https://github.com/alexnakagama/veydr/actions/runs/41171471857) (`8235436`): every ID is reported, `pt-control` and `pt-control-std` pass, and the context controls pass. 4.2 and 4.4 are verified by it: `pt-job-race` has both variants in `data` (a suspended start closes the gap), and `helper-csc-build` and `-std` are `PASS` with compiler 4.8.9221.0 and helper exit code 0. Its jobs ran on two image versions, so it is not evidence. 4.1 and 4.3 stay open for these results, fixed since and awaiting another run:
- `pt-libuv-job` was a `FAIL` from a wrong assumption in the probe, not an answer to its question. libuv adds the spawning process to its own job, so the driver is in the list. The job's limits (`0x3c00`) identify it, and the answer now rests on those. The prediction is unchanged.
- `pt-ctrl-break-attach-node`, `-cmd` and their `-std` variants lost the console helper with exit code 0xC000013A. The cause is not known. The helper now registers its handler again after attaching, leaves the console at once, and logs each event's type to a file, and a helper that dies no longer loses the check's other measurements.
- `pt-ctrl-break-attach-npm` and `-std` never became ready, and the run kept no output. The likely cause is `/s` stripping the script's first quote; the script no longer starts with one, and a timeout now reports the output.
- `pt-ctrl-c` had no working baseline: `detached` gives the driver a new process group, whose Ctrl+C setting everything below it inherits. The baseline now starts from a helper with Ctrl+C allowed.

[Windows probe run 41173994270](https://github.com/alexnakagama/veydr/actions/runs/41173994270) (`67d904d`) verifies 4.1: every ID is reported, with no "no result" line, the controls pass, `pt-libuv-job` is `PASS` on the job's limits, and `data` names the PIDs and creation times. `pt-ctrl-c` is `PASS`, with a working baseline. Its jobs also ran on two image versions, so it is not evidence.

4.3 stays open. The driver survived every attach check, with `driverEvents` 0, and in all six the marker was written and the whole tree ended, including `npm`, whose batch prompt ended by itself with stdin ignored. But the PowerShell helper died each time, with exit code 0xC000013A, before `send-ctrl` replied, and `helperEvents` is empty, so its handler did not log the event. Registering the handler after attaching did not help. So `-node` and `-cmd` are `FAIL`, and `-npm`'s `EXPECTED-FAIL` holds for a different reason than its prediction gives. D5 says a graceful stop needs a compiled helper, and these results come from PowerShell, so they do not yet show what a compiled helper does. The attach checks now use the compiled `ctrl-helper.cs`, awaiting another run.

Finding for group 8: libuv adds a process to its job at its first non-detached spawn, and `context.ps1`'s attached fallback is such a spawn. So `ctx-job` cannot see a job of the runner's, and now answers `null` when measured that way, with `inJob` still in `data`. Design D7's "measured inside a job" label cannot rest on it. Veydr's main process will also be in libuv's job after its first spawn, so any job W1 creates is nested; `pt-libuv-job` records that as `driverInLibuvJob`.

Group 4 re-review after the runs (`reviewer2`, 2026-10-31), by reading only. The `pt-libuv-job` change is confirmed as a probe fix: the removed condition was never in the question. Its findings are fixed: the compiled helper's handler catches every exception, counts events before touching a file, and is registered again after attaching, and `armed` in its log shows it got that far; `ctx-job` as above; and a helper that prints no report has its own message. Not done: a second `npm` attempt with piped stdin, since the supervisor ignores stdin, so W1 would not start commands that way. If the compiled helper survives with the event in its log, PowerShell was the problem; if it dies with `armed` and no event, handlers are not honoured in a one-shot helper, which D5 must take as the result.


Group 4 implementation notes (not yet verified on Windows; tasks stay open until a probe run):
- `process-tree.ps1` is a long-running helper answering JSON lines, because a job lives in its handles and compiling takes seconds.
- Console events are sent by `ctrl-helper.cs`, compiled during the probe, as the maintainer decided on 2026-10-31 after run 41173994270: D5 needs a compiled helper for a graceful stop, so a PowerShell helper's death says nothing about it. One copy runs per event. `SetConsoleCtrlHandler(NULL, TRUE)` covers Ctrl+C only, so it also registers a handler that swallows every event and logs its type. The check's question still names the documented sequence.
- The graceful-stop children start with stdin ignored and output piped, as the supervisor's `spawn` does. The `pt-ctrl-break-attach-npm` prediction's reason says "piped stdin"; the result is recorded as measured.
- `pt-libuv-job` tells libuv's job from the runner's by listing the helper's own job, which is libuv's, since `IsProcessInJob` with no handle is true in either.
- `pt-parent-exit-*` also measures a `cmd.exe` leader, and answers `yes` if either tree's process keeps running: a Node leader's non-detached children die with its libuv job, which would hide survivors of other leaders from D5's crash-recovery decision.
- Task 4.3 says the helper receives no event, but event 0 reaches every process on the console, the helper included (design D3). So `data` records the events the helper's handler received (`helperEvents`, which need not be empty) and the driver's, which must be zero or the answer is `no`.
- `process-tree.mjs` runs under `--timeout 420` (step 8 and 12 minutes), since `pt-identity-reuse` alone may take 60 s.

## 5. Command, environment, and encoding probes

- [ ] 5.1 Implement the command probes from the console-less launcher:
  - `cmd-direct-spawn`;
  - every `cmd-route-<route>-<case>`, for Node's `shell: true` and for `cmd.exe /d /v:off /s /c` with verbatim arguments and the quoting of `cmd-quote.mjs` (task 1.1); on the verbatim route, a case the candidate refuses answers `yes` if it was refused before spawning. Each case calls `fwd.cmd` (only `@node "%~dp0record.mjs" %*`, like `npm.cmd`); `record.mjs` writes `process.argv` as JSON. The answer is `yes` only if the recorded arguments equal the case's intended ones and the case's sentinel file, which an injected command would create, does not exist;
  - `cmd-pathext`, with `PATHEXT` and its order in `data`;
  - `cmd-pathext-cwd`: an `npm.cmd` decoy in the working directory, not on `PATH`, that would create a sentinel file if run. The answer is `yes` if the sentinel does not exist after `cmd.exe /d /s /c npm --version`. `data` records whether `NoDefaultCurrentDirectoryInExePath` is set.

  Verify: a probe run reports one line per route and case, and for each `no` the recorded arguments or the sentinel are in `data`.
- [ ] 5.2 Implement the environment checks:
  - `env-registry` and `env-registry-std`: read the user and machine environment from the registry (user over machine, except `Path`, which is machine then user; `REG_EXPAND_SZ` expanded). The answer is `yes` if every variable defined in both it and the driver's `process.env` has equal values. `data` records the names, never the values, of variables found in only one of them or with different values.
  - `env-path-case`: start a child, which reports its environment, with an environment whose only path variable is spelled `PATH` and set to a marker value. The answer is `yes` if the child sees exactly one path variable, with the marker value. `data` records the inherited spelling, and what a second child sees when given both `Path` and `PATH` with different markers. The probe does not import Veydr's merge function (TypeScript, already unit-tested on the Windows lane);

  Verify: a probe run reports all three IDs, as administrator and as a standard user, and no variable value appears in any result file.
- [ ] 5.3 Implement the encoding checks, all from the console-less launcher:
  - `enc-codepages`: the answer is `yes` if a console child's output code page is 65001 without `chcp`. `data` records `GetACP`, `GetOEMCP`, and `GetConsoleOutputCP`, with and without `windowsHide`;
  - `enc-child-<tool>-<variant>`, for the tools `cmd` (`echo`), `node`, and `python` (`NOT-TESTABLE` if not installed), each in the variants `plain` and `utf8` (`chcp 65001` first, or `PYTHONUTF8=1` for Python). Each prints one fixed non-ASCII test string. The answer is `yes` if the received bytes are valid UTF-8 and decode to exactly that string. `data` records the bytes as hex.

  Verify: a probe run reports every encoding ID, with the console context in `data`.

## 6. Port probes

- [ ] 6.1 Implement `scripts/windows-probe/ports.mjs` with a helper that listens on known ports on `127.0.0.1`, `::1`, and `0.0.0.0`. Implement:
  - `port-netstat`, `port-ps`, and `port-api` (P/Invoke `GetExtendedTcpTable` from the PowerShell helper). Each answers `yes` if it lists each of the helper's listeners with the helper's PID;
  - `port-owner-identity`, which answers `yes` if the probe can read the name and creation time of every listener's owner. `data` lists the owners it cannot open.

  The control check is that at least one method finds the helper's own sockets. Verify: a probe run reports every one of these IDs, and the control passes.
- [ ] 6.2 Run `port-ps-std`, `port-api-std`, and `port-owner-identity-std` through the standard-user runner, against a helper started by the standard user. Run `port-ps-latency` and `port-api-latency` as that user too: 10 calls each, all durations in `data`, answering `yes` if the median is at most 300 ms and the slowest at most 1 s (design D3). Verify: a probe run reports the five IDs with `context: standard`, and the control passes as a standard user.

## 7. Electron and installer probes

- [ ] 7.1 Implement the `electron` job:
  - setup with `electron: "true"`, `npm run build`, and `node scripts/ensure-electron.cjs`, since `npm run build` does not download Electron (design D8);
  - `electron-launch` (`--smoke-test`, exit code and output recorded), and one `electron-smoke-<check>` line per check in `checks.mjs` (every smoke check except `devtools-disabled`, which the unpackaged build does not run). `electron-smoke-platform` is predicted `no`;
  - `ctx-electron-no-console`, which checks Electron's main process for a console through `context.ps1`;
  - `electron-playwright`, which runs a new minimal spec, `test/windows-probe/launch.spec.ts`, with its own Playwright config. It uses only Playwright's Electron launcher, imports nothing from the e2e harness or `test/support/proc.ts`, and checks that the window renders and shows `windows` with the unsupported-platform state.

  Verify: a probe run reports every one of these IDs. A `no` must carry the failing step's output in `detail`. The new spec does not run in the Linux e2e suite, and `test-platform-policy.test.ts` still passes.
- [ ] 7.2 Implement the `nsis` job:
  - `nsis-build` runs `electron-builder --win nsis --publish never` with command-line options for a per-user, one-click installer; `electron-builder.yml` stays unchanged;
  - `nsis-install` performs a silent install (`/S`), a `--smoke-test` launch of the installed executable (exit code, and whether the `VEYDR_SMOKE_TEST` report is readable), and a silent uninstall, checking the install directory is gone. Each smoke check is recorded as `nsis-smoke-<check>`, with `nsis-smoke-platform` predicted `no`.

  Verify: a probe run reports both IDs, and `git diff --exit-code electron-builder.yml` passes in the job.
- [ ] 7.3 Only if the maintainer approves the koffi load check under gate G-4 (design D6): implement `ffi-koffi-electron` with an exact version, an integrity-checked tarball, and a probe-only `package.json` outside the lockfile. Without approval, record it as `NOT-TESTABLE` with the reason "not approved", and note the decision here. Verify: a probe run reports the ID, and the repository's `package.json` and `package-lock.json` are unchanged.

## 8. Evidence and decisions

- [ ] 8.1 Run the complete workflow on the branch and review the results:
  - every control passes: the context controls, plus each area's own control;
  - no line says "no result: probe did not report it";
  - every `FAIL` (a prediction that did not hold) and every `EXPECTED-FAIL` is understood. A `FAIL` is never fixed by editing the prediction afterwards;
  - wherever the admin and standard-user results of a check differ, the difference is explained.

  The run must be on a single Windows image version; if the summary lists several, rerun. Rerun once more to check that the results are stable (record any check whose result differs between runs, and why). Commit the reviewed run's `test/windows-probe/summary.txt` and `test/windows-probe/results/*.jsonl`. Verify: the summary header names the run's commit, one Windows image version, and the `checks.mjs` hash, and it is not a negative-control run.
- [ ] 8.2 Write `docs/windows-evidence.md` with three sections (design D7):
  - the commit that added `test/windows-probe/predictions.json` (group 1's merge), and every `REVISIONS` entry with its reason;
  - verified on the runner, each conclusion stating whether it holds as a standard user, as administrator only, or both, and, for process trees, whether it was measured inside a Job Object (`ctx-job`);
  - not verifiable on the runner, each with what would verify it;
  - decisions, each citing check IDs.

  Add `test/unit/windows-evidence.test.ts`, which checks:
  - exactly one summary line per ID in `checks.mjs`;
  - valid statuses, and reasons where required;
  - the header format, with exactly one Windows image version and no negative-control flag;
  - no "no result" line;
  - the context controls passed, or every dependent check is `NOT-TESTABLE`;
  - every `FAIL`, `EXPECTED-FAIL`, and `NOT-TESTABLE` ID is listed in the doc;
  - every decision cites a recorded ID.

  Link the "not verifiable" section from `docs/deferred-checks.md`. Verify: `npm test` passes, and a temporary edit of one summary status makes the test fail (checked once, then reverted).
- [ ] 8.3 Apply the decision rules of design D5 to the recorded results. Record the outcome in a new "Outcome" section of this change's `design.md` and in the doc's decisions section:
  - the process-tree route and the graceful-stop route, including whether an attaching helper is needed, and whether a .NET Framework helper is possible (`helper-csc-build`) (W1);
  - crash recovery, from `pt-parent-exit-descendant` and `pt-parent-exit-leader`: whether Windows can have survivors after a crash (W1);
  - the shell-mode route and any restricted cases (W2);
  - the port route, judged on the standard-user results (W3);
  - whether the Windows CI lane can run Electron e2e (W1–W4).

  Verify: each outcome cites check IDs present in `summary.txt`.

## 9. Integration check

- [ ] 9.1 Run `npm run verify` on Linux, and check the `windows` CI job and `ci-ok` on the pull request. Verify: all pass, and spec coverage reports zero unmapped scenarios.
- [ ] 9.2 Check that nothing claims Windows support: `grep -rn "Windows" README.md docs/` shows only "not yet supported" statements, CI notes, and the evidence document, and `supervisor.test.ts` › `start-on-windows` still passes. Verify: both checks hold, and are recorded in the pull request.

## Workflow follow-up

- Archive the change once its pull request is merged.
- Start W1 `add-windows-process-supervision` from the outcome in design.md. W2 and W3 follow from the same outcome. W4 `add-windows-packaging` ships the installer labelled "Windows (preview): verified in CI on Windows Server 2025", with the "not verifiable" list from `docs/windows-evidence.md`.
