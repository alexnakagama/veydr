# Proposal

## Why

Windows is a preview since W2: commands start, stop and recover from the app, but the **Ports** view still says that port inspection is not yet available on this platform, and `portInspector.list` rejects with `UnsupportedPlatformError`. W3 is the change the roadmap names for it (foundation design, Windows sequence). W0's evidence (`docs/windows-evidence.md`, "Ports (W3)") already fixes the route: `GetExtendedTcpTable` through the W1 helper (`port-api`, `port-api-std`, `port-api-latency` all `PASS`), and reports owners that are another user's processes as **restricted**, because a standard user cannot read their creation time (`port-owner-identity-std`, `EXPECTED-FAIL`).

## What Changes

- **`veydr-helper.exe ports`.** A new, short-lived helper subcommand, in the same C# file, that:
  - reads the IPv4 and IPv6 listening TCP tables with `GetExtendedTcpTable` (`TCP_TABLE_OWNER_PID_LISTENER`);
  - for each owning PID, opens the process with `PROCESS_QUERY_LIMITED_INFORMATION` only, and reports its creation time and image path, or that it is restricted (access denied), gone, or unreadable for another reason;
  - discards an owner created after, or shortly before, the tables were read (its PID may have been reused), so a reused PID is never reported as the holder;
  - prints one JSON line on stdout and exits, like `inspect`. It reads nothing on stdin, starts nothing, and changes no process.
- **Helper protocol version 3.** The new subcommand raises the version. Veydr refuses a helper of another version, as it does now, and the build script already rebuilds a stale helper.
- **A Windows `PortInspector`.** `createWindowsPortInspector` turns the helper's line into the same `PortSnapshot` the Linux inspector produces: addresses formatted by the same code as on Linux, owners as `known` (PID, creation time, image name), `restricted`, or `unknown`. The port service, the attribution by PID and creation time, and the renderer are unchanged: a command's port is attributed through the job members the W1 helper already reports.
- **Read-only, kept checkable.** The inspector module itself imports no `child_process` and no network module. It gets a function that runs exactly `veydr-helper.exe ports`, wired in the Windows composition. The read-only unit test covers the Windows inspector, and a source check confirms the `ports` subcommand opens processes for query only. The only process Veydr may end on this path is its own helper, when it exceeds its time or output limit.
- **Windows becomes a full preview for ports.** The requirement "Windows port inspection not yet supported" is removed. A new requirement describes Windows port inspection as part of the preview, verified natively.
- **Tests.**
  - Unit tests, on every system: parsing the helper's line, address formatting, the owner rules, and the refusals.
  - Windows integration tests through the real helper: a command's port and a grandchild's port attributed, an unmanaged listener, IPv4 and IPv6, a latency check with 1,000 sockets, and the restricted rule as a standard user.
  - End-to-end: `ports.spec.ts` becomes portable except the Linux-only restricted test, and `windows-ports.spec.ts` (the "not yet available" banner) is removed.
- **Docs.** `docs/ports.md` gains a Windows section, README drops "port inspection is not available on Windows yet", and `docs/deferred-checks.md`, `docs/dependencies.md`, `docs/ci.md`, `docs/processes.md` and the W3 notes in `docs/windows-evidence.md` follow.
- **Not changed:**
  - Linux port inspection.
  - The shared API (`ListeningPort`, `PortOwner`) and the Ports view's layout. The "not yet available" banner stays for platforms that have no implementation.
  - Packaging and signing (W4, G-6). No npm dependency is added, and no helper binary is committed.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `port-inspection`:
  - "Windows port inspection not yet supported" is removed;
  - a new requirement, "Windows port inspection in preview", covers the TCP tables, attribution by PID and creation time, a reused PID, restricted owners, and native verification;
  - "Read-only inspection" names the one process Veydr starts for it on Windows (its own helper, which opens other processes for query only) and the one it may end (that helper, on timeout).
- `quality-gates`: "Windows helper built from source" names the helper as the Windows helper (process trees and port inspection), not only the process-tree helper. No check is added to or removed from the pipeline.

## Impact

- **Code:**
  - `src/main/platform/windows/helper/veydr-helper.cs`: the `ports` subcommand and protocol version 3;
  - `src/main/platform/windows/`: a new `ports.ts` (the inspector) and the `ports` output schema in `protocol.ts`; the helper check and `runHelperTool` move out of `process-tree.ts` into a module both use; `index.ts` wires the inspector;
  - the IPv4 and IPv6 formatting moves out of `src/main/platform/linux/net.ts` into a shared module;
  - `src/main/app/smoke.ts` drops its "not yet available" branch for Windows.
- **Tests:** unit tests for the inspector and the protocol; the read-only test extended to the Windows inspector; Windows integration tests (`windows-ports.test.ts`, with a standard-user case); the e2e ports specs reclassified; `smoke.test.ts`, `platform.test.ts` and `renderer-ports.test.ts` updated where they assume Windows is unsupported.
- **CI:** no new job or step. The new tests run in the existing `windows` job's integration and e2e steps.
- **Risk:** the helper is started every 3 s while the Ports view is open. It is unsigned until G-6, so antivirus software may scan or flag it more often; this is recorded with the existing helper risk.
- **Follow-ups:** W4 packages the helper outside `app.asar` and repeats the smoke test, which then also lists ports, as a standard user.
