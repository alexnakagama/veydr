# Tasks

Group labels (F1, L1–L9) match `design.md` D15. Each group ends with a `reviewer2` gate: do not start the next group until its re-review task is checked. Record review outcomes (reviewer, date, findings, resolutions) as plain notes under the group's last task. Never record a review that did not happen. Platform claims in this change are Linux-only; Windows tasks belong to follow-up changes.

## 1. F1 — Scaffold, security baseline, platform boundary

- [ ] 1.1 Obtain approval gate G-1 (pinned dependency list from design D13, first commit on `main`, `reviewer2` session running) and verify the approval is recorded as a note here before any install
- [ ] 1.2 Initialize the npm package, strict `tsconfig` set (main/preload/renderer/shared), `electron-vite` config, `.nvmrc`, and exact-pinned dependencies; verify `npm ci` succeeds from a clean checkout and `npm run typecheck` passes on an empty skeleton
- [ ] 1.3 Add ESLint with `typescript-eslint`, `react-hooks`, and boundary rules (no `platform/linux|windows` imports and no `process.platform` outside the composition root and `platform/index.ts`); verify `npm run lint` passes and a fixture file violating each rule fails lint
- [ ] 1.4 Create the main window with `contextIsolation`, `sandbox`, `nodeIntegration: false`, `webviewTag: false`, served via the `app://veydr/` protocol with the D2 CSP header; verify by E2E `[spec:desktop-shell/renderer-has-no-node-js-access]` that `require`, `process`, and `module` are undefined in the renderer
- [ ] 1.5 Block navigation, redirects, new windows, and permission requests; verify E2E tests for navigation blocked, new window denied, and inline script blocked
- [ ] 1.6 Implement the IPC registration helper (sender-frame/origin check, zod parsing, typed error results) and the preload bridge exposing only `app.getInfo`; verify unit tests reject a malformed payload and a foreign sender, and an E2E test enumerates `window.veydr` and finds only declared groups
- [ ] 1.7 Implement `src/main/platform` types from design D5, the composition root selecting by `process.platform`, Linux placeholders, and Windows/unsupported implementations throwing `UnsupportedPlatformError`; verify unit tests that every Windows operation rejects with that error
- [ ] 1.8 Add `app.requestSingleInstanceLock` handling; verify E2E that a second launch focuses the first window and exits without touching the config directory
- [ ] 1.9 Build a minimal dark renderer shell (sidebar, empty states, keyboard focus order) showing `app.getInfo`; verify E2E the window renders the empty-project state and is keyboard navigable
- [ ] 1.10 Add scripts `typecheck`, `lint`, `test`, `test:integration`, `test:e2e`, `test:perf`, `verify`, and `scripts/spec-coverage.mjs` (informational mode); verify `npm run verify` runs all stages and spec-coverage prints unmapped scenarios
- [ ] 1.11 Add a no-network E2E guard that fails if the app opens outbound connections during the smoke flow; verify it passes and fails when a deliberate fetch is injected in a test build
- [ ] 1.12 Run `npm run verify && npm run test:e2e`, hand the group to `reviewer2` (files, acceptance criteria, command output), and verify the review request and findings are recorded
- [ ] 1.13 Fix all F1 findings and obtain an independent `reviewer2` re-review; verify the re-review outcome is recorded with no open findings

## 2. L1 — Configuration storage

