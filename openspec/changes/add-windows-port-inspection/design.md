# Design

## Context

See proposal.md for the motivation. The current state:

- `createWindowsPlatform` (`src/main/platform/windows/index.ts`) sets `portInspector` to `UNSUPPORTED_PORT_INSPECTOR`, which rejects with `UnsupportedPlatformError`. The renderer shows the `ports-unsupported` banner for that error code (`src/renderer/src/PortsView.tsx`), and `runSmokeTest` (`src/main/app/smoke.ts`) turns it into "port inspection not yet available".
- The port service (`src/main/ports/service.ts`) is platform-neutral:
  - it reads `inspector.list()` and the supervisor's attribution sets together;
  - it matches holders to commands by `pid:token`;
  - on Windows the token is the creation time as a canonical FILETIME decimal (`windows/identity.ts`), and a run's `attributed()` already returns its Job Object members with their creation times (`helper-client.ts`).

  Nothing in the service or the renderer needs to change for Windows. `imageName` and `procInfo` live in `helper-client.ts` (lines 67 and 70), which imports `node:child_process` and `node:net`.
- The Linux inspector (`linux/ports.ts`, `linux/net.ts`):
  - reads the tables first, then the holders;
  - formats addresses itself (`formatIpv4`, `formatIpv6`, which are private to `net.ts`);
  - sorts the result by port, family and address;
  - classifies an owner as `known` (holders oldest first), `restricted` or `unknown`.
- The W1 helper (`veydr-helper.cs`, protocol version 2) has the short-lived stdio subcommands `inspect` and `terminate`. TypeScript runs them through `runHelperTool` in `windows/process-tree.ts`, which:
  - writes stdin, then closes it;
  - caps stdout at `MAX_TOOL_OUTPUT_BYTES` (8 MiB);
  - kills the helper on timeout.

  The version check (`checkHelper`, cached per file size and modification time) is private to the process tree. The file's header says "W3 adds `ports`".
- The read-only test (`test/unit/port-service.test.ts`) walks the import closure of `ports/service.ts` and `linux/ports.ts`. It fails on any import of `child_process`, `net` or another network module, on `kill(` or a signal name, and on reaching the supervisor or the process tree.
- W0's port evidence (`docs/windows-evidence.md`, `test/windows-probe/results/ports.jsonl`):
  - `GetExtendedTcpTable` lists the probe's listeners on `127.0.0.1`, `::1` and `0.0.0.0` with their PID, as administrator and as a standard user. It takes a median of 0.4 ms (at most 7.1 ms) for both tables.
  - A standard user can read every owner's name from the process list, but the creation time only of its own processes. The other 14 owners (System, lsass, services, svchost and others) were denied.
  - The CI runner's account is an administrator, which can read every owner.
- The e2e specs: `ports.spec.ts` is Linux-only as a whole (`[linux-only: port inspection]`), though its fixtures are Node scripts and its process checks go through the portable `test/support/processes.ts`. `windows-ports.spec.ts` checks the banner.
- W0 has a standard-user launcher, `scripts/windows-probe/standard-user.ps1`. It creates a temporary local account, copies `scripts/windows-probe` to a directory only that account can read, runs a probe driver there as the account through `CreateProcessWithLogonW`, appends the driver's result lines to `-Results`, and removes the account. It only runs drivers named `^[a-z0-9-]+\.mjs$` from `scripts/windows-probe`, with plain-word arguments.

## Goals / Non-Goals

**Goals:**

- Windows port listing that produces the same `PortSnapshot` shape, with the same owner semantics as Linux: `known` only when Veydr can identify the holder by PID and creation time.
- No new trust in a process that might not be the holder: a reused PID is never shown as the owner.
- The read-only guarantee stays mechanically checked on Windows, even though listing ports now starts a process.
- The restricted rule verified as a real standard user on the runner, not only with fakes.

**Non-Goals:**

