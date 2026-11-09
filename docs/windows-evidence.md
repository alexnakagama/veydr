# Windows evidence

Windows is a **preview**: run from source, verified in CI on Windows Server 2025, with no Windows package yet (see the [README](../README.md#platform-support)). This document records what the `windows-probe.yml` workflow observed on the `windows-2025` GitHub Actions runner, what it cannot observe there, and the decisions the Windows platform work (W1–W4) takes from it. It is evidence for that work, not a support statement. How the probes work, and how a run becomes evidence, is in [ci.md](ci.md#windows-probes).

## Recorded run

| | |
|---|---|
| Run | [Windows probe run 41657147660](https://github.com/alexnakagama/veydr/actions/runs/41657147660), 2026-11-03, not a negative-control run |
| Commit | `901fa06d4ec23ea7e423475a5594edd04cabc9ef` (`master`, after group 7 was merged) |
| Runner image | `win25-vs2026` 20261030.294.1, Windows build 10.0.26100.33674, Node v24.22.2, for all eight probe areas |
| Recorded files | [`test/windows-probe/summary.txt`](../test/windows-probe/summary.txt) (one line per check) and `test/windows-probe/results/<area>.jsonl` (the probes' raw answers, with `data`) |
| Totals | 94 `PASS`, 32 `EXPECTED-FAIL`, 2 `FAIL`, 8 `NOT-TESTABLE` |
| Stability | [Run 41662139747](https://github.com/alexnakagama/veydr/actions/runs/41662139747), the same commit on the same image, gave the same status for all 136 checks. Only per-VM identifiers and measured values differed (PIDs, ports, window handles, timestamps, durations), and every duration stayed within its threshold. |

Each check is a yes/no question with a predicted answer. `PASS` means the answer is yes; `EXPECTED-FAIL` means no, as predicted; `FAIL` means no where yes was predicted, so the prediction was wrong; `NOT-TESTABLE` means no answer could be obtained. A predicted `no` that was answered yes shows as `PASS`, so those surprises are listed below too. The questions and predictions are in `scripts/windows-probe/checks.mjs`.

Unless a check's name ends in `-std`, it ran as the runner's administrator. The `-std` checks ran as a temporary standard user, `veydr-probe`. Every probe driver ran without a console, as Veydr's main process does.

- `ctx-no-console` is `PASS` for all 12 drivers: 8 as administrator and 4 as the standard user.
- `ctx-standard-user` is `PASS` in all four areas that use the standard user: its token is unelevated, it is not in Administrators, and its registry hive is loaded.
- `ctx-electron-no-console` is `PASS`: Electron's own main process has no console either. So the probe drivers reproduce the context Veydr runs in.

`test/unit/windows-evidence.test.ts` keeps this document consistent with the recorded files. It regenerates the summary from the raw results, too.

## Predictions

The predictions were committed before any probe ran: `test/windows-probe/predictions.json` was added in `466724865c9388680c58efeb607b8067e9fa23d9` and merged to `master` in `e346b0475fbbdd58db873375ac61e6c3efb37c50` ([#12](https://github.com/alexnakagama/veydr/pull/12), 2026-10-29). No prediction or question has changed since: `REVISIONS` is empty in `checks.mjs`, so no line of the summary is marked `[revised]`.

## Verified on the runner

### Predictions that did not hold

| Check | Predicted | Observed |
|---|---|---|
| `enc-child-cmd-utf8` (`FAIL`) | `cmd /c` writes UTF-8 after `chcp 65001` | The `echo` on the same `/c` line as `chcp` still wrote code page 437. `chcp` did change the console (`chcpActiveCodePage` 65001), and a second cmd.exe started after it wrote correct UTF-8 (`nestedCmd`). Whether a later line of a batch file behaves the same was not measured. |
| `env-registry-std` (`FAIL`) | The logon environment equals the registry environment | Four variables differ. `USERNAME` is `SYSTEM` in the machine registry and set by logon, which was expected. `TEMP` and `TMP` hold the same directory, in its 8.3 short form only in the inherited value. `Path` has the same 72 entries in the same order and is one character shorter, most likely one `;`. Only names and value shapes are recorded, never values. |
| `pt-ctrl-break-attach-npm` and `pt-ctrl-break-attach-npm-std` (`PASS`, predicted `no`) | cmd.exe's "Terminate batch job (Y/N)?" prompt keeps the tree running | The prompt appears, but with stdin ignored, as the supervisor starts commands, it does not hold the tree: the script's handler ran and the whole tree ended within 5 s. |
| `port-ps-latency` (`PASS`, predicted `no`) | `Get-NetTCPConnection` calls take hundreds of milliseconds | As the standard user: median 89 ms, and the slowest 553 ms, which was the first call (it loads the module). Both are within the thresholds (300 ms median, 1 s slowest). The figures leave out PowerShell's own startup. |

### Context

- Every probe driver was inside a Job Object (`inJob` in `ctx-job`'s `data`), but `ctx-job` is `NOT-TESTABLE`. Windows PowerShell 5.1 started without a console wrote nothing, so `context.ps1` had to be started attached. That start put the driver into libuv's own job, which hides whether the runner also has a job of its own (see [Not verifiable](#not-verifiable-on-the-runner)).
- So every process-tree conclusion below was **measured inside a job**: libuv's, limits `0x3c00` (`KILL_ON_JOB_CLOSE`, `SILENT_BREAKAWAY_OK`, `BREAKAWAY_OK`, `DIE_ON_UNHANDLED_EXCEPTION`), from `pt-libuv-job`. Veydr's main process is in the same situation after it starts its first child (`driverInLibuvJob`).

### Process trees

| Conclusion | Checks | Holds for |
|---|---|---|
| A child started with `child_process.spawn` is in libuv's job, with the limits above. | `pt-libuv-job` | administrator |
| A grandchild started with `CREATE_BREAKAWAY_FROM_JOB` leaves that job. A plain grandchild is outside it too, since `SILENT_BREAKAWAY_OK` is set. | `pt-libuv-breakaway` | administrator |
| Every stop method (`TerminateProcess`, `taskkill /F`, `TerminateJobObject`) ends a single plain child. | `pt-control`, `pt-control-std` | both |
| `child.kill()` ends the leader, a Node process, and its descendants still connected to it, but an orphaned grandchild keeps running. | `pt-kill-leader` | administrator |
| `taskkill /T /F` on a live leader ends every descendant still connected to it. It misses a grandchild whose parent had already exited. | `pt-taskkill-tree`, `pt-taskkill-orphan` | administrator |
| A Job Object assigned right after spawn contains every later descendant, orphans included, and `TerminateJobObject` ends them all. | `pt-job-terminate`, `pt-job-terminate-std` | both |
| A grandchild created between spawn and job assignment stays outside the job. Starting the leader suspended, assigning it, then resuming it closes that gap (`closesTheGap` in `data`). | `pt-job-race` | administrator |
| When the spawning process is killed, as a crash would end Veydr, its direct children end with libuv's job. That is true for both a Node leader and a `cmd.exe` leader. A grandchild started by the `cmd.exe` leader keeps running. A Node leader's grandchild ends with that leader's own libuv job. | `pt-parent-exit-leader`, `pt-parent-exit-descendant` | administrator |
| PID plus creation time (`GetProcessTimes`) is stable across reads. A reused PID came back with a different creation time: PID 3332 recurred after 240 short-lived processes, in 282 ms. | `pt-identity`, `pt-identity-reuse` | administrator |
| `windowsHide: true` gives a console child of the console-less parent a console with no visible window; without it, the window is visible. | `pt-console-window` | administrator |
| A compiled .NET Framework 4.8 helper (`csc.exe` 4.8.9221.0) can create a Job Object, start a child with a grandchild in it, and end both. | `helper-csc-build`, `helper-csc-build-std` | both |

### Graceful stop

| Conclusion | Checks | Holds for |
|---|---|---|
| `GenerateConsoleCtrlEvent` sent from the console-less parent does not reach a child: there is no shared console (error 6). | `pt-ctrl-break-direct` | administrator |
| A compiled helper that ignores console events, attaches to the child's console, and sends `CTRL_BREAK` stops a `node` child, an `npm run` child (through `npm.cmd`), and a `cmd /c` child gracefully. The child's handler runs, the whole tree ends within 5 s, and the driver receives no event. | `pt-ctrl-break-attach-node`, `pt-ctrl-break-attach-npm`, `pt-ctrl-break-attach-cmd` and their `-std` variants | both |
| A child started with `detached: true` has no console to attach to, so it cannot be stopped gracefully this way. | `pt-ctrl-break-detached` | administrator |
| Ctrl+C is ignored in a new process group: a baseline child with Ctrl+C allowed ran its handler, and the new-group child did not. | `pt-ctrl-c` | administrator |

### Commands

| Conclusion | Checks |
|---|---|
| Spawning a `.cmd` file without a shell is refused with `EINVAL` (CVE-2024-27980 hardening). | `cmd-direct-spawn` |
| Node's `shell: true` does not carry arguments safely through an `npm.cmd`-style shim. 18 of 28 corpus cases arrive changed, and in the `&`, `\|` and `>` cases the injected command ran. The failing cases are `cmd-route-shell-amp`, `cmd-route-shell-pipe`, `cmd-route-shell-gt`, `cmd-route-shell-lt`, `cmd-route-shell-quote-inject`, `cmd-route-shell-quote-embedded`, `cmd-route-shell-quote-unbalanced`, `cmd-route-shell-backslash-quote`, `cmd-route-shell-caret`, `cmd-route-shell-space`, `cmd-route-shell-tab`, `cmd-route-shell-empty`, `cmd-route-shell-percent-var`, `cmd-route-shell-percent-substitution`, `cmd-route-shell-percent-split`, `cmd-route-shell-newline`, `cmd-route-shell-carriage-return` and `cmd-route-shell-long`. All of them were predicted. | `cmd-route-shell-*` |
| `cmd.exe /d /v:off /s /c` with the quoting of `scripts/windows-probe/cmd-quote.mjs` carries every corpus case unchanged, with no injected command run. It refuses, before spawning, the three cases cmd.exe cannot carry: a line feed, a carriage return, and a line beyond 8191 characters. | `cmd-route-verbatim-*` |
| `npm` resolves to `npm.cmd` through `PATH` and `PATHEXT` (`.COM;.EXE;.BAT;.CMD;…`). | `cmd-pathext` |
| `cmd.exe /d /s /c npm` runs an `npm.cmd` from the working directory before the one on `PATH`. `NoDefaultCurrentDirectoryInExePath` was not set. | `cmd-pathext-cwd` |

### Environment

| Conclusion | Checks | Holds for |
|---|---|---|
| The environment a process inherits is not exactly the registry environment. As administrator, the job's own additions also differ: 2 more `Path` entries, 1 more `PATHEXT` entry, and 3 more `PSModulePath` entries, each appended after the registry's entries, in order. As the standard user only the logon differences of `env-registry-std` remain (see above). | `env-registry`, `env-registry-std` | both, with different detail |
| A child given an environment whose only path variable is spelled `PATH` sees exactly one path variable, with that value. Given both `Path` and `PATH`, the child saw only `PATH`'s value. | `env-path-case` | administrator |

### Encoding

| Conclusion | Checks |
|---|---|
| A console child of the console-less parent gets output code page 437, not UTF-8. `GetACP` is 1252 and `GetOEMCP` is 437, with or without `windowsHide`. | `enc-codepages` |
| `cmd /c echo` writes code page 437, not UTF-8, with or without `chcp 65001` on the same line (see above). | `enc-child-cmd-plain`, `enc-child-cmd-utf8` |
| Node writes UTF-8 to a pipe with no setting. | `enc-child-node-plain`, `enc-child-node-utf8` |
| Python 3.12.10 fails with `UnicodeEncodeError` (cp1252) on a pipe without a setting. With `PYTHONUTF8=1` it writes UTF-8. | `enc-child-python-plain`, `enc-child-python-utf8` |

### Ports

| Conclusion | Checks | Holds for |
|---|---|---|
| `netstat -ano`, `Get-NetTCPConnection` and `GetExtendedTcpTable` each list the probe's listeners on `127.0.0.1`, `::1` and `0.0.0.0` with its PID. `netstat` ran as administrator only. | `port-control`, `port-control-std`, `port-netstat`, `port-ps`, `port-ps-std`, `port-api`, `port-api-std` | both |
| `GetExtendedTcpTable` (IPv4 and IPv6 tables) takes a median of 0.4 ms and at most 7.1 ms per call. `Get-NetTCPConnection` is within the thresholds too (see above). | `port-api-latency`, `port-ps-latency` | standard user |
| An administrator can read the name and creation time of every listener's owner (15). A standard user can read every name, but the creation time of only 1 owner, its own listener. It was denied for the other 14, among them System, lsass, services and svchost. | `port-owner-identity`, `port-owner-identity-std` | different |

### Electron and installer

| Conclusion | Checks |
|---|---|
| The built app starts on the runner and prints its `--smoke-test` report on a pipe. Every smoke check passes except the platform check, which fails as predicted because Windows has no platform implementation. The overall exit code is therefore 1. | `electron-launch`, `electron-smoke-*`, `electron-smoke-platform` |
| A minimal Playwright spec, `test/windows-probe/launch.spec.ts`, launches the app and sees the unsupported-platform state. | `electron-playwright` |
| electron-builder builds a per-user, one-click NSIS installer (112.5 MB) from command-line options, without changing `electron-builder.yml`. | `nsis-build` |
| A silent install to `%LOCALAPPDATA%\Programs\veydr`, a `--smoke-test` launch of the installed app, and a silent uninstall work. The report and exit code of the GUI-subsystem executable are readable on a pipe. The installed app passes every smoke check except the platform check, including `nsis-smoke-devtools-disabled`. | `nsis-install`, `nsis-smoke-*`, `nsis-smoke-platform` |

### Admin and standard-user differences

Only two checks answered differently for the two accounts:

- `port-owner-identity`: an administrator can open other users' processes, and a standard user cannot.
- `env-registry`: the administrator's driver inherits the job's own additions, and the standard user's does not.

`env-registry` and `env-registry-std` also have different statuses, `EXPECTED-FAIL` and `FAIL`, because their predictions differ: administrator `no`, standard user `yes`. Every other check that ran for both accounts gave the same answer.

## Not verifiable on the runner

The runner cannot show these. Each is `NOT-TESTABLE` in every run, and what would verify it is listed.

| Check | Why not | What would verify it |
|---|---|---|
| `env-desktop-launch` | The runner has no interactive desktop session, so no app can be started from Explorer. | start Veydr from Explorer on a Windows 10/11 desktop and compare its environment with the registry environment |
| `pt-logoff` | A runner job cannot log off its user or shut Windows down and observe the result. | log off, and shut down, a Windows 10/11 desktop with commands running in Veydr, then check that none survive |
| `ux-uac-prompt` | UAC elevation prompts need an interactive desktop. Running as a standard user is covered by the `-std` checks. | run Veydr as a standard user on a Windows 10/11 desktop and start a command that requests elevation |
| `l10n-console` | The runner image is English only. | repeat the encoding and port probes on a localized Windows install (e.g. Japanese or German) |
| `av-third-party` | The runner has Microsoft Defender only. | install and run Veydr on a machine with third-party antivirus |
| `smartscreen` | SmartScreen prompts for downloaded files on an interactive desktop, which the runner lacks. | download the unsigned installer with a browser on a Windows 10/11 desktop and run it |
| `ctx-job` | The probe driver ends up in libuv's job, which hides whether the runner runs steps in a job of its own (see [Context](#context)). So nothing was measured under a parent outside every Job Object, as when Veydr is started from Explorer. | run the process-tree probes from a parent outside any Job Object (started from Explorer on a Windows 10/11 desktop), or read the runner's job from a compiled helper started without a console |
| `ffi-koffi-electron` | Not approved: the maintainer did not approve installing `koffi` under gate G-4 (design D6). | the koffi load check of design D6, after approval |

Windows 10/11 desktop behavior in general (console host, Defender policy, installed tools) is outside this evidence. The preview statement W4 ships names Windows Server 2025 for that reason.

## Decisions

These apply the decision rules of the `assess-windows-platform` design (D5), which were fixed before any probe ran. The same outcome is recorded in that change's `design.md`.

### Process trees (W1, G-4)

**Option C: a Job Object through a small helper executable**, built from C# with the .NET Framework 4.8 `csc.exe`.

- A job is needed. `pt-taskkill-orphan` is `EXPECTED-FAIL`: `taskkill /T /F` lets an orphan escape. `pt-job-terminate` and `pt-job-terminate-std` are `PASS`: a job contains every descendant. So option A (forced-only `taskkill`) is ruled out.
- Option B (koffi) cannot be chosen: `ffi-koffi-electron` is `NOT-TESTABLE` because it was not approved.
- `helper-csc-build` and `helper-csc-build-std` are `PASS`, so the .NET Framework route works for both accounts.

The helper must also start each command itself, suspended, and assign it to the job before resuming it. `pt-job-race` is `EXPECTED-FAIL`: a grandchild created before the assignment escapes. The suspended start closed that gap, and Node cannot request `CREATE_SUSPENDED`.

### Graceful stop (W1)

**Graceful stop through the attaching helper, then the forced stop.**

- `pt-ctrl-break-direct` is `EXPECTED-FAIL`, so Veydr cannot send `CTRL_BREAK` itself.
- `pt-ctrl-break-attach-node`, `pt-ctrl-break-attach-npm`, `pt-ctrl-break-attach-node-std` and `pt-ctrl-break-attach-npm-std` are `PASS`, so the helper route applies to commands started through a batch file too. `pt-ctrl-break-attach-cmd` and `pt-ctrl-break-attach-cmd-std` are `PASS` as well.
- The attaching must happen in the option C helper, never in Electron's process.
- `pt-ctrl-break-detached` is `EXPECTED-FAIL`, so W1 starts commands with `windowsHide: true` and not detached. `pt-console-window` is `PASS`, so no console window appears.
- `pt-ctrl-c` is `PASS`, so the event is `CTRL_BREAK`, never Ctrl+C.

### Crash recovery (W1)

**Survivors are found from the run ledger, as on Linux.**

- `pt-parent-exit-descendant` is `PASS`: a descendant can outlive Veydr after a crash, and may still hold a port.
- `pt-parent-exit-leader` is `EXPECTED-FAIL`: when the parent was killed, its direct children ended with libuv's job.

That leader result was measured with children started by Node. With option C the commands run in the helper's job, so W1 must verify in its own Windows CI what a crash of Veydr, or of the helper, does to them. The orderly quit path still stops commands itself.

Process identity across that recovery is PID plus creation time. `pt-identity` and `pt-identity-reuse` are `PASS`.

### Shell mode (W2)

**The verbatim route: `cmd.exe /d /v:off /s /c` with the quoting of `cmd-quote.mjs`, adopted unchanged.** Every `cmd-route-verbatim-*` check is `PASS`. W2 rejects the inputs it refuses, which are `cmd-route-verbatim-newline`, `cmd-route-verbatim-carriage-return` and `cmd-route-verbatim-long`: a line break or NUL in an argument, or a line beyond 8191 characters. Node's `shell: true` is not used, since `cmd-route-shell-amp`, `cmd-route-shell-pipe` and others run injected commands.

**Resolved in W2** (OpenSpec change add-windows-environment-and-commands): batch files and shell-mode scripts run through this route, with the refusals above, as [commands.md](commands.md#batch-files) describes.

Further findings W2 must handle, outside the D5 rules:

- `cmd-pathext-cwd` is `EXPECTED-FAIL`: cmd.exe prefers a command file in the working directory to the one on `PATH`. W2 must resolve the program through `PATH` and `PATHEXT` itself (`cmd-pathext`) and pass cmd.exe an absolute path. Setting `NoDefaultCurrentDirectoryInExePath` was not measured, so W2 cannot rely on it without its own evidence. **Resolved in W2:** Veydr looks the program up in `Path` with `PATHEXT` itself, never in the working directory, and passes cmd.exe the full path ([commands.md](commands.md#finding-the-program)).
- `cmd-direct-spawn` is `PASS`: a `.cmd` file can only be started through cmd.exe.
- Child output is not reliably UTF-8. `enc-codepages` and `enc-child-cmd-utf8` show code page 437, and `enc-child-python-plain` shows cp1252, while `enc-child-node-plain` is UTF-8. W2 decides how logs decode output that is not UTF-8. **Resolved in W2:** each command's console is set to UTF-8, and a line that is still not UTF-8 is decoded with the ANSI code page ([logs.md](logs.md#windows-preview)). OEM bytes written straight to a pipe stay unresolved, as documented there.
- The registry environment does not reproduce the logon environment exactly (`env-registry-std`), and a desktop launch could not be observed (`env-desktop-launch`). **Resolved in W2** by not reading the registry: commands get the environment Veydr inherited ([commands.md](commands.md#environment-1)). A desktop launch's environment stays unverified ([processes.md](processes.md#not-verified-on-the-ci-runner)).

### Ports (W3)

**`GetExtendedTcpTable`, through the option C helper.** W1 chose a native route and `port-api-std` is `PASS`, with `port-api-latency` far below the threshold. `Get-NetTCPConnection` would also qualify (`port-ps-std` and `port-ps-latency` are `PASS`), but it is not needed. `netstat -ano` text parsing is not used.

`port-owner-identity-std` is `EXPECTED-FAIL`: a standard user cannot read the creation time of other users' processes. So W3 shows those owners as restricted, as the Linux view already does, and identifies only Veydr's own processes by PID and creation time.

### Electron in Windows CI (W1–W4)

**The Windows CI lane can run Electron under Playwright.** `electron-launch`, `electron-playwright` and `ctx-electron-no-console` are `PASS`, and every `electron-smoke-*` check passes except `electron-smoke-platform`, as predicted. The existing e2e harness depends on Linux `/proc` helpers, so it must be made portable before e2e tests can run on Windows. W1 did not take this on: commands cannot be started on Windows until W2, so W2 makes the harness portable.

W4 can build and install a per-user NSIS installer on the runner: `nsis-build` and `nsis-install` are `PASS`. Its signing and SmartScreen behavior stay unverified (`smartscreen`).
