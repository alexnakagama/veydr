# Tasks

Notes:

- On Windows the Ports view keeps saying that port inspection is not yet available until group 5. That group switches the platform composition, the e2e specs and the docs together, so no earlier pull request claims more than it delivers.
- Every group ends the way foundation design D15 requires:
  1. run its verification commands;
  2. hand off to the `reviewer2` session;
  3. fix the findings, and have them re-reviewed;
  4. record the outcome here.
- These planning artifacts are committed together with group 1, which tags every new scenario, so `npm run spec-coverage` stays at zero unmapped.
- Windows behavior counts as verified only from the `windows` CI job on the pull request, never from Linux runs.
- No npm dependency is added, `electron-builder.yml` is unchanged, and no helper binary is committed.

Plan re-review (2026-11-09): reviewer2 approved, with 0 high, 0 medium, 4 low and 2 nits. All are folded in:
- low:
  - the standard-user driver is built on `driverMain`/`runDriver`, the test creates the results file first, and the driver stays out of the probe-area registries;
  - task 2.4 waits 100 ms;
  - the `-Helper` name check is case-sensitive and requires a regular file;
  - the C# check strips verbatim, interpolated and char literals, with a brace-in-string negative fixture.
- nits:
  - the spec says "MAY end the helper, and only when…";
  - the doc and e2e tests that mention "not yet available" are named in task 5.2.

Plan review (2026-11-09): reviewer2 found 2 high, 7 medium, 4 low and 3 nits in the first draft. All are folded into the proposal, the design, the specs and the tasks below.
- high:
  - `imageName` lived in `helper-client.ts`, outside what the read-only check lets `windows/ports.ts` reach. It moves to `identity.ts` (task 1.2), and the closure of `ports.ts` is stated.
  - `ports.spec.ts` test 2 counted listings through `/proc` reads and asserted `node PID`. A helper-call counter and a portable executable name are added (task 5.3).
- medium:
  - the helper uses `PROCESS_QUERY_LIMITED_INFORMATION` only, with liveness from `GetExitCodeProcess` and `GetProcessTimes`, since protected processes may refuse `SYNCHRONIZE`;
  - the fence has a 20 ms margin for the coarser creation-time clock, and the tests wait 100 ms;
  - PID 0 rows are accepted and shown as unknown, so one odd row cannot fail the listing;
  - the read-only spec text now excepts the helper, for its time or output limit, and the scenario tag sits on the test that covers both halves;
  - the standard-user run is a validated `-Helper` parameter plus a driver, with a `ctx-standard-user` control, the result fed through the inspector, and no fixed system port;
  - the CI gate is an outer platform guard and an inner `CI` guard that fails rather than skips, and the workflow policy keeps `CI` from being overridden;
  - the C# source check uses brace matching, a class allowlist and a `Native` member allowlist, with negative tests.
- low and nits:
  - the version check's `SpawnError` is wrapped in a plain `Error`;
  - the output limit is justified correctly and checked by `parsePortsOutput`;
  - the reasoning about the REMOVED requirement's placeholder is corrected;
  - the forbidden-module pattern matches imports without `node:`;
  - a missing verb in the proposal;
  - the clock-change risk is restated against the margin;
  - `takenAt` is converted with BigInt.

## 1. Shared pieces and scenario mapping