- Showing the name or PID of an owner whose creation time cannot be read. See D4.
- UDP, connections that are not listening, and the IPv6 scope ID (Linux ignores it too).
- A long-lived helper serving repeated port requests. See D3.
- Packaging the helper, signing, or a smoke test as a standard user in a packaged app (W4, G-6).

## Decisions

### D1. `veydr-helper.exe ports`: tables first, then owners, with a time fence

The subcommand takes no arguments and closes nothing it did not open. It reads nothing from stdin: Veydr writes nothing and closes stdin, and the helper does not wait for it. It runs these steps:

1. Read the fence `t0` with `GetSystemTimePreciseAsFileTime`.
2. Read `GetExtendedTcpTable(AF_INET, TCP_TABLE_OWNER_PID_LISTENER)` and `GetExtendedTcpTable(AF_INET6, …)`. On `ERROR_INSUFFICIENT_BUFFER`, grow the buffer to the size it asks for and retry, at most 8 times, then fail.
3. Read one `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS)` for executable names. It needs no access to the processes, as W0 observed.
4. For each distinct owning PID:
   - PID 0 (no owning process) → `gone`, without opening anything;
   - otherwise call `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`, the only right W0 measured (`scripts/windows-probe/ports.ps1`). `SYNCHRONIZE` is not requested, because a protected process such as System (PID 4) may refuse it and would then look restricted even to an administrator:
     - `ERROR_ACCESS_DENIED` → `restricted`;
     - `ERROR_INVALID_PARAMETER` (no such process) → `gone`;
     - any other failure → `error`, with the Win32 code.
   - With a handle:
     - if `GetExitCodeProcess` gives anything other than `STILL_ACTIVE`, or `GetProcessTimes` gives a non-zero exit time → `gone`;
     - if `GetProcessTimes` fails → `error`;
     - if the creation time is later than `t0 - FENCE_MARGIN` (`FENCE_MARGIN` is 20 ms, 200,000 FILETIME units) → `reused`. A process created after `t0` got its PID after the tables were read, so it cannot be the one that held the socket. A live process created before `t0` already had that PID when the table was read, and PIDs of live processes are unique, so it is the holder. The margin exists because a process's creation time may come from a coarser clock than `GetSystemTimePreciseAsFileTime` (up to one timer tick, about 15.6 ms, stale), so a PID reused just after `t0` could carry a creation time slightly before it. A genuine holder younger than 20 ms is shown as unknown for one refresh, which is harmless;
     - otherwise → `known`, with `created` and `image` (`QueryFullProcessImageName`, falling back to the snapshot name, such as `System`, and otherwise to an empty string).
5. Print one line:
   `{"type":"ports","takenAt":"<t0 FILETIME>","listeners":[{"family":"ipv4"|"ipv6","address":"<hex, network order>","port":N,"pid":P}...],"owners":[{"pid":P,"state":"known","created":"<FILETIME>","image":"…"}|{"pid":P,"state":"restricted"|"gone"|"reused"}|{"pid":P,"state":"error","code":N}...]}`

   The address is 8 or 32 hex digits in network byte order. The port is converted to host order by the helper. Each owner appears once, so many sockets of one process cost one entry.

Nothing in `ports` calls `CreateProcess`, `TerminateProcess`, `GenerateConsoleCtrlEvent`, a job function, or any access right other than `PROCESS_QUERY_LIMITED_INFORMATION`. A unit test checks this in the C# source (D6).

*Alternatives:*
- *Re-reading the table after the owners and dropping changed rows.* This doubles the reads and still leaves a window between the two. The fence closes the window by the creation time, which the identity already depends on. Rejected.
- *Formatting addresses in C#.* Linux formatting is in TypeScript, and two formatters would drift. Hex bytes keep one formatter, testable on Linux. Rejected.
- *`Get-NetTCPConnection` or `netstat -ano`.* W0 rejected both (PowerShell startup cost, and localized text). Rejected.

### D2. Protocol version 3

