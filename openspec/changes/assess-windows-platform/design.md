# Design

## Context

See `proposal.md` for motivation. Constraints that shape the approach:

- **The only Windows is the `windows-2025` GitHub Actions runner:**
  - Windows Server, English, an administrator account (`runneradmin`), with permission to create local accounts;
  - a fresh VM per job, with the job ending at its timeout;
  - Git Bash, PowerShell 7, Windows PowerShell 5.1, and .NET Framework 4.8 (including `csc.exe`) are installed.
- **Foundation design D15** lists what W0 must observe: libuv's job-object behavior for grandchildren, `taskkill /T` coverage, graceful-stop options, `.cmd`/`.bat` quoting and an injection corpus, `netstat -ano` parsing, the registry environment, output code pages, and an NSIS build. W0 ends with the gate G-4 decision.
- **Foundation design D5:** anything verified on Linux only counts as unverified for Windows. W0's results are the first native evidence.
- **Dependencies:** all are pinned and reviewed (`docs/dependencies.md`, `package-policy.test.ts`). FFI and native addons need G-4 approval. Probes therefore cannot install npm packages.
- **Workflows:** every file under `.github/` follows the D11 workflow policy, enforced by `workflow-policy.test.ts`:
  - actions pinned to a SHA;
  - `permissions: {}` at the top level and per-job grants;
  - a timeout on every job;
  - no expressions inside `run:` scripts;
  - Electron is launched only after the setup action runs with `electron: "true"`.
- **The setup action's Electron steps are Linux-only today:** `apt-get install xvfb`, user-namespace `sysctl`, core-dump `sysctl`.
- **Existing evidence pattern:** `test/packaging/smoke-linux-summary.txt` holds one line per check with `PASS`, `EXPECTED-FAIL`, or `NOT-TESTABLE` and a reason, and `install-docs.test.ts` keeps `docs/install-linux.md` consistent with it.

## Goals / Non-Goals

**Goals:**

- Every question in D15's W0 list has a recorded answer, or is recorded as not testable on the runner with the reason.
- The decisions W1–W4 depend on are made here and point at specific result lines:
  - G-4: the native-code route for process trees (W1) and ports (W3);
  - the shell-mode route for `.cmd`/`.bat` (W2);
  - whether the Electron e2e harness runs on the runner (W1–W4 CI).
- The evidence can be re-run, since the runner image changes over time, and checked for consistency by a unit test.

**Non-Goals:**

- Any product code, or a Windows implementation of a platform interface.
- Verifying Windows 10/11 desktop behavior. The preview statement explicitly excludes it (see D7).
- Measuring performance beyond the latency figures needed to compare port-reading methods.
- Making the probe workflow a required check, or running it on a schedule.

## Decisions

### D1. One manual workflow, one isolated job per probe

`.github/workflows/windows-probe.yml` is triggered by `workflow_dispatch` only. It has one job per probe area, all on `windows-2025`, plus a final `summary` job on `ubuntu-24.04` that merges the results.

- Separate jobs isolate the probes: a process-tree probe that leaves orphans, or a hung installer, cannot affect another probe's VM.
- Each job uploads its results as an artifact (`actions/upload-artifact`, pinned like the others), even when the probe fails.
- Permissions are `contents: read`, and checkout keeps no credentials. Nothing is committed or pushed by the workflow.

GitHub lets you start a `workflow_dispatch` workflow only when the workflow file exists on the default branch; the run itself can then use another branch's version (`--ref`). So W0 lands in two pull requests:

1. The workflow skeleton, the shared probe code, and the CI setup change (groups 1–2) are merged to `master` first.
2. The probes are then developed and run from the change's branch.

*Alternative:* add the probes to `ci.yml`. Rejected: they are experiments, cost Windows minutes, and some are expected to fail. A required check must not depend on them.

*Alternative:* one job that runs every probe. Rejected: one stuck probe would hide the others' results, and leftover processes would contaminate later probes.

### D2. Probes in Node and PowerShell, native APIs through C# P/Invoke

- Probe drivers are Node scripts in `scripts/windows-probe/*.mjs`. They spawn processes the way Veydr does (`child_process.spawn`), so libuv's own behavior is part of what they observe. They run without a console and, where it matters, also as a standard user (D9).
- Win32 APIs are reached with `Add-Type` C# P/Invoke in `scripts/windows-probe/*.ps1`, always run under **Windows PowerShell 5.1** (`powershell.exe -NoProfile -ExecutionPolicy Bypass -File …`). Two reasons for that version:
  - it is the PowerShell every Windows 10/11 desktop ships;
  - its `Add-Type` compiles with the .NET Framework compiler.

  PowerShell 7, the default shell for `run:` steps on Windows runners, compiles with modern .NET instead, so a probe run under it would say nothing about a .NET Framework helper. `-ExecutionPolicy Bypass` keeps the result independent of the machine's and the standard user's execution policy. The scripts call:
  - Job Objects (`CreateJobObject`, `AssignProcessToJobObject`, `TerminateJobObject`, `IsProcessInJob`);
  - `GenerateConsoleCtrlEvent`;
  - `GetExtendedTcpTable`;
  - `GetProcessTimes`;
  - `GetConsoleOutputCP` and `GetACP`.
