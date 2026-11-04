# Design

## Context

See proposal.md for the motivation. The current state:

- `src/main/platform/types.ts` defines `ProcessTree` (`spawn`, `launchDetached`, `findSurvivors`, `terminateSurvivors`) and `ManagedProcess` (`onExit`, `onDescendantsChange`, `remaining`, `attributed`, `stop`). The supervisor (`src/main/supervisor/`), the run ledger, and crash recovery only use this interface, so they need no Windows-specific code.
- `createWindowsPlatform()` returns `createUnsupportedPlatform('windows', …)` with Windows conventions. Every operation rejects with `UnsupportedPlatformError`.
- The Linux implementation (`src/main/platform/linux/process-tree.ts`, `survivors.ts`) attributes processes by session and observed parent links, and verifies identity (boot ID, PID, start time) before every signal.
- W0's evidence (`docs/windows-evidence.md`, `test/windows-probe/summary.txt`) and its "Outcome" section (`openspec/changes/archive/2026-11-03-assess-windows-platform/design.md`) fix the route:
  - a Job Object through a helper built with the .NET Framework 4.8 `csc.exe`: `helper-csc-build`, `helper-csc-build-std`, `pt-job-terminate`, `pt-job-terminate-std`;
  - a suspended start closes the job-assignment race: `pt-job-race`;
  - a graceful stop through an attaching helper: `pt-ctrl-break-attach-node`, `pt-ctrl-break-attach-npm`, their `-std` variants, and `pt-ctrl-break-direct`;
  - commands are started hidden, never detached: `pt-ctrl-break-detached`.
  - W0 measured process trees only inside libuv's job (`ctx-job` is `NOT-TESTABLE`).