`ProtocolVersion` becomes 3 in the C# file and `PROTOCOL_VERSION` becomes 3 in `protocol.ts`. `run`, `inspect` and `terminate` are unchanged.

The version must change because a version 2 helper exits with a usage error (exit code 2) on `ports`. A failure that names the version is clearer, and the existing check refuses a stale helper before any port request. `scripts/build-windows-helper.mjs` already rebuilds when the source changes.

Protocol additions in `protocol.ts`:
- a strict zod schema for the `ports` line, reusing `isFiletime`, and `isWindowsPid` except that an owner and a listener may have PID 0 (always reported as `gone`), so one odd row never fails the whole listing;
- hex addresses of exactly 8 or 32 hex digits, ports 1–65535, and states from the closed set;
- `parsePortsOutput(output)`, built like `parseInspectOutput`;
- a `ports` output limit of 16 MiB, `MAX_PORTS_OUTPUT_BYTES`. A listener entry is about 60 bytes, so this allows roughly 250,000 listeners. Listeners are counted per address and port, so there is no fixed bound, but a desktop machine has a few hundred. Beyond the limit the whole listing rejects with `line-too-long`, and the view shows that error. `runHelperTool` takes the limit as an option (defaulting to `MAX_TOOL_OUTPUT_BYTES` for `inspect` and `terminate`), and `parsePortsOutput` checks its line against the same limit, not `MAX_LINE_BYTES` (1 MiB).

Every listener's `pid` must have exactly one entry in `owners`, and no owner may be listed without a listener. Anything else is a `ProtocolError`.

### D3. A helper process per listing

Each `list()` starts `veydr-helper.exe ports` once. The poller never overlaps requests (`docs/ports.md`, "Refreshing"), so there is at most one at a time, every 3 s while the view is visible.

*Alternative: a long-lived port server* (like `run`, over a pipe). It saves the start-up cost of the .NET Framework executable, but adds a second control channel, its lifetime, and its own failure modes, for a view that polls every 3 s. Rejected for now. D7's latency test records the real cost, and a server is the follow-up if the cost proves too high.

### D4. Owner mapping in `createWindowsPortInspector`

`src/main/platform/windows/ports.ts` exports `createWindowsPortInspector({ readPorts, log? })`. `readPorts: () => Promise<string>` returns the helper's raw stdout.

For each listener, it emits a `ListeningPort`:
- `family` as reported;
- `address` from the shared formatter (D5);
- `port`;
- the owner from the PID's entry:
  - `known` → `{ kind: 'known', processes: [{ identity: windowsIdentity(pid, created), name }] }`. The name is the basename of `image`, computed by `imageName`, which moves from `helper-client.ts` to `identity.ts` (helper-client re-imports it), else `PID <n>`, local to `ports.ts` as `procInfo`'s fallback is;
  - `restricted` → `{ kind: 'restricted' }`;
  - `gone` (including PID 0), `reused` or `error` → `{ kind: 'unknown' }`. The `error` codes are counted and logged once per listing (`ports.owner-errors`), as Linux logs read failures.

`takenAt` is `t0` converted from FILETIME to Unix milliseconds with BigInt arithmetic, `Number((t0 - 116444736000000000n) / 10000n)`. The result is sorted as on Linux. A failed run (missing helper, wrong version, timeout, exit code other than 0, malformed line) rejects with a plain `Error` naming the helper and the cause. The reader wraps the version check's `SpawnError`, so a ports failure never surfaces as a start error. The service passes it on, and the view keeps the previous list with the error above it, which is already the behavior on Linux.

Restricted means "the OS denies this user access to the holder". On Windows that is `ERROR_ACCESS_DENIED` from `OpenProcess`, whatever the reason: another user, the system, or a process of the same user with a token that denies it.

*Alternative: show the snapshot name and PID for restricted owners.* A standard user can read every owner's name, but not its creation time. A PID without identity cannot be matched against a command, and could be a reused PID (D1's fence needs the creation time). It would also need a new owner kind in the shared API and the renderer. W0 decided "restricted, as on Linux" (`docs/windows-evidence.md`, "Ports (W3)"). Rejected for this change and noted as a possible follow-up.