- [x] 1.1 Move `formatIpv4` and `formatIpv6` from `src/main/platform/linux/net.ts` to `src/main/platform/address.ts` as exported functions over network-order bytes (design D5). `parseNetTcp` keeps its byte-order handling and calls them. Verify: the existing `linux-ports` and `linux-net` unit tests pass unchanged, and a new `test/unit/address.test.ts` covers IPv4, compressed IPv6, `::`, `::1` and an IPv4-mapped address.
- [x] 1.2 Move `runHelperTool`, `runHelperVersion` and the cached version check out of `src/main/platform/windows/process-tree.ts` into a new `windows/helper-tool.ts` (design D6). The check becomes `createHelperCheck(helperPath, readVersion)`, and `runHelperTool` gains an optional `maxOutputBytes` that defaults to `MAX_TOOL_OUTPUT_BYTES`. The process tree takes the check as an option and behaves exactly as before. Move `imageName` from `helper-client.ts` to `identity.ts` and re-import it there (design D4); `procInfo` stays. Verify: the existing `windows-process-tree` unit tests pass with only import changes, and `windows-process-tree.test.ts` and `windows-commands.test.ts` pass in the `windows` CI job.
- [x] 1.3 Map every new scenario of this change with one tagged `it.todo` per scenario, in the file where its test will live (design D7):
  - `windows-ports.test.ts` (integration) for command-port, unmanaged, standard-user and verified-natively;
  - `test/unit/windows-ports.test.ts` for the reused PID;
  - `port-service.test.ts` for `windows-inspection-queries-only`.

  `ports-on-windows` needs no placeholder: `spec-coverage.mjs` exempts a REMOVED requirement while the change is active. Its test stays until group 5 because the behavior stays until then. Verify: `npm run spec-coverage` reports zero unmapped scenarios, `test-platform-policy.test.ts` passes, and `openspec validate add-windows-port-inspection --strict` passes.
- [x] 1.4 Hand off group 1 to `reviewer2`, fix the findings, have them re-reviewed, and record the outcome below this group.

Group 1 review (2026-11-10): reviewer2 approved, with 0 high, 0 medium, 2 low, 1 nit and 1 suggestion. All are fixed, and the re-review confirmed them:
- low:
  - the `runHelperTool` limit test covers 0, -1, 1.5, NaN and Infinity for both options;
  - the `runHelperTool` JSDoc says it kills only the child it spawned, not its descendants.
- nit: the `imageName` JSDoc says a bare name is returned unchanged.
- suggestion: task 3.3 also walks `helper-tool.ts`'s import closure.
- deviation, accepted: the `ports-on-windows` tag was dropped from `renderer-ports.test.ts` (its requirement is REMOVED, and spec-coverage failed on it as unknown); task 5.2 deletes or rewrites that test.

Verified on Linux: typecheck, lint, `npm test` (1304 passed, 7 skipped, 2 todo), the `linux-ports` integration test, `npm run spec-coverage` (171/171) and `openspec validate --strict`. The `windows` CI job runs on the pull request.

## 2. The helper's `ports` subcommand and protocol version 3

- [x] 2.1 In `veydr-helper.cs`, add a `PortsCommand` class and `veydr-helper.exe ports` (design D1):
  - the `t0` fence;
  - both `GetExtendedTcpTable` reads, with the bounded buffer retry;
  - one toolhelp snapshot for names;
  - PID 0 reported as `gone` without opening anything;
  - one `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` per other distinct PID, with liveness from `GetExitCodeProcess` and `GetProcessTimes`, the 20 ms fence margin, and the `known`, `restricted`, `gone`, `reused` and `error` rules;
  - one JSON line on stdout, exit code 0. A failure is described on stderr with exit code 1, and wrong arguments give exit code 2.

  Set `ProtocolVersion = 3`, extend `Usage` and the file header, and add the P/Invoke declarations to `Native`. Verify: `node scripts/build-windows-helper.mjs` compiles it in the `windows` CI job, and task 2.3's tests pass.
- [x] 2.2 In `protocol.ts` (design D2):
  - set `PROTOCOL_VERSION = 3`;
  - add the strict `ports` schema (PID 0 allowed), `parsePortsOutput`, which checks against `MAX_PORTS_OUTPUT_BYTES` (16 MiB) rather than `MAX_LINE_BYTES`;
  - require each listener's PID to have exactly one owner entry, and every owner to have a listener.

  Verify with unit tests on every system: a valid line; a PID 0 listener; each malformed field (hex length, port 0 and 65536, an unknown state, a non-canonical FILETIME); a missing or extra owner; two lines; no final newline; a line over 1 MiB accepted and one over 16 MiB refused; a version 2 helper refused with a message that names both versions.