- The probe helpers `scripts/windows-probe/job-helper.cs` and `ctrl-helper.cs` show that the needed P/Invoke works under C# 5. They are evidence code and are not reused as-is.
- Gate G-4 was approved by the maintainer on 2026-11-03 for option C, with the helper built in CI and shipped (not compiled on the user's machine). Signing stays open (G-6).
- `npm run spec-coverage` reads scenarios from `openspec/specs` and from every change's delta specs, and counts a scenario as mapped when any file under `test/` contains its `[spec:…]` tag, skipped tests included.

## Goals / Non-Goals

**Goals:**
- A Windows `ProcessTree` that meets the process-supervision requirements for Windows (see `specs/process-supervision/spec.md`), verified on the `windows-2025` runner on every pull request.
- One helper program that W3 can extend for `GetExtendedTcpTable`, so W1 sets its build, protocol, and test pattern.
- No change to the supervisor, the ledger format, crash recovery, or any Linux behavior.

**Non-Goals:**
- Starting commands from the app on Windows: the resolver and the environment are W2, and `supported` stays `false`.
- Packaging the helper or the app for Windows, and signing: W4 and G-6.
- `launchDetached` (editor launch) on Windows. It still rejects as unsupported. W2 implements it together with command resolution, since it needs the same executable lookup.
- Verifying a Windows 10/11 desktop, logoff, shutdown, or a parent outside any Job Object. These stay in the "not verifiable on the runner" list.

## Decisions

### D1. One helper process per run, owning that run's Job Object

`spawn(plan)` starts `veydr-helper.exe run …` with Node's `child_process.spawn` (`windowsHide: true`, never `detached`). The helper then does the following:

1. It creates a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and without any breakaway limit.
2. It starts the command with `CreateProcess` and `CREATE_SUSPENDED | CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT`, with `STARTF_USESHOWWINDOW` set to `SW_HIDE`.
3. It assigns the suspended command to the job, then resumes it.
4. It stays alive until the job is empty.

The job holds every process the command starts, from its first instruction (spec "Descendant started immediately"; W0 `pt-job-race`). The helper itself is not in the job, so it can still report after the job has ended.

**Abnormal endings (spec "Windows command trees end on abnormal exit"):**
- The helper holds the only handle to the job. If the helper ends for any reason, the kernel closes that handle and `KILL_ON_JOB_CLOSE` ends the tree.
- If Veydr ends, the helper sees its control channel close (D2), terminates the job, and exits.
- libuv's own job, whose `KILL_ON_JOB_CLOSE` ends the helper when Electron dies, is a third layer. The design does not depend on it.

**Alternatives considered:**
- *One shared helper for all runs.* One process fewer per command. But a helper crash would end every command at once, and the protocol would need run multiplexing. Rejected.
- *Node assigns the job after spawning.* This needs FFI, and W0 showed the race (`pt-job-race`). Rejected.
- *A job without `KILL_ON_JOB_CLOSE`, relying on the ledger as on Linux.* This leaves trees running after a crash, which the "Stop all on quit" requirement tries to avoid. Rejected. The ledger is still written as a fallback (D4).

### D2. Output goes straight to Veydr; control uses a named pipe

The helper passes the command its own stdout and stderr handles (Node's pipes) through `STARTUPINFOEX` and `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, so the command inherits exactly those two handles plus a `NUL` stdin. Output never passes through the helper, so the throughput tolerance of "Output does not block processes" is unaffected, and `ManagedProcess.stdout` and `stderr` are the helper's own streams. The helper writes nothing to them itself.

**Control channel:**
- Veydr listens on a named pipe `\\.\pipe\veydr-<128-bit random>` created with `net.createServer`. It passes the pipe name on the helper's command line. It writes a one-time token as one line to the helper's stdin, then closes that stdin. The token never appears on a command line, which any process of the same user can read. The helper's stdin is otherwise unused, and the command's own stdin is `NUL`.
- The helper connects once and proves itself with the token. Veydr accepts a single connection per run and then closes the server.
- Both directions carry JSON lines, version 1:
  - helper to Veydr: `ready` (helper PID), `started` (leader PID and creation time), `members` (job members, each as PID and creation time), `exited` (leader exit code), `stopped` (graceful, forced, and survivors), `error` (message);
  - Veydr to helper: `stop` (`graceMs`), `list` (asks for a fresh `members`).
- `members` is event-driven. The job is associated with an I/O completion port, and the helper sends a fresh list on `JOB_OBJECT_MSG_NEW_PROCESS`, `JOB_OBJECT_MSG_EXIT_PROCESS`, and on `list`.
- A malformed line, an unknown message, or a closed channel before `exited` is treated as a helper failure. Veydr terminates the helper, whose job then ends the tree, and reports the stop as unverified, as the supervisor already does for a failed stop.

**Alternatives considered:**
- *Control over the helper's stdin and stdout, with the helper relaying the command's output.* Every output byte would be copied once more, and a stalled relay would block the command. Rejected.
- *Extra inherited file descriptors.* Reaching libuv's CRT handle passing from C# is fragile. Rejected.

### D3. Graceful stop by attaching to the command's console

On `stop`, the helper does the following:

1. It runs `FreeConsole`, then `AttachConsole` on the leader, or on the oldest live job member if the leader has exited.
2. It calls `SetConsoleCtrlHandler(null, true)` so the event does not end the helper, then `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, 0)`, which reaches every process on the command's hidden console. It then detaches.
3. If the job is not empty after `graceMs`, it calls `TerminateJobObject`, then waits up to 1 s (Linux's `KILL_WAIT_MS`) for `ActiveProcesses` to reach 0.
4. It reports `graceful` (`yes` if the job emptied before the forced step), `forced`, and any members still alive.

**When no event can be sent.** Step 1 can fail: `AttachConsole` fails, or the leader has exited and no live member is attached to the command's console. Then the helper skips the graceful attempt and the `graceMs` wait. It goes straight to step 3 and reports `graceful: 'no'` and `forced: true`.

Each command has its own console, so the event never reaches Veydr or another command (spec "Windows graceful stop"; W0 `pt-ctrl-break-direct`, `pt-ctrl-break-attach-*`). Stdin is `NUL`, so a batch file's "Terminate batch job (Y/N)?" prompt reads end-of-file and does not hold the tree (W0 `pt-ctrl-break-attach-npm`).

**Alternatives considered:**
- *`taskkill /T`.* W0 showed it misses orphaned descendants (`pt-taskkill-orphan`) and gives no graceful route for console programs. Rejected.
- *A forced-only stop.* G-4 allowed it, but the attach route works, including as a standard user. Rejected.

### D4. Identity, attribution, and crash recovery

- **Identity.** `ProcessIdentity.token` on Windows is the process creation time as a decimal FILETIME string, from `GetProcessTimes`. Creation times differ across boots, so no boot ID is needed. `sessionId` is `null`.
- **Attribution.** Attribution is job membership, so `attributed()` and `remaining()` ask the helper for a fresh `members`. `onDescendantsChange` reports every member except the leader, and feeds the ledger as on Linux.
- **Process names.** `ProcInfo.name` is the image file name from `QueryFullProcessImageName`. `commandLine` is the image path: reading another process's command line needs its memory or WMI, which is too slow for a stop. The docs record this limitation.
- **`findSurvivors`.** It runs `veydr-helper.exe inspect`, which reads the identities as JSON on stdin and prints, for each one, whether a live process has that PID and creation time, with its name. Nothing is opened for writing.
- **`terminateSurvivors`.** It runs `veydr-helper.exe terminate`. Survivors are no longer in a job Veydr holds, so:
  1. the helper re-verifies each identity;
  2. it attaches to the survivor's console, if it has one, and reads `GetConsoleProcessList`. It sends Ctrl+Break only if every process on that console is a verified survivor, because the event reaches every process on the console. Otherwise it detaches without sending, and that survivor gets no graceful attempt;
  3. it waits for the default stop timeout and re-verifies;
  4. it calls `TerminateProcess` on each survivor that still matches.

  This satisfies "Never terminate unrelated processes" and "Windows process identity". With D1, survivors are expected only if the helper itself was prevented from ending the job, which the integration tests try to provoke (D7).

### D5. Helper source, build, and location

- **Source.** One C# 5 file, `src/main/platform/windows/helper/veydr-helper.cs`, targeting .NET Framework 4.8, which Windows 10 1903+, Windows 11, and Server 2022+ include. It provides the subcommands `run`, `inspect`, `terminate`, and `version`. W3 adds `ports` to the same file.
- **Build.** `scripts/build-windows-helper.mjs`:
  - compiles the source with `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize+ /warnaserror+ /target:exe` into `out-helper/veydr-helper.exe`, which is git-ignored like `out-probe/`;
  - exits non-zero with the compiler output when compilation fails;
  - on other systems, exits 1 with "the Windows helper can only be built on Windows".
- **Rebuilds.** `out-helper/` also holds the SHA-256 of the source the binary was built from, and a rebuild happens only when it differs.
- **Location.** `createWindowsPlatform({ helperPath, log })` receives the path from the composition root, which uses `<app path>/out-helper/veydr-helper.exe` in development and in tests. W4 changes only that path for the packaged app (`process.resourcesPath`), and adds the binary to the package.
- **Missing helper.** `spawn` rejects with `SpawnError("Windows helper not found: <path>")`, and no process is created.
- **Version check.** `version` prints the protocol version, and `spawn` refuses a helper whose version does not match.

**Alternatives considered:**
- *Compiling on the user's machine at first use.* The maintainer chose against it (2026-11-03): a first-run compile step and a runtime dependency on `csc.exe`.
- *A Rust or C++ helper.* This needs a native toolchain and dependencies that G-4 did not cover. Rejected.
- *Committing the binary.* This is unreviewable. The quality-gates delta forbids it.

### D6. Platform composition and the unchanged start path

`createWindowsPlatform(options)` returns:
- `supported: false` and the Windows conventions;
- a real `processTree` (`spawn`, `findSurvivors`, `terminateSurvivors`), with `launchDetached` still rejecting as unsupported;
- the unsupported `commandResolver`, `envProvider`, and `portInspector`.

The supervisor resolves a command before spawning it, so starting a command on Windows still fails with `UnsupportedPlatformError` from the resolver, and no process is created (spec "Start on Windows"). The `start-on-windows` unit test is rewritten to use the Windows platform's resolver and a spy process tree, and it asserts that `spawn` was never called. `selectPlatform` passes `helperPath` from the composition root. No other module reads the path.

### D7. Testing

- **Unit tests, on every system.** They cover the protocol parser and encoder, the identity token, and a `ManagedProcess` driven by a fake helper over a real named pipe or Unix socket. The fake helper exercises ready, started, members, exited, stop results, malformed lines, an early close, and a version mismatch. They also cover the build script's argument handling and up-to-date check.
- **Integration tests, Windows only.** `test/integration/windows-process-tree.test.ts` is guarded with `describe.skipIf(process.platform !== 'win32')` and titled `[windows-only: Job Objects]`. Its trees are made of Node fixture scripts, and it:
  - enumerates processes independently of the helper with `Get-CimInstance Win32_Process`, matching on a unique marker in each fixture's command line;
  - starts a sentinel process outside the supervisor, which must survive every scenario;
  - covers children, grandchildren, an orphaned grandchild, a child started as the very first action, cooperative and uncooperative trees, an `npm.cmd`-style batch file, and a reused-PID identity;
  - ends the Node host abruptly (`taskkill /F` on a host process that owns the tree), and checks that the tree is gone and that `findSurvivors` on the recorded ledger entry returns nothing;
  - ends only a command's helper abruptly, and checks that the tree is gone and the stop is reported as unverified;
  - checks that `terminate` sends no Ctrl+Break to a console it shares with a process that is not a survivor.

  Scenarios repeat `VEYDR_STRESS` times, as on Linux.
- **Standard user.** W0 showed that the routes behave the same for a standard user. The CI job runs as the runner's administrator, and the docs say so; W4 repeats the smoke test as a standard user.

Every new scenario carries its `[spec:process-supervision/…]` or `[spec:quality-gates/…]` tag.

### D8. CI

The `windows` job gains two steps after the unit tests, each with the job's existing "keep running after a failure" condition:
- `node scripts/build-windows-helper.mjs`;
- `npm run test:windows`, which is `vitest run --project integration windows-`.

The test step's `if:` requires the build step's success. After a failed build the test step never runs, so it reports no test at all, neither passed nor skipped, and the failed build step fails the job (spec "Helper build failure fails the Windows check"). The Linux `integration` job runs the same file, which skips with its `[windows-only: …]` reason.

`workflow-policy.test.ts` gains two checks:
- the new steps exist with those conditions;
- `git ls-files` has no `*.exe`, `*.dll`, or `*.pdb` under `src/main/platform/windows/` or `out-helper/` (spec "No committed helper binary").

No Electron is launched in this job, so `electron: "false"` stays.

### D9. Review workflow

As in the foundation design (D15), each task group ends with its verification commands and a hand-off to the `reviewer2` session, which receives the change name, group, changed files, acceptance criteria, and command output. Findings are then fixed and re-reviewed, and the outcome is recorded in `tasks.md` before the next group starts.

## Risks / Trade-offs

- [The new delta scenarios count in `npm run spec-coverage` as soon as they are committed, so a pull request with only these planning artifacts fails `verify`] → The artifacts are committed together with group 1, which adds the tagged test titles (implemented, or `it.todo` with the tag where the behavior lands in a later group). No group's pull request leaves a scenario unmapped.
- [An unsigned helper `.exe` started from the user data or app directory may be flagged by antivirus or SmartScreen] → It is not reachable from the app until W2, and W4 decides signing (G-6). The risk is recorded in `docs/deferred-checks.md`.
- [`csc.exe` of .NET Framework is in maintenance and could leave a future Windows image] → The build fails loudly in CI (D8). The C# 5 source has no runtime dependency beyond .NET Framework 4.8, which ships with every supported Windows.
- [Another local process connects to the control pipe first] → The pipe name is random, only one connection is accepted, and it is accepted only with the one-time token. The token goes to the helper's stdin, never on a command line. Pipes are local-only (`\\.\pipe`). The helper ignores any message before the token handshake.
- [A command that detaches its own console or calls `FreeConsole` does not receive Ctrl+Break] → If no live process of the command is left on its console, the helper finds nothing to attach to, skips the graceful wait, and ends the job at once (D3, "When no event can be sent"). If other processes of the command are still on the console, the event goes to them, and the detached process is ended by the job at the stop timeout. Either way the stop is reported as forced.
- [The CI runner always runs inside a job (`ctx-job` unknown), so nested-job behavior is all the tests see] → The docs keep "a parent outside any Job Object, as when started from Explorer" in the not-verifiable list. W4's smoke test on the packaged app is the next evidence.
- [One extra process per running command] → The helper is small and idle while it waits on the completion port. The docs mention it.
- [Integration tests that enumerate processes with PowerShell are slow] → Each call is batched once per assertion point. Scenarios run 5 times by default, and 50 times only with `VEYDR_STRESS=1`.

## Migration Plan

There is no data or configuration migration, and the ledger format is unchanged (`version: 1`; Windows tokens are strings like Linux ones). Rollout is through the normal pull requests, one per task group. Rollback is a revert: the Windows platform becomes the unsupported stub again, and no user-visible behavior changes, because starting a command on Windows fails before and after.