### D5. One address formatter

`formatIpv4` and `formatIpv6` move from `linux/net.ts` to `src/main/platform/address.ts`. They take bytes in network order, and `parseNetTcp` keeps its own byte-order handling before calling them. The Windows inspector decodes the helper's hex into bytes and calls the same functions. IPv4-mapped and dual-stack `::` addresses therefore read the same on both systems. The move is a refactor checked by the existing `linux-ports` unit tests.

### D6. Read-only, kept checkable

- **The split.**
  - `windows/ports.ts` imports only `../types`, `identity.ts` (including `imageName`), `protocol.ts` (zod) and `../address.ts`. This is its whole import closure, and it runs nothing.
  - Running the helper lives in a new `windows/helper-tool.ts`. `runHelperTool`, `runHelperVersion` and the cached version check move there from `process-tree.ts`, unchanged in behavior. A new `createHelperCheck(helperPath, readVersion)` is shared by the process tree and the port inspector, so one version read serves both.
  - `helper-tool.ts` exports `createHelperPortsReader({ helperPath, check })`, which checks the helper, then runs `runHelperTool(helperPath, ['ports'], '', { timeoutMs: PORTS_TIMEOUT_MS, maxOutputBytes: MAX_PORTS_OUTPUT_BYTES })`. `windows/index.ts` wires the inspector with `createWindowsPortInspector({ readPorts: createHelperPortsReader(...), log })`. The integration tests (D7) use the same reader, so they exercise the shipped wiring before `index.ts` switches over.
- **Timeout.** `PORTS_TIMEOUT_MS` is 10 s. W0 measured the API at under 10 ms, so only a hung helper reaches it, and `runHelperTool` then kills the helper. The spec's MODIFIED "Read-only inspection" names this as the one process that may be ended.
- **Tests (`port-service.test.ts`):**
  - add `src/main/platform/windows/ports.ts` to the read-only entries, with the same forbidden imports and signal patterns, and forbid it from reaching `helper-tool`, `helper-client` and `process-tree`. The forbidden-module pattern also matches imports without the `node:` prefix (`from '(node:)?child_process'`);
  - a new check that `createHelperPortsReader` in `helper-tool.ts` calls `runHelperTool` with the literal `['ports']` and no other arguments, and that `windows/index.ts` gives the port inspector nothing but that reader;
  - a new check on `veydr-helper.cs`. It extracts the `PortsCommand` class body by brace matching, after stripping comments, regular, verbatim (`@"…"`, with `""` escapes) and interpolated (`$"…"`) string literals, and char literals such as `'{'`. The file uses C# 5, which has no interpolated strings, so the check fails on any `$"` rather than parsing it. It then requires that:
    - the body contains none of `CreateProcess`, `TerminateProcess`, `TerminateJobObject`, `GenerateConsoleCtrlEvent`, `PROCESS_TERMINATE`, `ProcessTerminate` or `SYNCHRONIZE`;
    - the body references no class of the file other than the allowlist `Native`, `Json`, `HelperException` and `VeydrHelper`, so it cannot reach `SurvivorCommands` or `RunCommand` code that ends processes;
    - every `Native.` member it uses is on an allowlist of read calls (`GetSystemTimePreciseAsFileTime`, `GetExtendedTcpTable`, `CreateToolhelp32Snapshot`, `Process32FirstW`, `Process32NextW`, `OpenProcess`, `GetExitCodeProcess`, `GetProcessTimes`, `QueryFullProcessImageName`, `CloseHandle` and the constants they need);
    - every `OpenProcess` passes exactly `Native.PROCESS_QUERY_LIMITED_INFORMATION`.

    Negative tests run the same check on fixture strings: a call to a `SurvivorCommands` method, `| SYNCHRONIZE`, and a forbidden call hidden next to a comment must each fail it. A fixture with a `}` inside a string literal and inside a char literal, followed by a forbidden call still inside the class, must also fail, so the brace matching cannot end the body early and pass vacuously.