- No npm package is installed.
- Option C of G-4 (a helper executable built with the `csc.exe` that ships with .NET Framework 4.8) gets its own evidence: `helper-csc-build`. That check compiles a minimal helper with `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe` and runs it, also as a standard user. The helper creates a Job Object, assigns a child to it, and terminates it. The P/Invoke probes themselves are not evidence for option C.
- `eslint.config` gets `scripts/windows-probe/*.mjs` added to its default-project list, so the probe drivers are type-checked and linted like the other scripts.

*Alternative:* install `koffi` in the probe job to call the APIs from Node. Rejected for the mechanism probes: it would add an unapproved dependency only to observe OS behavior that P/Invoke shows equally well. Whether koffi itself loads inside Electron is a separate question; see D6.

### D3. Probe matrix

Each check has a stable ID and is phrased as a yes/no question, so its status has one meaning:

- **`PASS`:** the answer is yes.
- **`FAIL`:** the answer is no, and no was not expected.
- **`EXPECTED-FAIL`:** the answer is no, as predicted.
- **`NOT-TESTABLE`:** no answer could be obtained, with the reason.

Every check the probes answer commits to a prediction; there is no "unknown". The one exception is the runner's known limits (listed at the end of this section). They are never answered, so they have no prediction. `checks.mjs` marks them as limits with a fixed reason, and the summary writes their `NOT-TESTABLE` lines itself. Where the outcome is genuinely uncertain, the prediction states the more likely answer, and its reason in `checks.mjs` says why. A `FAIL` therefore always means "the prediction was wrong", which is exactly the information a surprise should carry.

Values that are measured rather than decided (latencies, code pages, byte sequences, variable names, extension order) go in `data`. They are never a status. Where a decision depends on a value, a separate yes/no check states the threshold.

Each check's predicted answer, `yes` or `no`, is recorded in `scripts/windows-probe/checks.mjs` *before* any probe runs, and lands on `master` with the first pull request (D1). So the predictions are fixed in history before the evidence exists, just like the decision rules in D5. A `FAIL` is a finding, not a broken probe; broken probes are caught by control checks.

Git history alone would not show a prediction edited later, so that is made explicit:

- The first pull request also commits a snapshot of every prediction, with a hash of its question, `test/windows-probe/predictions.json`. It never changes afterwards, and `docs/windows-evidence.md` names the commit that added it.
- A change afterwards must also be listed in `checks.mjs` under `REVISIONS`, with the reason and the date: a changed prediction (original and new), a reworded question (old and new hash), a check added later (its prediction and question hash), or a check removed (the prediction it had). The summary prints such a check's status as revised.
- The summary header records the hash of `checks.mjs`.
- A unit test fails if a prediction or question in `checks.mjs` differs from the snapshot without a matching `REVISIONS` entry. It also fails if a check was added or removed without a `REVISIONS` entry recording it.

The snapshot needs no git history. That matters because CI checks out a single commit (`actions/checkout` with its default depth), so a comparison with an older commit could not run there. Editing the snapshot itself would show up in the pull request's diff, where the evidence is reviewed.

Unless a row says otherwise, checks run from a console-less parent, as administrator (D9). Rows marked *also as a standard user* are repeated with the `-std` suffix.