- [x] 2.3 Add the C# source check of design D6 to `port-service.test.ts`: brace-matched class body with comments and strings stripped, forbidden calls and `SYNCHRONIZE`, the class allowlist, the `Native` member allowlist, and `OpenProcess` with exactly `Native.PROCESS_QUERY_LIMITED_INFORMATION`. Strip regular, verbatim and char literals; fail on any interpolated string. Verify: the test passes on the real file, and its negative cases fail on fixture strings (a `SurvivorCommands` call, `| SYNCHRONIZE`, a forbidden call next to a comment, and a `}` inside a string and a char literal followed by a forbidden call). The scenario tag is placed in task 3.3, which completes both halves.
- [x] 2.4 Add a Windows-only integration case that runs the real helper's `ports` while a fixture listens on `127.0.0.1` and `::1`, once the fixture is at least 100 ms old (design D7). It parses the output with `parsePortsOutput` and finds both listeners, owned by the fixture's PID with its creation time. Verify: it passes in the `windows` CI job.
- [x] 2.5 Docs: in `docs/dependencies.md`, add protocol version 3 and the `ports` subcommand, and mark "W3 adds `ports`" as done. Verify: the section names version 3 and the subcommand.
- [x] 2.6 Hand off group 2 to `reviewer2`, fix the findings, have them re-reviewed, and record the outcome below this group.

Group 2 review (2026-11-10): reviewer2 found 0 high, 1 medium, 5 low and 2 nits. All are fixed, and the re-review approved them with no new findings:
- medium: the integration case that leaves stdin open waits for `close`, not `exit`, so stdout is read to its end.
- low:
  - the helper caps a table at 16 MiB and stops once its line passes 16 MiB − 1 bytes, instead of building a line Veydr would refuse;
  - the 2.4 case fails fast when the fixture exits before listening, and compares the image through `realpathSync.native`;
  - `parsePortsOutput` refuses an `error` code of 0 (the helper reports a codeless failure as `ERROR_INVALID_DATA`) and a `known` owner inside the fence margin (`FENCE_MARGIN`);
  - an IPv6 table that cannot be read (`ERROR_NOT_SUPPORTED`) still fails the listing, as design D1 says, and the docs say so;
  - the C# source check also forbids `Assembly`, `AppDomain`, `GetMethods`, `GetFunctionPointerForDelegate` and a reflection `using`, requires `OpenProcess` with `false` for inherit, and pins each allowed call's library.
- nits: two comments rewrapped.
- deviation, accepted: the helper drops table rows with port 0, as it keeps PID 0 as `gone`; design D1 and D2 and `docs/dependencies.md` say so. Also added: an error names at most 5 schema issues.

Verified on Linux: typecheck, lint, `npm test` (1339 passed, 7 skipped, 2 todo), the `linux-ports` integration test, `npm run spec-coverage` (171/171) and `openspec validate --strict`. The helper's compile and task 2.4 are verified only by the `windows` CI job on the pull request.

## 3. The Windows port inspector

- [x] 3.1 Add `src/main/platform/windows/ports.ts` with `createWindowsPortInspector({ readPorts, log? })` (design D4):
  - map the owners, with names from `imageName` (now in `identity.ts`), else `PID <n>`, and PID 0 to unknown;
  - convert `takenAt` from FILETIME to milliseconds with BigInt;
  - sort as on Linux;
  - log `ports.owner-errors` once per listing;
  - reject a failed or malformed read with an `Error` naming the helper.

  Verify with `test/unit/windows-ports.test.ts` on every system, covering:
  - known, restricted, gone, PID 0, reused (tagged `[spec:port-inspection/reused-pid-not-shown-as-owner]`, replacing its `it.todo`) and error owners;
  - an empty image;
  - IPv4 and IPv6 addresses through `address.ts`;
  - `takenAt` against a known FILETIME value, the sort order, and the logged error count.
- [x] 3.2 Add `createHelperPortsReader` to `helper-tool.ts`, with `PORTS_TIMEOUT_MS = 10_000` (design D6). Verify with unit tests using a fake `spawnHelper`:
  - the arguments are exactly `['ports']`;
  - stdin is closed empty;
  - a timeout kills only that child and rejects;
  - an exit code other than 0, output over 16 MiB, or a stale version rejects with a plain `Error` (not a `SpawnError`) naming the helper.