- [ ] 2.1 Define the v1 config schema (projects, commands, settings, `schemaVersion`) in `src/shared` with zod; verify unit tests for valid and invalid documents
- [ ] 2.2 Implement the atomic writer (tmp file `0600` → fsync → rename → directory fsync, `.bak` of last known-good) behind a serialized write queue; verify fault-injection unit tests at every step leave a complete valid file `[spec:config-storage/interrupted-save]`
- [ ] 2.3 Implement load with recovery (corrupt primary → `.bak` + notice, damaged file preserved as `config.corrupt-<ts>.json`, neither usable → empty config + notice); verify unit tests for both recovery scenarios
- [ ] 2.4 Implement the migration framework and newer-schema read-only mode; verify fixture tests for a synthetic v0→v1 migration with pre-migration backup and for a v2 file that remains byte-identical after load
- [ ] 2.5 Resolve config location from `app.getPath('userData')` and enforce `0700` directory / `0600` file modes on Linux; verify integration tests with and without `XDG_CONFIG_HOME` and a mode assertion
- [ ] 2.6 Document configuration location, backup/recovery behavior, and the plaintext secret limitation in `docs/configuration.md`; verify the documented paths match the integration test output
- [ ] 2.7 Run `npm run verify`, hand the group to `reviewer2`, and verify the review request and findings are recorded
- [ ] 2.8 Fix all L1 findings and obtain an independent `reviewer2` re-review; verify the re-review outcome is recorded with no open findings

## 3. L2 — IPC contract and renderer state sync

- [ ] 3.1 Define all D3 operation schemas and result types in `src/shared/api`; verify type-level tests and a unit test that every exposed preload function has a registered schema
- [ ] 3.2 Implement main-side subscriber tracking per `webContents` (cleanup on destroy/reload) and the event envelope `{commandId, runId, seq}`; verify unit tests that sends to destroyed contents are dropped
- [ ] 3.3 Expose the full preload API (no generic invoke) with unsubscribe-returning listeners; verify the E2E API enumeration test still finds only declared operations
- [ ] 3.4 Implement renderer stores that load from `snapshot` and ignore events with a stale `runId`; verify unit tests `[spec:process-supervision/late-events-ignored]` and an E2E reload test restoring state
- [ ] 3.5 Run `npm run verify && npm run test:e2e`, hand the group to `reviewer2`, and verify the review request and findings are recorded
- [ ] 3.6 Fix all L2 findings and obtain an independent `reviewer2` re-review; verify the re-review outcome is recorded with no open findings

## 4. L3 — Supervisor core and Linux process trees

- [ ] 4.1 Write process fixtures in `test/fixtures/proc/` (configurable tree depth/fan-out, ignore-SIGTERM, setpgid child, setsid escapee, flood, listener) that write `(pid, starttime)` to a ledger file; verify a fixture self-test lists every spawned PID
- [ ] 4.2 Implement the per-command FSM and action queue (design D7) with an injected fake `ProcessTree`; verify unit tests for every transition, duplicate start, stop-during-stop, and restart ordering
- [ ] 4.3 Implement a seeded random-action hammer test (500 actions) asserting FSM invariants; verify it passes with three fixed seeds
- [ ] 4.4 Implement Linux `/proc` reading (stat parsing incl. command names with spaces/parentheses, `boot_id`, starttime) as a pure module; verify unit tests against captured `/proc` fixtures
- [ ] 4.5 Implement Linux `ProcessTree.spawn` (`detached: true`, `stdio: ['ignore','pipe','pipe']`, start-failure mapping); verify integration tests for executable-not-found, not-executable, and missing working directory `[spec:process-supervision/spawn-error]`
- [ ] 4.6 Implement attribution tracking (session ID + observed descendants, 2 s scan, scan on stop) and `stop` (SIGTERM group + tracked → grace → SIGKILL → survivors) with identity verification before each signal; verify integration tests for cooperative, uncooperative, setpgid, and observed-setsid trees with zero leaks, enumerated independently via `/proc`
- [ ] 4.7 Add sentinel and PID-reuse safety tests (unrelated process never signalled; fabricated stale identity never signalled); verify they pass under `VEYDR_STRESS=1` (50 repetitions)
- [ ] 4.8 Add an output-drain test where the consumer is stalled; verify the producer reaches ≥ 80 % of baseline throughput `[spec:process-supervision/high-volume-output]`
- [ ] 4.9 Measure the unobserved-escape rate (setsid + parent exit within 50 ms) and record it; evaluate `systemd-run --user --scope` containment on this machine (escape rate, spawn latency p95) and present the results for gate G-3; verify measurements are recorded as notes and no systemd-based code is merged without approval
- [ ] 4.10 Wire the supervisor to IPC (`start`, `stop`, `restart`, `snapshot`, `onState`) and show state, PID, uptime, exit details in the renderer; verify an E2E test with a seeded config starts and stops a fixture tree
- [ ] 4.11 Document Linux stop semantics, attribution, and the escaped-descendant and PID-race limitations in `docs/processes.md`; verify each documented limitation is referenced by a test or a recorded measurement
- [ ] 4.12 Run `VEYDR_STRESS=1 npm run test:integration && npm run verify`, hand the group to `reviewer2`, and verify the review request and findings are recorded
- [ ] 4.13 Fix all L3 findings and obtain an independent `reviewer2` re-review; verify the re-review outcome is recorded with no open findings