*Alternative: let `windows/ports.ts` spawn the helper itself and loosen the test for it.* This weakens the one mechanical guarantee the spec relies on. Rejected.

### D7. Verification on the runner

All Windows-only tests use `describe.runIf(process.platform === 'win32')` with a `[windows-only: …]` reason, as `test-platform-policy.test.ts` requires.

**Integration (`test/integration/windows-ports.test.ts`, run by `npm run test:windows`),** through the real helper and supervisor, as `windows-commands.test.ts` sets them up:
Every Windows integration case that reads ports, including task 2.4's raw helper case, waits until its fixture listeners are at least 100 ms old before listing, so D1's 20 ms margin never turns them `unknown`.

1. A command's listener (`test/fixtures/proc/listen.mjs`) and a grandchild's listener (`--depth 2`) are attributed to the command, with PID, name `node.exe` and creation time. This tags `[spec:port-inspection/command-port-shown-on-windows]`.
2. An unmanaged listener on `127.0.0.1` and on `::1` is listed with its PID and no command. This tags `[spec:port-inspection/unmanaged-listener-on-windows]`.
3. Latency: 1,000 sockets of one process. The median of seven `list()` calls after a warm-up must be under 500 ms, and the measured figures are printed for the docs. 500 ms allows for the helper's process start, since the API itself takes under 10 ms. The figure is recorded, not tuned.
4. **Standard user.** Tags `[spec:port-inspection/owner-hidden-from-a-standard-user-on-windows]` and `[spec:port-inspection/windows-port-inspection-verified-natively]`.
   - **Launcher.** The existing Run mode of `standard-user.ps1` gains one optional parameter, `-Helper <path>`. It must be a fully qualified path to an existing regular file (`Test-Path -PathType Leaf`) whose name is exactly `veydr-helper.exe`, compared case-sensitively (`-cne`), checked before the account exists, and it is copied into the account's private directory next to the drivers. No generic "run any program" mode is added.
   - **Driver.** A new driver, `scripts/windows-probe/ports-standard-user.mjs`, is built on `driver.mjs`'s `driverMain`/`runDriver`, so it reports the `ctx-*` lines first and handles `--unavailable` (a launcher failure becomes a result line, which the test turns into a throw). It takes no arguments other than the launcher's `--user standard`. It is not a probe area: it stays out of `checks.mjs`, `summary.mjs` and the probe-area lists in `workflow-policy.test.ts`. It:
     - records W0's `ctx-standard-user` control (the token is not in Administrators), so an administrator run fails visibly instead of passing for the wrong reason;
     - runs `veydr-helper.exe ports` from its own directory;
     - writes the helper's exit code and its stdout line as result lines, through the launcher's existing `-Results` capture.
   - **Test.** The test creates the results file before calling the launcher, as `windows-probe.yml` does, because the launcher requires `-Results` to exist. It then starts a fixture listener as the runner's account, waits 100 ms, runs the launcher with `-Driver ports-standard-user.mjs -Helper <out-helper path>`, and reads the result file. An `--unavailable` result line throws. It asserts:
     - `ctx-standard-user` passed;
     - the helper exited with 0;
     - fed through `createWindowsPortInspector({ readPorts: () => line })`, the fixture's port is listed with its owner `restricted`;
     - at least one other listener is `restricted`. No specific system port is named, because which services listen varies.
   - **Gating.** The outer `describe.runIf(process.platform === 'win32')('[windows-only: Windows accounts]')` is the platform guard. Inside it, `it.skipIf(process.env.CI !== 'true')` is an untagged non-platform guard, which `test-platform-policy.test.ts` allows (its "allows combined guard conditions" case), because the test changes the machine's accounts. When it runs, every launcher failure (account, copy, logon) throws, so CI fails rather than skips. `workflow-policy.test.ts` gains an assertion that the `windows` job neither sets nor overrides `CI`.