| Area | ID | Question | Feeds |
|---|---|---|---|
| Context | `ctx-no-console` | Control: does the probe driver have no console, like Electron's main process (D9)? | all probes |
| | `ctx-standard-user` | Control: is the `-std` driver's token unelevated and outside Administrators (D9)? | all `-std` checks |
| | `ctx-job` | Is the probe driver outside any Job Object, as Veydr is when started from Explorer? Predicted `no`: the runner probably runs steps inside a job of its own. `data` records the driver's job membership (`IsProcessInJob` with no job handle) and, if possible, the job's limits. If the answer is `no`, every process-tree conclusion is labelled "measured inside a job" (D7). | process-tree, Helper |
| Process tree | `pt-control` | Control: does every stop method the probe uses end a single plain child that has no descendants? *Also as a standard user.* A failure invalidates the area's results for that account. | all process-tree checks |
| | `pt-libuv-job` | Is a child spawned with `child_process.spawn` inside a Job Object that the driver did not create (libuv's own job), per `IsProcessInJob`? | W1 |
| | `pt-libuv-breakaway` | Can a grandchild started with `CREATE_BREAKAWAY_FROM_JOB` leave libuv's job? `data` records the job's limit flags, where readable. | W1 |
| | `pt-kill-leader` | After `child.kill()` (TerminateProcess on the leader), are the leader's descendants ended too? | W1 |
| | `pt-taskkill-tree` | Does `taskkill /T /F` on a live leader end every descendant? | W1, G-4 |
| | `pt-taskkill-orphan` | Does `taskkill /T /F` on the leader also end a grandchild whose parent already exited? | W1, G-4 |
| | `pt-job-terminate` | Does an own Job Object, assigned right after spawn, contain all later descendants, including orphans, and does `TerminateJobObject` end them all? *Also as a standard user.* | W1, G-4 |
| | `pt-parent-exit-leader` | When the spawning process is killed with `TerminateProcess` (as a crash would end Veydr), does its direct child (the leader) keep running? | W1 |
| | `pt-parent-exit-descendant` | When the spawning process is killed that way, does a grandchild started by its leader keep running? Together with `-leader`, this decides whether crash recovery on Windows must find survivors, as on Linux (`process-supervision` crash scenarios). | W1 |
| | `pt-job-race` | Is a grandchild created between spawn and job assignment still contained by the job? `data` also records whether a suspended start (from the helper) closes the gap. | W1, G-4 |
| | `pt-ctrl-break-direct` | From the console-less parent, does `GenerateConsoleCtrlEvent(CTRL_BREAK)` reach a child started in a new process group? (Expected not to, since they share no console; a `PASS` would change D5.) | W1 graceful stop |
| | `pt-ctrl-break-attach-<child>` | For a child started the way W1 would start it (`windowsHide: true`, not `detached`, so it has a hidden console of its own): does a helper stop it gracefully, while the driver keeps running? One check per child: `node` running a script, `npm run` of a package script (through `npm.cmd`), and `cmd /c` running the script. Graceful means the script's SIGBREAK handler writes its marker and the child's whole tree exits within 5 s. The helper first ignores console events itself (`SetConsoleCtrlHandler(NULL, TRUE)`), then calls `FreeConsole`, `AttachConsole(childPid)`, and `GenerateConsoleCtrlEvent(CTRL_BREAK, 0)`. Event 0 reaches every process on that console, so the helper must not react to it. *Also as a standard user.* | W1 graceful stop, G-4 |
| | `pt-ctrl-break-detached` | Can the helper reach a child started with `detached: true` (no console of its own)? Predicted no: such a child cannot be stopped gracefully, so W1 must not start commands detached. | W1 |
| | `pt-ctrl-c` | Is Ctrl+C ignored in a new process group, as documented? | W1 graceful stop |
| | `pt-console-window` | With `windowsHide: true`, does a console child of the console-less parent get a console without a visible window? `data` also records the case without `windowsHide`. Visibility needs a desktop session; it is `NOT-TESTABLE` if the runner has none. | W1, W2 |
| | `pt-identity` | Is PID plus creation time (`GetProcessTimes`) stable for a process across reads? | W1 identity, W3 |
| | `pt-identity-reuse` | When a PID is reused, does the new process have a different creation time? Windows decides when a PID is reused, so the probe spawns and ends short-lived processes up to a fixed bound (1,000 or 60 s). If no PID recurs, the result is `NOT-TESTABLE`, and W1 relies on the documented guarantee, which it states as such. | W1 identity |
| Helper | `helper-csc-build` | Does `csc.exe` from .NET Framework 4.8 compile a minimal C# helper, and does that helper, started from the console-less parent, create a Job Object, assign a child, and end it? *Also as a standard user.* | G-4 option C |
| Commands | `cmd-direct-spawn` | Is spawning `x.cmd` without a shell refused with `EINVAL` (CVE-2024-27980 hardening)? | W2 |
| | `cmd-route-<route>-<case>` | For each route, does each corpus case arrive unchanged in the Node program behind an `npm.cmd`-style shim, with no injected command run? The routes are Node's `shell: true`, and `cmd.exe /d /v:off /s /c` with verbatim arguments and the candidate quoting of `scripts/windows-probe/cmd-quote.mjs`. For a case cmd.exe cannot carry unchanged (a line break, or a line beyond 8191 characters once escaped), the verbatim route's question is instead whether the candidate refuses it before spawning. | W2 |
| | `cmd-pathext` | Is `npm` resolved to `npm.cmd` through `PATH` and `PATHEXT`? `data` records `PATHEXT` and its order. | W2 |
| | `cmd-pathext-cwd` | When the working directory holds an `npm.cmd` decoy that is not on `PATH`, is the decoy left unused by `cmd.exe /d /s /c npm`? `data` records whether `NoDefaultCurrentDirectoryInExePath` is set. | W2 |
| Environment | `env-registry` | For every variable defined both in the registry environment (user over machine, except `Path`, which is the machine value followed by the user value; `REG_EXPAND_SZ` expanded) and in the driver's inherited environment, are the values equal? `data` records the names, not the values, of variables found in only one of them or with different values. *Also as a standard user.* | W2 |
| | `env-path-case` | When `child_process.spawn` gets an environment whose only path variable is spelled `PATH` (what the groundwork's case-insensitive merge produces from an inherited `Path`), does the child see exactly one path variable, with that value? `data` records the inherited spelling, and what the child sees when the environment holds both `Path` and `PATH` (what an exact merge would produce). The merge function itself is unit-tested on the Windows CI lane; this checks the OS and Node side. | W2 |
| Encoding | `enc-codepages` | Is the console output code page of a console child of the console-less parent UTF-8 (65001) without any `chcp`? `data` records `GetACP`, `GetOEMCP`, and `GetConsoleOutputCP`, with and without `windowsHide`. | W2 |
| | `enc-child-<tool>-<variant>` | Does `<tool>`'s output of a fixed non-ASCII test string arrive as valid UTF-8 that decodes to that exact string? Tools: `cmd` (`echo`), `node`, `python` (`NOT-TESTABLE` if not installed). Variants: `plain`, and `utf8` (`chcp 65001` first, or `PYTHONUTF8=1` for Python). `data` records the raw bytes as hex. | W2 |
| Ports | `port-control` | Control: does at least one method list the helper's own listening sockets with its PID? *Also as a standard user.* A failure invalidates the area's results for that account. | all ports checks |
| | `port-netstat` | Does `netstat -ano` list a known listener on `127.0.0.1`, `::1`, and `0.0.0.0` with its PID? | W3 |
| | `port-ps` | Does `Get-NetTCPConnection` list each of those listeners with its PID? *Also as a standard user.* | W3 |
| | `port-api` | Does `GetExtendedTcpTable` (P/Invoke) list each of those listeners with its PID? *Also as a standard user.* | W3, G-4 |
| | `port-ps-latency`, `port-api-latency` | Is the median of 10 calls at most 300 ms, and the slowest at most 1 s? The Ports view refreshes every 3 s (`PORTS_POLL_INTERVAL_MS`), so 300 ms is a tenth of the interval. `data` records every call's duration. Measured as a standard user. | W3 |
| | `port-owner-identity` | Can the probe read the owning process's name and creation time for every listener on the machine? `data` lists the owners it cannot open, e.g. PID 4 and services. *Also as a standard user*, the case Veydr's users are in. | W3 |
| Electron | `electron-launch` | Does the built app start on the runner, and does `--smoke-test` print its `VEYDR_SMOKE_TEST` report? | W1–W4 CI |
| | `electron-smoke-<check>` | Did the smoke test's check `<check>` pass? One line per check the report can contain (`process-sandbox`, `ui-loaded`, `preload-bridge`, …), except `devtools-disabled`, which the smoke test runs only in packaged builds. `electron-smoke-platform` is predicted no: the Windows platform is unsupported, so the smoke test's overall `fail` is expected and is not evidence against Electron. | W1–W4 CI, W4 |
| | `ctx-electron-no-console` | Does Electron's main process run without a console, confirming that the D9 launcher reproduces Veydr's parent? | all probes |
| | `electron-playwright` | Does a minimal spec, `test/windows-probe/launch.spec.ts`, pass under Playwright on the runner? It uses only Playwright's Electron launcher. It checks that the window renders and shows `windows` with the unsupported-platform state. The existing e2e specs cannot run there: `shell.spec.ts` asserts `linux`, and the e2e harness builds on the `/proc` helpers of `test/support/proc.ts`. Making that harness portable is W1's work, informed by this result. | W1–W4 CI |
| | `ffi-koffi-electron` | Does `koffi` load inside Electron's main process from an ASAR-packaged app on the runner? Run only with the approval of D6; otherwise `NOT-TESTABLE` (not approved). | G-4 option B |
| Installer | `nsis-build` | Does `electron-builder --win nsis` build a per-user installer from command-line options, with `electron-builder.yml` unchanged? | W4 |
| | `nsis-install` | Do a silent install (`/S`), a `--smoke-test` launch of the installed app, and a silent uninstall work, with the smoke report and the exit code readable from the GUI-subsystem executable? The installed app's smoke checks are recorded as `nsis-smoke-<check>`, with `nsis-smoke-platform` predicted no, as for `electron-smoke-<check>`. | W4 |

The injection corpus for `cmd-route-*` contains:

- the metacharacters `& | < > ^ ( )`;
- `%VAR%` and `!VAR!` expansion;
- embedded and unbalanced quotes;
- trailing backslashes;
- spaces;
- newline and carriage return;
- `%` signs in different arguments, and batch parameter references (`%1`, `%*`, `%~dp0`);
- a line beyond cmd.exe's 8191 characters once escaped;
- non-ASCII text;
- an empty argument.

How a case is judged:

- **The target is what `.cmd` shims really do.** The probe calls `fwd.cmd`, which contains only `@node "%~dp0record.mjs" %*`, the shape of `npm.cmd` and other npm shims. `record.mjs` writes its `process.argv` as JSON. A case passes only if the recorded arguments equal the intended ones exactly, and a sentinel file that an injected command would create does not exist.
- **Batch files that expand `%1` themselves are out of scope.** Batch files that use their arguments directly are user scripts whose own quoting Veydr cannot control. W2 documents that.
- **The quoting is a candidate, written down.** Veydr has no Windows quoting today. `scripts/windows-probe/cmd-quote.mjs` holds the candidate algorithm under test:
  1. each argument is quoted by the `CommandLineToArgvW` rules;
  2. cmd metacharacters, including the quotes, are escaped with `^` twice, since a shim's arguments are parsed by cmd.exe twice (the `/c` line, then the batch line `%*` is substituted into), and a `^` follows each `%`, so no `%…%` pair names a defined variable;
  3. the whole line is wrapped for `cmd.exe /d /v:off /s /c "…"`;
  4. an argument with a line break or NUL, or a line beyond 8191 characters, is refused before spawning.

  If it passes the corpus (refusing the cases it cannot carry), W2 adopts it unchanged, with those inputs rejected.

Checks the runner cannot run are limits: `checks.mjs` lists them with a fixed reason and no prediction, and the summary records each as `NOT-TESTABLE` with that reason, so they stay visible in every run:

- `env-desktop-launch`: the environment of an app started from Explorer;
- `pt-logoff`: stopping commands when the user logs off or Windows shuts down;
- `ux-uac-prompt`: UAC elevation prompts, which need an interactive desktop. Running as a standard user is covered by the `-std` checks (D9);
- `l10n-console`: localized Windows;
- `av-third-party`: antivirus other than Defender;
- `smartscreen`: the SmartScreen prompt for an unsigned installer.

### D4. Result format and recorded evidence

Each probe prints JSON lines: `{ id, answer, detail, data }`.

- `answer` is `yes`, `no`, or `null` (no answer obtained).
- `data.context` records `admin` or `standard` and whether the driver had a console (D9).

A probe reports only the answer; it never chooses its own status. The `summary` step derives the status from the answer and the prediction recorded in `checks.mjs` (D3). So a probe cannot label an unexpected result as expected. A `no` or `null` answer requires a non-empty `detail`.

Check IDs that are generated rather than fixed are generated in `checks.mjs` from their sources: `cmd-route-<route>-<case>` from the corpus, `enc-child-<tool>-<variant>` from the tool and variant lists, and `electron-smoke-<check>` / `nsis-smoke-<check>` from the smoke test's check names. A smoke check that appears in a report but not in `checks.mjs` is rejected as an unknown ID, so a new smoke check cannot slip through unrecorded.

A check that no probe answered is recorded as `NOT-TESTABLE` with the reason "no result: probe did not report it", so a crashed or skipped probe shows up as missing evidence. A run with any such line is incomplete and is never committed; the evidence test rejects it.

Each Windows probe job writes its own identity as the first line of its results: `ImageOS`, `ImageVersion`, the Windows build (`[Environment]::OSVersion`), the Node version, and whether the run is a negative-control run. The `summary` job runs on Ubuntu, so its own environment says nothing about Windows; it takes the Windows identity only from those lines.

GitHub can roll out a new image while a run is in progress, so jobs of one run may land on different image versions. The summary lists every distinct Windows image version with the areas measured on it. The evidence test fails on a summary with more than one, so a reviewed run is always on a single image. A rerun is the fix.

The `summary` job merges every probe's output into `summary.txt`:

- a header of lines starting with `# `: commit SHA, workflow run ID, the date, the hash of `checks.mjs` used for the run, the negative-control flag, one `image` line per distinct Windows identity (image version, build, Node version, and the areas measured on it), and one `invalid` line per area and account whose control did not pass;
- then one line per check: `<id> <status> [revised] <detail>`, sorted by ID, in the style of `smoke-linux-summary.txt`; `[revised]` marks a check listed in `REVISIONS`.

Results files are UTF-8, with or without a BOM; a UTF-16 file, which Windows PowerShell 5.1 writes by default, is rejected.

The parsing and formatting code lives in `scripts/windows-probe/summary.mjs`, with a `.d.mts` declaration for typed tests, following the `release-version.d.mts` pattern.

After the maintainer reviews a run, its artifact is committed:

- `test/windows-probe/summary.txt`;
- `test/windows-probe/results/<area>.jsonl`, the raw lines including `data`.

`.gitattributes` marks `*.jsonl` as binary (groundwork change), which would hide these files in review diffs. A later, more specific line, `test/windows-probe/results/*.jsonl -binary text eol=lf diff merge`, makes them reviewable text; later `.gitattributes` patterns take precedence. `binary` is a macro (`-diff -merge -text`), so the line unsets it and sets its parts back; `text` alone would leave `binary` set.

The workflow never commits anything (D1).

`test/unit/windows-evidence.test.ts` checks the evidence:

- the summary has exactly one line per check ID in `checks.mjs`;
- every line has a status from the allowed set, and a reason where one is required;
- the header names a full commit SHA and an image version;
- the context controls (`ctx-no-console`, `ctx-standard-user`) are `PASS`, or every check depending on them is `NOT-TESTABLE`, so no result is recorded from the wrong context;
- `docs/windows-evidence.md` lists every `FAIL`, `EXPECTED-FAIL`, and `NOT-TESTABLE` check by ID, and every decision in the doc cites at least one recorded check ID.

The check-ID list lives in `scripts/windows-probe/checks.mjs`, which the probes, the summary, and the test all import, so it cannot drift.

### D5. Gate G-4: decision rules, fixed before the evidence

To keep the decision from being fitted to the results afterwards, the rules are written now. Task 8.3 applies them to the recorded results and records the outcome in this design and in `docs/windows-evidence.md`.

**Process trees (W1):**

| Option | Taken when |
|---|---|
| A. `taskkill /T /F` only, forced-only stop (`graceful: 'unsupported'`) | `pt-taskkill-orphan` is `PASS` (no orphan escapes) and no Job Object option is needed. Not expected. |
| B. Job Object through FFI (`koffi`) in the main process | Job containment is needed (`pt-job-terminate` is `PASS` and `pt-taskkill-orphan` is not) **and** the koffi load check (D6) passes |
| C. Job Object through a small helper executable (C#, .NET Framework 4.8, compiled with the built-in `csc.exe`, or a native build) | Job containment is needed, option B is not approved or its load check fails, and `helper-csc-build` and `helper-csc-build-std` are `PASS`. If they are not, the .NET Framework route is ruled out and W1 must use a native build, with its own evidence |
| D. Job Object through a PowerShell helper at runtime | Never as the product route: startup cost and execution-policy dependence. Used only in probes |

Graceful stop:

- If `pt-ctrl-break-direct` is `PASS`, W1 sends `CTRL_BREAK` directly before the forced stop. This is not expected (D9).
- Otherwise, if `pt-ctrl-break-attach-node`, `pt-ctrl-break-attach-npm`, and their `-std` variants are `PASS`, W1 sends it through an attaching helper. If only the `node` checks pass, W1 may still use the helper for commands it starts without a batch file in between (for example npm through its JavaScript entry point), and records the batch-file case as forced-only. Attaching must not happen in Electron's own process, since a GUI process that attaches to a child's console can receive that console's events itself. So a graceful stop requires option C's helper even if option B handles the Job Object.
- Otherwise the Windows stop is forced-only, which the specs already allow (`graceful: 'unsupported'`).

`pt-job-race` decides whether W1 must start commands suspended. That needs `CREATE_SUSPENDED`, which Node cannot request, so a `FAIL` there rules out option B unless a helper starts the process.

`pt-parent-exit-descendant` decides W1's crash recovery:

- **`PASS`** (descendants survive Veydr's end, whatever happens to the leader): survivors are found from the run ledger, as on Linux, since a surviving process can still hold a port.
- **`FAIL`** (nothing survives): Windows has no survivors after a crash, and W1 records that as a spec delta instead of porting the survivor search.

`pt-parent-exit-leader` tells W1 whether the leader itself can be among the survivors.

W1 must also keep Veydr's quit path working either way: an orderly quit still stops commands itself.

**Ports (W3):**

Port rules are judged on the `-std` results, since Veydr runs as a standard user:

- `GetExtendedTcpTable` through the same native route as W1 if one is chosen, and `port-api-std` is `PASS`;
- otherwise `Get-NetTCPConnection`, if `port-ps-std` and `port-ps-latency` are `PASS`;
- `netstat -ano` text parsing only as a last resort, since its output is localized and the runner cannot test other locales (`l10n-console`).

`port-owner-identity-std` decides how W3 shows owners a standard user cannot open: as restricted, as the Linux view already does. It does not choose the route.

**Shell mode (W2):** the first route whose corpus cases all pass (on the verbatim route, a case the candidate refuses passes by being refused, and W2 rejects that input). If none passes every case, W2 restricts the shell-mode input it accepts on Windows and the failing cases become W2 spec scenarios.

### D6. The koffi load check needs separate approval

Whether `koffi` loads inside Electron's main process from an ASAR-packaged app on the runner is evidence only for option B. Running it means installing an unapproved native dependency, even if only in a throwaway directory.

So that probe (`ffi-koffi-electron`) is implemented only if the maintainer approves it explicitly, as part of G-4, before group 8. It then uses:

- an exact version;
- an integrity-checked tarball;
- a probe-only `package.json`, outside the repository's lockfile.

Without that approval it is recorded as `NOT-TESTABLE` (not approved), and option B cannot be chosen in W0. W1 can still reopen it.

### D7. Limits are recorded, not assumed away

`docs/windows-evidence.md` has three sections:

1. **Verified on the runner:** each area's conclusion with the check IDs behind it, stating whether it holds as a standard user, as administrator only, or both, and, for process trees, whether it was measured inside a Job Object (`ctx-job`).
2. **Not verifiable on the runner:** the `NOT-TESTABLE` list from D3, each with what would verify it (a Windows 10/11 desktop with an interactive session, a localized install, a machine with third-party antivirus). If `ctx-job` answers `no`, this section also lists "process trees under a parent outside any Job Object, as when Veydr is started from Explorer".
3. **Decisions:** the G-4, shell-route, port-route, and CI outcomes, each citing check IDs.

`docs/deferred-checks.md` links the second section. The README and the platform docs keep "Windows not yet supported". The preview label belongs to W4, when there is something to install.

### D8. Setup action: Electron preparation per OS

The setup action's Linux-only steps get `runner.os == 'Linux'` added to their `if:` conditions:

- Install Xvfb;
- Enable unprivileged user namespaces;
- Disable core dumps.

On Windows, `electron: "true"` then prepares nothing beyond the dependencies. Electron itself is downloaded by `scripts/ensure-electron.cjs`. The `test:*` scripts run it themselves, but `npm run build` does not. So a probe that launches the built app directly (`--smoke-test`) runs `node scripts/ensure-electron.cjs` first, as an explicit step.

The workflow policy's rule (any job that launches Electron must first run setup with `electron: "true"`) also applies to `windows-probe.yml`, so it needs no Windows exception. Its detector (`launchesElectron` in `workflow-policy.test.ts`) recognises `xvfb-run`, the `test:*` scripts, and `playwright`, but not a direct launch for `--smoke-test` or `scripts/ensure-electron.cjs`. It is extended to match those too, so the probe's smoke launch cannot bypass the rule.

`workflow-policy.test.ts` pins the new `if:` conditions exactly, as it does today. Linux jobs keep the same effective behavior.

*Alternative:* a separate Windows setup action. Rejected: it would duplicate the Node, npm, cache, and `npm ci` steps that already work on Windows (groundwork change).

### D9. Execution contexts: a console-less parent and a standard user

Two properties of the runner would bias the results unless the probes control them.

**Console.** Veydr's main process is a GUI-subsystem process without a console. The runner's shell, and anything started from it, has one. This matters in three ways:

- Console control events (`GenerateConsoleCtrlEvent`) reach only processes that share the caller's console.
- Whether a child gets its own console, and shows a window, depends on its parent's console and on `windowsHide`.
- The console code page applies only where a console exists.

So every probe whose result can depend on this (process tree, encoding, console windows) runs its driver through `scripts/windows-probe/launch-detached.mjs`. That launcher starts the driver with `detached: true` and `windowsHide: true`, so the driver has no console, like Electron's main process. The driver writes its result lines to a file; the job's shell is not involved.

**Job objects.** The launcher matches Veydr's console situation, but not necessarily its job situation:

- Veydr started from Explorer belongs to no Job Object.
- The probe driver may belong to one the runner uses to clean up after steps. Nested jobs can change how breakaway and termination behave.

The launcher cannot remove that, since Node cannot request `CREATE_BREAKAWAY_FROM_JOB`. So it is measured instead of assumed: `ctx-job` records the driver's job membership. If the driver is inside a job, the process-tree conclusions say so, and "a parent outside any Job Object" is listed among the limits of the runner (D7).

A control check, `ctx-no-console`, runs first in each such driver: `GetConsoleWindow` returns no window and `AttachConsole(ATTACH_PARENT_PROCESS)` fails. If the control fails, that area's results are marked invalid instead of being recorded.

That the control can fail at all is shown by a separate run with the workflow input `negative-control: true` (off by default). Such a run starts one driver straight from the job's shell, and its summary header says it is a negative-control run. It is never committed as evidence, and the evidence test rejects a summary from such a run.

**Privileges.** The runner account is an administrator. An administrator can open processes, read registry keys, and see socket owners that a normal user cannot, so admin-only results would overstate what Veydr can do for its users.

So the ports, environment, and process-tree probes also run as a temporary standard user:

- The job creates a local account without administrator membership (`New-LocalUser`). Its random password is generated in the job, masked with `::add-mask::`, and never written to a file or a result line.
  - The password satisfies Windows' default complexity rules, which Windows Server enforces for local accounts: 32 characters, generated with a cryptographic random generator, with at least one upper-case letter, lower-case letter, digit, and symbol, and no part of the account name.
  - A fixed account name, `veydr-probe`, is enough: every job runs on a fresh VM, so no earlier account can exist. The name stays within Windows' 20-character limit for local accounts.
- The driver runs as that user through the same console-less launcher, started by `CreateProcessWithLogonW` (P/Invoke from `standard-user.ps1`) with `LOGON_WITH_PROFILE` and a null environment block. Windows documents that it then builds the environment from that user's profile, as at logon (`env-registry-std` relies on this), and loading the profile creates the user's registry hive, so `HKCU\Environment` exists as it does for a real user who has logged on. Without it, `env-registry-std` would compare against nothing.
  - `Start-Process -Credential` is not used: whether it passes the parent's environment is not documented precisely, and in Windows PowerShell 5.1 `-UseNewEnvironment` reads the user variables of the *calling* account, not of the target user.
  - `CreateProcessWithLogonW` starts the launcher, not the driver. The launcher then starts the driver with `detached: true`, so the driver has no console whether or not the launcher has one (`CREATE_NO_WINDOW` is passed for the launcher). `ctx-no-console` checks the result. If it fails as the standard user, the fallback is to start the launcher from the `helper-csc-build` helper with `LogonUser` and `CreateProcessAsUser`.
  - The API needs the Secondary Logon service (`seclogon`), which is trigger-started by default. The setup step runs `Start-Service seclogon` first, and any error (e.g. 1058, service disabled) is reported in `ctx-standard-user`'s detail.
  - With a null `lpDesktop`, the process runs on a non-interactive window station. That suits console-less Node probes; this path must not be reused for anything that needs a desktop or shows a window.
  - The driver's environment therefore has none of the job's additions: no `GITHUB_PATH` entries and no `GITHUB_*` or `RUNNER_*` variables. The launcher is started with an absolute `node.exe` path, and the probe reads anything it needs from the job through its command line, never its environment.
- The probe files are copied to a directory the user can read and write (`C:\veydr-probe-std`, with access granted to that account only). The job's workspace may not be readable to other accounts. The Node runtime's own directory is checked to be readable before the run, and a failure is reported through `ctx-standard-user`.
- The account is removed at the end of the job, whatever the outcome.

A control check, `ctx-standard-user`, confirms the driver's token is not elevated and not in Administrators. If creating the account or starting a process as it fails, the standard-user checks are recorded as `NOT-TESTABLE` with the error, and the area's admin results are labelled as admin-only.

Standard-user checks carry the suffix `-std`, e.g. `port-owner-identity-std`. Every result line's `data` records its context (`admin` or `standard`, and `console: none`), so no result is read without knowing where it came from.

*Alternative:* accept the admin results and list "non-admin" as not testable. Rejected: a standard account is available on the runner, and the port and environment results matter most for exactly that difference.

*Alternative:* run the probes from inside Electron to get the real parent. Rejected for most probes: it would tie every probe to the Electron build. The console-less launcher reproduces the property that matters, and `electron-launch` (D3) separately checks that Electron's main process has no console (`ctx-electron-no-console`).

## Risks / Trade-offs

- [A probe hangs (e.g. an installer waiting for input, or a process that ignores termination)] → every job has a timeout, every probe step has its own timeout, and each probe writes its result lines incrementally, so a partial result is still uploaded.
- [Runner image updates change behavior later] → the summary header records `ImageVersion`. W1–W3 re-check their own behavior in their CI, so a stale W0 result is caught where it matters.
- [A probe runs in a context unlike Veydr's (a console parent, or administrator rights) and its result is taken as Veydr's behavior] → the console-less launcher and the standard-user pass (D9), with control checks that invalidate an area whose context could not be established.
- [The temporary standard user's password leaks into logs] → generated in the job, masked with `::add-mask::`, never written to a file or result line, and the account is removed at the end of the job; the runner VM is discarded anyway.
- [Windows Server differs from Windows 10/11 (console host, Defender policy, installed tools)] → recorded as a limit in D7. The product claim stays "preview, verified in CI on Windows Server 2025".
- [Results are fitted to a preferred option] → the decision rules are fixed in D5 before the evidence exists.
- [A `FAIL` is mistaken for a broken probe, or a broken probe for a finding] → each probe has a control check (e.g. a plain child that should be killed by every method). A failed control marks the area's results as invalid instead of recording them.
- [Windows minutes are billed at twice the Linux rate on private repositories] → manual trigger only, bounded timeouts, and no schedule.
- [The P/Invoke helper itself behaves differently from a later Node/koffi or helper-exe implementation] → W0 records OS behavior. W1 verifies its own implementation natively in CI.

## Migration Plan

No product or configuration change. Rollout is a merge of the probe tooling, followed by manual runs. The evidence is committed in a follow-up commit within this change once a run is reviewed. Rollback is a revert: removing the probe workflow affects no required check.

## Open Questions

- How often to re-run the probes after W0. This doesn't affect this change; W1–W4 decide whether they need a fresh run for their own decisions.