## 5. L4 — Crash recovery and quit orchestration

- [ ] 5.1 Implement the runtime ledger (atomic writes, per-run identities, cleared on exit, empty after clean quit); verify unit tests for write/clear and an integration test that the file is empty after clean shutdown
- [ ] 5.2 Implement `findSurvivors`/`terminateSurvivors` (boot_id check, identity match, session members); verify an integration test that SIGKILLs a supervisor host process, relaunches, and finds every surviving fixture process and no unrelated or stale-PID process
- [ ] 5.3 Show survivors on launch with name and command line and terminate only after user confirmation; verify E2E `[spec:process-supervision/survivors-after-crash]` and that no command is started on launch `[spec:desktop-shell/startup-does-not-start-commands]`
- [ ] 5.4 Implement quit orchestration (stopping overlay, parallel stop-all, overall deadline, Retry/Quit anyway dialog, ledger retained on quit-anyway); verify E2E tests for clean quit with running commands and for an unstoppable fixture
- [ ] 5.5 Handle `SIGTERM`/`SIGINT`/`SIGHUP` to Electron with the same stop-all path and 10 s deadline; verify an integration/E2E test sending SIGTERM to the app leaves no fixture process
- [ ] 5.6 Extend `docs/processes.md` with crash behavior and the "until next launch" limitation; verify the doc matches the recovery test behavior
- [ ] 5.7 Run `npm run verify && npm run test:e2e`, hand the group to `reviewer2`, and verify the review request and findings are recorded
- [ ] 5.8 Fix all L4 findings and obtain an independent `reviewer2` re-review; verify the re-review outcome is recorded with no open findings

## 6. L5 — Projects, commands, and environment

- [ ] 6.1 Implement project add (native directory picker + validation, realpath duplicate detection), update, remove (blocked while running, files untouched), and relocate; verify unit and E2E tests for each project-registry project scenario
- [ ] 6.2 Implement missing-directory detection on load and before start; verify E2E that a deleted project folder shows as missing and its commands cannot start
- [ ] 6.3 Implement Linux `CommandResolver` (direct mode with PATH lookup, shell mode with explicit shell, cwd containment); verify integration tests that arguments with spaces, quotes, `$`, `;`, `&`, `|`, `*` arrive literally and that an outside-project cwd is rejected
- [ ] 6.4 Implement Linux `EnvProvider` (login shell with markers, 5 s timeout, `stdin: ignore`, denylist, overrides last, refresh action); verify integration tests with a temporary `HOME` containing noisy and hanging rc files, and a test asserting no `ELECTRON_*` variables reach a child
- [ ] 6.5 Build the command editor UI (mode selector with shell label, cwd, env overrides with secret flag and masking, stop timeout) and `previewEnvironment`/`revealSecret`; verify E2E that secrets are masked by default and the plaintext-storage disclosure is shown
- [ ] 6.6 Implement `openFolder` (directory check before `shell.openPath`) and `openInEditor` (argv template, `{path}` as one argument, `launchDetached`, survives quit); verify integration tests with a fake editor executable and a non-directory path rejection
- [ ] 6.7 Verify the desktop-launch environment manually by launching the built app from a temporary `.desktop` entry and comparing a child's `PATH` with the login shell, removing the entry afterwards; record the result as a note (manual check)
- [ ] 6.8 Add confirmation dialogs for remove and destructive actions and keyboard shortcuts (start/stop/restart selected, focus filter, navigate projects) with a shortcut help view; verify E2E keyboard-only flow add project → add command → start → stop
- [ ] 6.9 Document command modes, environment resolution, and secret handling in `docs/commands.md`; verify examples in the doc match E2E fixtures
- [ ] 6.10 Run `npm run verify && npm run test:e2e`, hand the group to `reviewer2`, and verify the review request and findings are recorded
- [ ] 6.11 Fix all L5 findings and obtain an independent `reviewer2` re-review; verify the re-review outcome is recorded with no open findings