**Unit tests on every system:**
- `test/unit/windows-ports.test.ts`: the mapping from fixed helper lines, including restricted, gone, PID 0, reused (tags `[spec:port-inspection/reused-pid-not-shown-as-owner]`) and error; `takenAt` against a known FILETIME; sorting; and the refusals.
- The `protocol.ts` schema, including mismatched owners and listeners.
- `address.ts`.

The fence itself (D1) runs only in the helper. It is checked by reading the C# source in review and by the integration tests' known owners, since a real PID reuse cannot be forced on the runner. The docs say so.

**End-to-end:**
- `ports.spec.ts` becomes portable. Its first, second and fourth tests run on both systems. The restricted test (another Linux user) stays `[linux-only: another user's process]`, because the e2e app runs as the runner's administrator, which can read every owner. Two parts of the current tests are Linux-specific and need portable replacements:
  - **Listing counter.** Test 2 counts listings through `support/ports-probe.cjs`, which logs reads of `/proc/net/tcp`. The probe also wraps `child_process.spawn` and `execFile` in the main process and logs each call whose arguments are exactly `['ports']`. A support function returns the count from whichever log the system writes, so the "no listing while another view is shown or the window is hidden" checks are the same on both systems.
  - **Process name.** The tests assert `node PID <n>`, which is `node.exe PID <n>` on Windows. A `test/support` function gives the expected name of the Node executable from `process.execPath`'s basename (`node`, or `node.exe`), with no branch on `process.platform`, which the policy test forbids.
- `windows-ports.spec.ts` is deleted, and `docs/ci.md`'s classification table follows.
- `test/unit/renderer-ports.test.ts` keeps the banner test, for the unsupported platform.

### D8. Smoke test and composition

- `runSmokeTest` loses its `UnsupportedPlatformError` branch for ports. Every supported platform now lists ports, and an unsupported platform fails the check earlier, on `supported`. `smoke.test.ts` follows.
- `platform.test.ts` stops expecting a rejected `portInspector` on Windows.
- The JSDoc of `createWindowsPlatform` and of the helper's header drop "no port inspection yet".

## Risks / Trade-offs

- [The helper starts every 3 s while the view is open; unsigned until G-6, so antivirus software may scan it each time and slow it down] → D7's latency figure is recorded. The risk joins the existing helper entry in `docs/deferred-checks.md`. D3 names the long-lived server as the fallback.
- [The creation time's clock may be coarser than `t0`'s] → D1's 20 ms margin covers one timer tick (about 15.6 ms). A genuine holder younger than 20 ms shows as unknown for one refresh. The tests wait 100 ms before listing.
- [A wall-clock change between the table read and the owner read could defeat the margin] → Only a backward change of more than 20 ms, inside those few milliseconds, combined with a PID reuse in the same window, could let a reused PID count as `known`, for one refresh. Documented as a limit.
- [A standard user sees fewer owners than Linux shows for root services: every system service is restricted] → Matches the spec's restricted rule and W0's decision. `docs/ports.md` explains it.
- [The standard-user test changes the CI machine's accounts] → It reuses W0's launcher, which removes the account whatever happens, and runs only in CI.
- [IPv6 scope IDs are dropped, so `fe80::1%3` and `fe80::1%4` on the same port look alike] → As on Linux. Documented.
- [Moving `runHelperTool` and the version check could change process-tree behavior] → The move is behavior-preserving. The existing `windows-process-tree` unit and integration tests cover it, and it lands in its own task group before the ports work.

## Migration Plan

- No data migration. The helper's protocol version changes from 2 to 3, so a developer's stale `out-helper/veydr-helper.exe` is refused with the existing "speaks protocol version 2, but Veydr needs version 3" message. `node scripts/build-windows-helper.mjs` replaces it (it rebuilds when the source changes); the README's "Running from source on Windows" steps already run it.
- Rollback is a revert. No configuration or ledger format changes.