- [x] 3.3 Extend the read-only test (design D6): add `windows/ports.ts` to the entries, forbid it from reaching `helper-tool`, `helper-client` and `process-tree`, make the forbidden-module pattern match without the `node:` prefix, and check that `createHelperPortsReader` passes only `['ports']`. Together with 2.3, this test carries `[spec:port-inspection/windows-inspection-queries-only]` and replaces its `it.todo`. Verify: the test passes, and fails when `windows/ports.ts` temporarily imports `node:child_process` or `child_process`. Also walk `helper-tool.ts`'s import closure (group 1 review), so that a value import of `helper-client` there cannot slip in unnoticed.
- [x] 3.4 Hand off group 3 to `reviewer2`, fix the findings, have them re-reviewed, and record the outcome below this group.

Group 3 review (2026-11-10): reviewer2 approved, with 0 high, 0 medium, 2 low and 3 nits. The re-review approved the fixes with no new findings:
- low:
  - the helper check does not pin the binary (a file swapped after the check runs unchecked, as in the process tree): the `createHelperPortsReader` JSDoc says so;
  - helper stderr in the error message: withdrawn, since the IPC layer (`register.ts`) shows a plain `Error` to the renderer only as "Internal error" and logs the message locally, as on Linux.
- nits:
  - `filetimeToUnixMs` refuses anything but a canonical FILETIME with a `RangeError`, and states it;
  - a test that nothing is logged without `error` owners;
  - declined: the inspector's prefix on a read failure stays, because task 3.1 requires the inspector itself to name the helper whatever reader it is given.
- addition: the read-only test also forbids `require()`, `import()` and native bindings in the closure, follows imports in either quote style, and checks that `windows/index.ts` can wire the inspector only to `createHelperPortsReader` (task 5.1 completes it).

Verified on Linux: typecheck, lint, `npm test` (1377 passed, 7 skipped), `npm run spec-coverage` (171/171) and `openspec validate --strict`. The read-only test fails when `windows/ports.ts` imports `node:child_process`, `child_process` or `./helper-tool`, when `helper-tool.ts` imports `helper-client` by value, and when the reader passes an extra argument. Group 3 runs nothing Windows-specific; the `windows` CI job runs on the pull request.