## 7. L6 — Logs and high-volume performance

- [ ] 7.1 Implement `LineSplitter` (LF/CRLF, lone `\r`, 100 ms partial flush, 16 KiB truncation) with `StringDecoder`; verify unit tests for each process-logs line-handling scenario including multibyte characters split across chunks
- [ ] 7.2 Implement `RunBuffer` (10,000 lines / 8 MiB per run, current + previous run, 64 MiB global cap with eviction order); verify unit tests for every cap and eviction case
- [ ] 7.3 Implement the redactor (exact match, length ≥ 4, applied before retention) and the short-secret warning; verify unit tests and an E2E test that a printed secret is redacted in view and clipboard
- [ ] 7.4 Implement the batcher with ack-based backpressure and skip markers, and `logs.read`/`logs.clear`; verify unit tests for exact delivered + skipped accounting
- [ ] 7.5 Implement the ANSI SGR parser in `src/shared/ansi` stripping all other CSI/OSC/DCS/control sequences; verify unit tests including OSC 52, OSC 8, title, and cursor sequences, plus a property-style test that output never contains ESC
- [ ] 7.6 Build the virtualized log view (stream markers, timestamps, follow/pause with new-output indicator, text and stream filter, copy as plain text, clear); verify E2E tests for each log-view control scenario and that HTML/script output renders literally
- [ ] 7.7 Implement in-app perf probes and `npm run test:perf` scenarios P1–P4 from design D14 with thresholds fixed in code before the first run; verify all thresholds pass on the development machine and record the measured values as notes
- [ ] 7.8 If any P1–P4 threshold fails, stop, record the failure without changing thresholds, and request gate G-2; verify the gate decision is recorded before continuing
- [ ] 7.9 Verify an E2E renderer-reload-during-flood test shows no duplicate or reordered `seq` `[spec:process-logs/user-interface-reloaded]`
- [ ] 7.10 Document retention limits, cross-stream ordering, redaction limits, and no-disk logging in `docs/logs.md`; verify documented numbers match the constants in code
- [ ] 7.11 Run `npm run verify && npm run test:e2e && npm run test:perf`, hand the group to `reviewer2`, and verify the review request and findings are recorded
- [ ] 7.12 Fix all L6 findings and obtain an independent `reviewer2` re-review; verify the re-review outcome is recorded with no open findings

## 8. L7 — Port inspection (Linux)