CI on the pull request (#52): the `windows` job failed once in `logs.spec.ts` (`pause-following`), outside this change: the scroll event of the log view's own scroll to the end could be handled after Pause and resume following. `LogView` now ignores a scroll event at the position it scrolled itself to (`scrollChange`, unit-tested). The rerun failed in `processes.spec.ts`, also outside this change: a fixture got PID 728, the long-exited parent of `csrss.exe` and `wininit.exe`, and the test helper took them for its unreadable children. `taggedFromRows` now counts a process as a tagged one's child only if it was not created before it (unit-tested).

## 4. Native verification

- [x] 4.1 Add the optional `-Helper <path>` parameter to the Run mode of `scripts/windows-probe/standard-user.ps1` (design D7). It must be fully qualified, an existing regular file, and named exactly `veydr-helper.exe` (case-sensitive `-cne`). It is checked before the account exists and copied next to the drivers. Add the driver `scripts/windows-probe/ports-standard-user.mjs` on `driverMain`/`runDriver`, which reports the `ctx-*` lines (including `ctx-standard-user`), handles `--unavailable`, runs `veydr-helper.exe ports` from its own directory, and writes the exit code and stdout line as result lines. It stays out of `checks.mjs`, `summary.mjs` and the probe-area lists. The existing modes are unchanged. Verify: `windows-probe-launch.test.ts` and `windows-probe-jobs.test.ts` pass, extended by static tests that:
  - reject a `-Helper` with another file name, `VEYDR-HELPER.EXE`, a relative path, or extra driver arguments;
  - confirm the driver is in no probe-area registry.
- [x] 4.2 Write `test/integration/windows-ports.test.ts` (`describe.runIf(process.platform === 'win32')`, `[windows-only: …]` reasons), through the real helper and supervisor and `createHelperPortsReader`, replacing the group 1 `it.todo`s:
  - a command's and a grandchild's listeners are attributed (`command-port-shown-on-windows`);
  - unmanaged listeners on `127.0.0.1` and `::1` (`unmanaged-listener-on-windows`);
  - the 1,000-socket latency check: median under 500 ms, figures printed;
  - the standard-user case (`owner-hidden-from-a-standard-user-on-windows`, `windows-port-inspection-verified-natively`):
    - the outer `describe.runIf` for Windows, and an inner `it.skipIf(process.env.CI !== 'true')`;
    - the results file is created before the launcher runs, as `windows-probe.yml` does;
    - every launcher failure, including an `--unavailable` result line, throws;
    - it asserts `ctx-standard-user`, the helper's exit code 0, the fixture's owner `restricted` through `createWindowsPortInspector`, and at least one other restricted listener.

  Every case waits until its fixtures are 100 ms old before listing. Also add a `workflow-policy.test.ts` assertion that the `windows` job neither sets nor overrides `CI`. Verify: all pass in the `windows` CI job, the job log shows the latency figures and the standard-user run, and `test-platform-policy.test.ts` accepts the guards.
- [x] 4.3 Hand off group 4 to `reviewer2`, fix the findings, have them re-reviewed, and record the outcome below this group.

Group 4 review (2026-11-10): reviewer2 found 0 high, 0 medium, 2 low and 3 nits. All are fixed, and the re-review accepted them with no new findings above nit:
- low:
  - `-Helper` refused only a link as the file itself: `Get-HelperProblem` now also refuses a link (junction, symbolic link or other reparse point) in any directory above it, with a Windows-only runtime case through a junction;
  - a launcher ended at its timeout could leave the account behind, and `ci.yml`'s `windows` job has no `-Cleanup` step: the standard-user test runs `-Cleanup` itself when the account is still there afterwards, and fails, naming the launch's own error too (a re-review suggestion).
- nits:
  - the helper's SHA-256 is taken when it is checked and compared with the copy, so a file replaced in between is refused;
  - the unavailable detail and the `-Cleanup` output go through the same filter as the launcher's output, so no `::` workflow command reaches the log;
  - the driver's header says its output line can be as long as the listing (16 MiB), and what reads the results file accepts that.
- deviations, accepted:
  - `runDriver` takes an optional `catalog` (`{ areas, checks }`, the probe catalog by default), so the driver keeps its own area and two result IDs outside `checks.mjs`, `summary.mjs` and the probe-area lists while being built on `driverMain`/`runDriver`;
  - the driver allows the helper 30 s, not `PORTS_TIMEOUT_MS`, since a new account's first .NET start may be scanned; it records the time it took;
  - the standard-user test does not assert that `C:\veydr-probe-std` is gone, since the launcher only warns when it cannot remove it.

Verified on Linux: typecheck, lint, `npm test` (1391 passed, 8 skipped), `npm run spec-coverage` (171/171), `openspec validate --strict`, and no `it.todo` of this change left. The Windows-only cases (the `-Helper` runtime checks, the integration cases, the latency figures and the standard-user run) are verified only by the `windows` CI job on the pull request.

CI on the pull request (#53): the `windows` job failed in the unit and integration steps. `standard-user.ps1` hashed `-Helper` with `Get-FileHash`, a script function of `Microsoft.PowerShell.Utility`. The CI steps run in PowerShell 7, which puts its own module directories first in `PSModulePath`; the Windows PowerShell 5.1 it starts inherits them, so `Get-FileHash` could not be found and the run stopped before the account existed. The script now hashes with .NET (`Get-Sha256`), and a static test forbids `Get-FileHash`. The rerun failed one step later, in `ConvertTo-SecureString`: it loaded PowerShell 7's `Microsoft.PowerShell.Security`, whose type data clashes with Windows PowerShell's, so the standard user was reported unavailable (and the test failed rather than skipped, as intended). `windows-probe.yml` never met this, because pwsh removes its own module directories only when it starts `powershell.exe` directly, not through npm, node and vitest. `standard-user.ps1` now sets Windows PowerShell's own module path (Program Files' directory and the machine's `PSModulePath`) right after its preamble, without calling any cmdlet, and a static test pins that. The third run created the account and ran the helper as the standard user (`ctx-standard-user` passed, the account was removed), and found a wrong premise of design D7: the standard user could query the fixture started by the runner's account, so its owner was `known`, correctly, since restricted means the OS denies access. On the windows-2025 image a runner process is not hidden from another standard user. The test now gives that fixture a protected DACL that admits only SYSTEM, Administrators and the runner's account (`denyOtherAccounts` in `test/integration/support/windows.ts`), so its owner is one the user may not query, and asserts it restricted. It also starts a second fixture with the default DACL and logs what the standard user sees for it, which docs/ports.md (task 5.4) must reflect: that a standard user sees another account's processes as restricted only when their DACL denies it, as for system services. The rest of the job passed, including the latency check: a median of 63.8 ms for 1,045 listening sockets (helper start and both tables).

## 5. Ports on Windows, end to end

- [ ] 5.1 In `windows/index.ts`, replace `UNSUPPORTED_PORT_INSPECTOR` with `createWindowsPortInspector({ readPorts: createHelperPortsReader(...) })`, sharing the helper check with the process tree, and update the JSDoc and the helper's header (design D6, D8). Verify: `platform.test.ts` expects a working inspector on Windows (a fake reader), and the composition check of task 3.3 passes.
- [ ] 5.2 Remove the `UnsupportedPlatformError` branch from `runSmokeTest`'s platform check (design D8). Verify: `smoke.test.ts` covers the listed-ports detail and a failing inspector, and the renderer banner test still passes for the unsupported platform. `processes-docs.test.ts` and `accessibility.spec.ts` also mention "not yet available": update them together with the docs in 5.3 and 5.4, and confirm nothing in groups 1–4 changes that text. The renderer test `shows that port inspection is not yet available on Windows` lost its `ports-on-windows` tag in task 1.3 (the requirement is REMOVED); delete it here or rewrite it for a platform without an implementation, so it does not stay as an orphan asserting the old behavior.
- [ ] 5.3 End-to-end (design D7):
  - make `ports.spec.ts` portable, with only its restricted test kept as `[linux-only: another user's process]`;
  - extend `support/ports-probe.cjs` to log helper calls with arguments exactly `['ports']`, and add a support function that counts listings from either log, for test 2;
  - add a `test/support` function that gives the Node executable's display name from `process.execPath` (no platform branch), and use it in the name assertions of tests 1 and 2;
  - delete `windows-ports.spec.ts`, together with the scenario `ports-on-windows`;
  - update the classification table in `docs/ci.md`.

  Verify: the e2e suite passes in the Linux job and in the `windows` job, `test-platform-policy.test.ts` passes, and `npm run spec-coverage` reports zero unmapped scenarios.
- [ ] 5.4 Docs:
  - `docs/ports.md`: a "Windows preview" section covering the helper, the fence, restricted for a standard user, the IPv6 scope, the latency figures, and what the runner cannot verify (a real PID reuse);
  - README: remove the three "port inspection is not available on Windows" statements;
  - `docs/processes.md`;
  - `docs/deferred-checks.md`: replace the "Windows port inspection" row, and add the 3 s helper start to the helper risk;
  - `docs/windows-evidence.md`: mark "Ports (W3)" as resolved, as W2 did for its items.

  Verify: `windows-evidence.test.ts` passes, and `grep -rn "not yet available\|W3" README.md docs` shows no stale claim.
- [ ] 5.5 Hand off group 5 to `reviewer2`, fix the findings, have them re-reviewed, and record the outcome below this group.

## 6. Integration check

- [ ] 6.1 Run the full checks on the pull request: Linux typecheck, lint, `npm test`, `npm run test:integration`, e2e, `npm run spec-coverage`, and `openspec validate add-windows-port-inspection --strict`, plus the whole `windows` job. Confirm that no `it.todo` of this change remains (`grep -rn "it.todo" test | grep port-inspection` is empty). Verify: `ci-ok` is green, and record the counts here.

## Workflow follow-up

- Archive the change with `/opsx:archive` after group 6, and sync the `port-inspection` and `quality-gates` specs.