- [ ] 8.1 Implement the `/proc/net/tcp{,6}` parser and inode → PID mapping with `restricted` owners; verify unit tests against captured fixtures, including IPv6 and unreadable `fd` directories
- [ ] 8.2 Attribute listeners to commands via attribution sets; verify an integration test where a grandchild fixture listens and the port is attributed to its command
- [ ] 8.3 Build the ports view (managed and all-listeners, restricted marker, refresh time, 3 s polling only while visible, no actions on unmanaged processes); verify E2E tests for each port-inspection scenario and a unit test that the ports service has no signalling dependency
- [ ] 8.4 Verify scan performance with 1,000 sockets completes in < 100 ms in an integration test
- [ ] 8.5 Document port inspection scope and restrictions in `docs/ports.md`; verify the doc lists the restricted case
- [ ] 8.6 Run `npm run verify && npm run test:e2e`, hand the group to `reviewer2`, and verify the review request and findings are recorded
- [ ] 8.7 Fix all L7 findings and obtain an independent `reviewer2` re-review; verify the re-review outcome is recorded with no open findings

## 9. L8 — Linux packaging

- [ ] 9.1 Configure `electron-builder` for x64 AppImage and `.deb` with fuses from design D2; verify `npm run dist:linux` produces both artifacts and a test reads the fuse state of the packaged binary
- [ ] 9.2 Implement `--smoke-test` (load app, check config dir writable, platform implementation available, exit 0 without running commands); verify it exits 0 for the unpacked build
- [ ] 9.3 Strip AppImage runtime variables from child environments; verify an integration test run inside the AppImage shows none of them in a child
- [ ] 9.4 Add an AppArmor profile to the `.deb` for Ubuntu 24.04 and ensure `chrome-sandbox` permissions; verify the package contents and that the app never launches with `--no-sandbox`
- [ ] 9.5 Obtain gate G-5, then run `scripts/smoke-linux.sh` in Ubuntu 22.04, Ubuntu 24.04, Debian 12, Debian 13, and Fedora containers under Xvfb; verify `.deb`/AppImage smoke results are recorded per distribution, with AppImage-without-`libfuse2` recorded as an expected, documented failure
- [ ] 9.6 Verify the `.deb` on a real Ubuntu 24.04 host with the AppArmor user-namespace restriction enabled (launches with profile; failure mode without it documented); mark as BLOCKED, not passed, if no host is available
- [ ] 9.7 Verify the glibc floor of the packaged Electron binaries is ≤ 2.35 via `objdump -T` and record it
- [ ] 9.8 Document Linux installation, requirements (`libfuse2` for AppImage), and supported distributions in `docs/install-linux.md`; verify the support list matches recorded smoke results
- [ ] 9.9 Run the full gate plus packaging smoke, hand the group to `reviewer2`, and verify the review request and findings are recorded
- [ ] 9.10 Fix all L8 findings and obtain an independent `reviewer2` re-review; verify the re-review outcome is recorded with no open findings

## 10. L9 — Linux MVP integration and release candidate

- [ ] 10.1 Switch `scripts/spec-coverage.mjs` to required mode; verify it reports zero unmapped scenarios except those explicitly marked manual with a recorded manual result
- [ ] 10.2 Run an end-to-end acceptance pass on the packaged `.deb` on Debian 13: register two projects with three commands, start all, flood logs, view ports, quit with running commands, crash and recover; verify every step and result is recorded as a note
- [ ] 10.3 Run an accessibility and keyboard pass (focus order, visible focus, labelled controls, shortcut help); verify findings are fixed or recorded as deferred with reasons
- [ ] 10.4 Verify `README.md` states "Linux only; Windows not yet supported", links all docs, and repeats the secrets and crash-cleanup limitations
- [ ] 10.5 Run `npm run verify && npm run test:e2e && npm run test:perf && npm run dist:linux`, hand the change to `reviewer2` for a final review, and verify the review request and findings are recorded
- [ ] 10.6 Fix all final findings and obtain an independent `reviewer2` re-review; verify the re-review outcome is recorded with no open findings

## Workflow follow-up

- Archive `establish-foundation` with `/opsx:archive` only after group 10 is complete and approved.
- Start the Windows changes from design D15 (`assess-windows-platform` first) only once native Windows access is available; gates G-4 and G-6 apply.
- Add `context`/`rules` to `openspec/config.yaml` only with explicit approval.
