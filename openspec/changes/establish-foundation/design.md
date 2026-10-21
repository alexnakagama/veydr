# Design

## Context

The repository contains only the OpenSpec scaffold; there is no application code, no commits, and no existing specs. See `proposal.md` for motivation and scope, and the six spec deltas under `specs/` for required behavior.

Constraints that shape this design:

- Electron + TypeScript + Node.js only. No Go, Rust, sidecar, separate backend service, FFI, native addon, or helper binary without explicit approval.
- Linux (x64) is the first and only verified target of this change. Windows is designed for at the boundary level but not implemented or claimed.
- The development machine is Debian 13 (GNOME/Wayland, cgroup v2, systemd user session, kernel 6.12). No native Windows environment is available.
- A separate technical spike was intentionally skipped. High-risk assumptions are validated by automated tests inside the real application, with explicit thresholds and stop-and-ask gates (see "Approval gates").

## Goals / Non-Goals

**Goals:**

- A secure, layered Electron application whose renderer cannot execute commands or touch the filesystem except through named, validated operations.
- Correct, test-proven process-tree termination on Linux, with honest reporting of what cannot be guaranteed.
- Bounded memory and a responsive UI under high-volume output, proven by repeatable performance tests.
- Platform boundaries that let Windows implementations be added later without changing shared code or the renderer API.

**Non-Goals:**

- Windows or macOS runtime support, Windows packaging, code signing.
- Terminal emulation / PTY, interactive stdin, auto-restart, watch mode, log files on disk, project auto-detection, tray integration, workspaces, Docker or Git integration, auto-update.
- Keychain-backed secret storage (post-MVP; plaintext + masking is an accepted MVP limitation).
- cgroup-based containment on Linux unless approved via gate G-3.

## Decisions

### D1. Single Electron application, three isolated layers

```
+------------------------------------------------------------------+
| main (Node.js, privileged)                                       |
|  index.ts (composition root: selects platform impl)              |
|  app/ lifecycle, window, single-instance, quit orchestration     |
|  ipc/ handlers: schema validation + sender check -> services     |
|  config/ projects/ supervisor/ logs/ ports/  (no Electron import)|
|  platform/ types.ts | linux/ | windows/ (stubs) | unsupported.ts |
+-----------^-------------------------------------+----------------+
            | ipcMain.handle / webContents.send   | child_process
+-----------+-----------+                         v
| preload (sandboxed)   |                 managed process trees
| contextBridge: typed  |
| window.veydr API      |
+-----------^-----------+
| renderer (sandboxed): React UI, text-only output rendering       |
+------------------------------------------------------------------+
```

- Services under `src/main/{config,projects,supervisor,logs,ports}` import neither `electron` nor `platform/linux|windows` directly; they receive platform implementations and an event sink by constructor injection from `src/main/index.ts`. This keeps them unit-testable in plain Node and movable to a different process if gate G-2 is triggered.
- `src/shared` holds API types, zod schemas, and pure functions used by both sides (e.g., the ANSI parser).
- **Alternatives considered:** a separate Go sidecar (rejected by product decision); running the supervisor in an Electron `utilityProcess` from the start (deferred: adds a message boundary and lifecycle without evidence it is needed; kept as the G-2 fallback).

Repository layout (single package at repo root):

```
package.json  electron.vite.config.ts  electron-builder.yml  tsconfig*.json
src/main/        src/preload/        src/renderer/        src/shared/
test/unit/       test/integration/   test/e2e/            test/perf/
test/fixtures/proc/   (Node scripts: tree, flood, listen, ignore-term, escape)
scripts/         (verify, spec-coverage, smoke)
docs/            (user-facing limitations: processes, secrets, logs)
```

### D2. Security baseline

- `BrowserWindow` webPreferences: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webviewTag: false`, no `preload` other than ours.
- Content is served from a privileged custom scheme (`app://veydr/`) via `protocol.handle`, so a CSP header can be set and the origin is checkable. CSP: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. Dev mode (Vite HMR) uses a relaxed CSP limited to `localhost` and is never packaged.
- `will-navigate` and `will-redirect` prevented; `setWindowOpenHandler` → deny; all permission requests denied via `session.setPermissionRequestHandler`.
- Every `ipcMain.handle` is registered through one helper that (a) checks `event.senderFrame` is the main frame of our window with origin `app://veydr`, (b) parses the payload with the operation's zod schema, (c) maps errors to typed results. There is no generic `invoke(channel, …)` in preload.
- Electron fuses for packaged builds: `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off, `EnableNodeCliInspectArguments` off, `EnableEmbeddedAsarIntegrityValidation` on, `OnlyLoadAppFromAsar` on, `EnableCookieEncryption` on. Applied through electron-builder's fuse configuration if supported by the pinned version; otherwise `@electron/fuses` (requires dependency approval).
- Secrets: renderer receives masked environment values only. Revealing a value is an explicit `commands.revealSecret(commandId, key)` call triggered by a user action.
- **Threat model (explicit):** the API necessarily lets the UI edit and start commands, so a compromised renderer is equivalent to arbitrary code execution as the user. Defense therefore centers on preventing renderer compromise: no remote content, strict CSP, text-only output rendering (D9), removal of non-SGR escape sequences. Electron settings alone do not make user-configured command execution safe; the user is trusted to configure their own commands.

### D3. Preload API surface

Grouped, named operations only (exact payload schemas live in `src/shared/api`):

| Group | Operations |
|---|---|
| `app` | `getInfo`, `onNotice` (recovery, config warnings) |
| `projects` | `list`, `pickDirectory`, `add`, `update`, `remove`, `relocate`, `openFolder`, `openInEditor` |
| `commands` | `upsert`, `remove`, `previewEnvironment` (masked), `revealSecret` |
| `processes` | `snapshot`, `start`, `stop`, `restart`, `onState`, `resolveSurvivors` |
| `logs` | `read(runId, fromSeq, limit)`, `clear(runId)`, `onBatch`, `ack(batchId)` |
| `ports` | `list` |
| `settings` | `get`, `setEditor` |

Event subscriptions return an unsubscribe function; listeners are removed on unload. Main tracks subscribers per `webContents` and stops sending to destroyed ones. On load, the renderer calls `processes.snapshot` and resumes logs from the retained buffer (spec: UI reloaded).

### D4. Configuration storage

- Location: `app.getPath('userData')` (Electron honors `XDG_CONFIG_HOME`; resolves to `~/.config/Veydr` on Linux and `%APPDATA%\Veydr` on Windows). Files: `config.json`, `config.json.bak`, `config.corrupt-<timestamp>.json`, `runtime/ledger.json`.
- Schema: zod schema with `schemaVersion: 1`; forward-only migrations `vN → vN+1` as pure functions with fixture tests. Newer-than-supported → read-only mode (spec: Newer schema protected).
- Atomic write: write `config.json.tmp` (mode `0600`) → `FileHandle.sync()` → rename over `config.json` → fsync the directory (Linux). Before replacing, copy the current valid file to `.bak`. Windows-specific rename retries on `EPERM`/`EBUSY` are a known follow-up and isolated in the atomic-write module.
- Writes are serialized through a single queue; the single-instance lock (`app.requestSingleInstanceLock`) guarantees one writer per user session.
- **Alternative considered:** SQLite (rejected: native dependency, overkill for a small document); `electron-store` (rejected: less control over atomicity, recovery, and permissions).

### D5. Platform boundary

```ts
interface ProcessTree {
  spawn(plan: SpawnPlan): ManagedProcess
  launchDetached(plan: SpawnPlan): void
  findSurvivors(entries: LedgerEntry[]): Promise<Survivor[]>
  terminateSurvivors(s: Survivor[]): Promise<StopResult>
}
interface ManagedProcess {
  readonly pid: number | undefined
  readonly identity: ProcessIdentity          // opaque, platform-defined
  readonly stdout: Readable; readonly stderr: Readable
  onExit(cb: (e: ExitInfo) => void): void
  stop(opts: { graceMs: number }): Promise<StopResult>
}
type StopResult = { graceful: 'yes' | 'no' | 'unsupported'; forced: boolean; survivors: ProcInfo[] }
type ExitInfo  = { code: number | null; signal: string | null; forced: boolean }
interface CommandResolver { resolve(spec: CommandSpec, env: Env): ResolveResult }   // plan | diagnostics
interface EnvProvider     { base(): Promise<{ env: Env; warnings: string[] }> }
interface PortInspector   { list(): Promise<PortSnapshot> }                          // owner: known|restricted|unknown
```

- `src/main/platform/index.ts` is the only place that reads `process.platform`. Linux → `platform/linux`; Windows → `platform/windows`, whose implementations throw `UnsupportedPlatformError` in this change (spec: Explicit unsupported-platform behavior).
- Lint (`no-restricted-imports`, `no-restricted-properties`) forbids importing `platform/linux|windows` and reading `process.platform` outside `src/main/index.ts` and `src/main/platform/index.ts`.
- Shared code treats `Env` as an opaque map with platform-provided key comparison, paths via `node:path` only, and splits CRLF — so Windows can be added without touching shared modules.
- **Static vs runtime evidence:** TypeScript type-checking covers all modules but is OS-agnostic; it is not evidence of Windows behavior. Windows parsers/quoting may get Linux-run unit tests from fixtures, which are marked synthetic until re-recorded on native Windows.

### D6. Command resolution and environment (Linux)

- **Direct mode** (default): `spawn(file, args, { shell: false })`. `file` containing `/` is resolved against the working directory; otherwise looked up in the effective `PATH` by Veydr first, to produce a precise "not found" diagnostic.
- **Shell mode**: `spawn(shellPath, ['-c', script])`, never `shell: true`. `shellPath` defaults to `/bin/sh`; the user may select another absolute shell path per command. The UI labels the command and shows the shell (spec: Explicit shell mode).
- Working directory: `path.resolve(projectRoot, cwd)` must stay within `projectRoot` after `realpath` (spec: Working directory outside project rejected).
- **Environment**: base = login environment obtained once per session by running `$SHELL -l -i -c` printing `env -0` between unique markers, `stdin: 'ignore'`, 5 s timeout, junk outside the markers ignored. Fallback = `process.env` minus the runtime denylist (`ELECTRON_*`, `APPDIR`, `APPIMAGE`, `ARGV0`, `OWD`, `CHROME_DESKTOP`, plus any variable empirically confirmed in L5 tests to be injected by Electron/AppImage). Overrides applied last. A "refresh environment" action re-resolves.
- `stdio: ['ignore', 'pipe', 'pipe']` (spec: Standard input not connected).
- **Windows notes (not implemented):** Node refuses to spawn `.cmd`/`.bat` without a shell (CVE-2024-27980 hardening), so tools like `npm` need an explicit, correctly quoted `cmd.exe /d /s /c` route with injection tests; environment comes from the registry with case-insensitive keys. Both belong in the Windows changes.

### D7. Supervisor and state machine

One actor per command; actions are queued and processed one at a time.

```
 idle|exited|failed --start--> starting --spawn ok--> running --exit--> exited
                                  | spawn error           |
                                  v                       | stop
                                failed                    v
                                                      stopping --tree gone--> exited (graceful|forced)
 start while starting/running -> returns current run (no-op)
 stop while stopping          -> joins in-flight stop
 restart                      -> stop (await completion) -> start
```

- Every run gets a `runId`; all events carry `{commandId, runId, seq}`. Consumers drop events whose `runId` is not current (spec: Late events ignored).
- The supervisor never auto-starts or auto-restarts (spec: No automatic command execution / No automatic restart).

### D8. Linux process-tree strategy

- Spawn with `detached: true`: libuv calls `setsid()`, so the leader's PID = process group ID = session ID. Without this, children would share Electron's group and a group signal could hit Veydr itself.
- **Attribution set** of a run = processes whose session ID equals the run's session ID (catches descendants that only change process group) ∪ tracked descendants (processes observed via `/proc/<pid>/stat` PPID chains from the leader, recorded as `(pid, starttime)`), which catches descendants that called `setsid` while Veydr observed them.
- Tracking: a `/proc` scan runs every 2 s while any run is active and immediately at stop start. Each scan reads `/proc/*/stat` once for all runs.
- **Stop:** `SIGTERM` to `-pgid` and to each tracked descendant whose current starttime matches → poll attribution set every 100 ms → after `graceMs`, `SIGKILL` to the same targets → wait up to 1 s → survivors = attribution set still alive → `StopResult`.
- Identity: `ProcessIdentity` on Linux = `(pid, starttime from /proc/<pid>/stat field 22, boot_id)`. Only unreaped direct children are signalled by PID alone (safe: the PID cannot be reused before reaping); everything else is re-verified immediately before signalling. A residual race between verification and `kill()` remains (no pidfd in Node); it is documented.
- **Known limitation:** a descendant that calls `setsid` and whose parent exits between two scans is never observed and cannot be attributed. Documented (spec: Documented crash limitation).
- **Alternative considered — systemd user scopes** (`systemd-run --user --scope` + `cgroup.kill`): stronger containment of escapees and identity by unit name; requires a systemd user session, adds per-spawn latency and an external system dependency. Not adopted in this change; evaluated with measurements in task group L3 and adopted only via gate G-3.

### D9. Crash recovery ledger

- `runtime/ledger.json` (atomic writes) holds, per active run: `commandId`, `runId`, leader identity, session ID, and tracked descendant identities (updated after scans that change the set, at most once per second). Cleared entries on run exit; empty file after clean quit.
- On launch: if any entries exist, verify `boot_id` matches; then each recorded identity whose starttime still matches, plus processes in a recorded session whose starttime ≥ the leader's and (if the leader PID is alive) whose leader identity matches, are survivors. Survivors are shown via `app.onNotice` with name and command line; termination happens only after the user confirms (`processes.resolveSurvivors`). Nothing is restarted.
- Electron receiving `SIGTERM`/`SIGINT`/`SIGHUP` (e.g., session logout) runs the same stop-all path with a 10 s overall deadline, then exits; the ledger keeps anything not verified stopped.

### D10. Quit orchestration

`before-quit` → `preventDefault` → if runs are active, show a stopping overlay and call `stopAll` (parallel, each with its own `graceMs`, overall deadline = max grace + 2 s). All verified stopped → quit. Otherwise → dialog listing survivors with **Retry** / **Quit anyway**; quitting anyway leaves those entries in the ledger so the next launch reports them (spec: Stop failures on quit).

### D11. Log pipeline

```
child stdout/stderr --'data'--> StringDecoder(utf8) --> LineSplitter --> Redactor
  --> RunBuffer (ring) --> Batcher(50ms | 1000 lines | 256 KiB) --> webContents.send
                                    ^ acks from renderer (max 4 unacked batches)
```

- Streams are never paused; output is always consumed (spec: Output does not block processes).
- `LineSplitter`: `\n` / `\r\n`; partial line flushed after 100 ms idle; 16 KiB cap with truncation marker; lone `\r` within a line (progress bars) keeps only the text after the last `\r`. Invalid UTF-8 → U+FFFD (decoder behavior).
- `Redactor`: exact-match replacement of the run's secret values (length ≥ 4) with `[redacted]` before retention, so secrets never reach the renderer or clipboard via logs.
- `RunBuffer`: per run ≤ 10,000 lines and ≤ 8 MiB (UTF-8 bytes estimated at ingestion); current + previous run per command; **global cap 64 MiB** across all buffers, evicting previous runs first, then oldest lines of the largest current run.
- Backpressure toward the renderer: when 4 batches are unacknowledged, live delivery switches to counting skipped lines; on the next ack a `skipped {fromSeq, toSeq}` marker is sent and the renderer may fetch retained lines via `logs.read`.
- Renderer: `@tanstack/react-virtual` list of fixed-height, non-wrapping rows with horizontal scroll; filter runs over retained lines in a deferred, chunked pass.
- ANSI: an in-house parser in `src/shared/ansi` converts SGR (16/256/truecolor, bold, dim, italic, underline, inverse, reset) into style spans and strips every other CSI/OSC/DCS/control sequence. Rendered as React text nodes only. Kept in-house because it is small and security-relevant.
- **Alternatives considered:** sending every chunk immediately (rejected: IPC flood); persisting logs to disk (non-goal); `xterm.js` (rejected: terminal emulation is a non-goal and it interprets far more escape sequences).

### D12. Port inspection (Linux)

Parse `/proc/net/tcp` and `/proc/net/tcp6` (state `0A` = LISTEN) → socket inodes; map inode → PID by reading `/proc/<pid>/fd/*` symlinks (`socket:[inode]`). Unreadable `fd` directories (other users/root) → owner `restricted`. Attribution to commands uses the D8 attribution sets. Pure `fs` reads, no external tools; polled every 3 s only while the ports view is visible. Read-only by construction: the ports service has no access to any signalling API.

### D13. Dependencies (pinned exact versions, approval required before installation)

| Dependency | Justification |
|---|---|
| `electron` | Runtime |
| `react`, `react-dom` | Renderer UI (no repository evidence favors another framework) |
| `typescript` | Strict typing |
| `electron-vite`, `vite` | One build pipeline for main/preload/renderer with HMR; avoids custom glue |
| `electron-builder` | AppImage + deb now, NSIS later, from one config; fuse configuration |
| `zod` | Runtime validation of IPC payloads and config with inferred types |
| `@tanstack/react-virtual` | Log list virtualization |
| `vitest` | Unit and integration tests in Node |
| `@playwright/test` | Electron E2E via `_electron` |
| `eslint`, `typescript-eslint`, `eslint-plugin-react-hooks` | Linting, import-boundary rules |

Explicitly not used: process-tree utilities (`tree-kill`, `ps-tree`) — we need identity-checked behavior; ANSI libraries; state libraries; FFI (`koffi`) or native addons — require approval (G-4). Package manager: npm (avoids electron-builder's hoisting requirements under pnpm). Any further dependency requires a written justification and approval.

### D14. Test strategy and thresholds

| Layer | Tooling | Scope |
|---|---|---|
| Unit | vitest (Node) | config schema/migrations/atomic write (fault injection), FSM transitions, splitter, ring buffer caps, redactor, ANSI parser, IPC schemas, path validation, env parsing |
| Integration | vitest (Node) + `test/fixtures/proc/*.mjs` run with `process.execPath` | real process trees: graceful, forced, escaped descendants, sentinel safety, PID-reuse, ledger recovery after `SIGKILL` of a supervisor host process, `/proc` port parsing |
| E2E | Playwright `_electron` on the built app | security baseline checks, add project → command → start → logs → stop, reload, quit with running commands, crash recovery notice |
| Performance | Playwright + in-app probes (`perf_hooks.monitorEventLoopDelay`, IPC ping, `app.getAppMetrics`) | thresholds below |
| Packaging smoke | built AppImage/deb + `--smoke-test` | Linux distributions in L8 |

Integration tests that exercise process trees repeat each scenario 50 times (`VEYDR_STRESS=1`; 5 by default for fast local runs). Every test asserting cleanup enumerates `/proc` independently of Veydr's own bookkeeping, and every run includes a sentinel process started outside the supervisor that must survive.

**Performance thresholds** (verified in L6 inside the real app; thresholds are fixed before measurement and never relaxed silently):

| Scenario | Thresholds |
|---|---|
| P1: 1 producer, 50,000 lines/s × 100 B, 60 s | main event-loop delay p99 ≤ 50 ms; renderer→main IPC ping p95 ≤ 50 ms; main heap ≤ 150 MB and growth < 1 MB / 10 s over the last 30 s; renderer long tasks ≤ 200 ms; producer throughput ≥ 80 % of `| cat > /dev/null` baseline |
| P2: 10 producers × 5,000 lines/s, 60 s | same, with main heap ≤ 200 MB |
| P3: renderer blocked 2 s mid-stream | delivered + declared-skipped = produced (exact) |
| P4: filter typing during P1 | keystroke-to-render p95 ≤ 100 ms |

**Spec traceability:** test titles carry `[spec:<capability>/<scenario-slug>]`; `scripts/spec-coverage.mjs` lists scenarios without a test. Informational from F1, required (zero unmapped, except scenarios explicitly marked manual) in L9.

**Verification commands** (created in F1): `npm run typecheck`, `npm run lint`, `npm test` (unit), `npm run test:integration`, `npm run test:e2e`, `npm run test:perf`, `npm run verify` (typecheck + lint + unit + integration + spec-coverage), `npm run dist:linux`.

### D15. Implementation phases and review workflow

This change covers the foundation and the Linux MVP (task groups F1, L1–L9 in `tasks.md`). Windows work follows in separate changes once native Windows access exists:

1. `assess-windows-platform` (W0): native evidence for libuv job-object behavior for grandchildren, `taskkill /T` coverage, graceful-stop options, `.cmd`/`.bat` quoting and injection corpus, `netstat -ano` parsing on a localized Windows, registry environment, output code pages, NSIS build. Ends with a decision on FFI (G-4).
2. `add-windows-process-supervision`, `add-windows-environment-and-commands`, `add-windows-port-inspection` (W1–W3): implementations + Windows scenarios as spec deltas, verified natively.
3. `add-windows-packaging` (W4): NSIS per-user installer, smoke tests, signing decision (no spending without approval).
4. Cross-platform release: both OSes in CI for every change.

Every task group ends with: run its verification commands → hand off to the `reviewer2` session (change name, group, changed files or commit range, acceptance criteria, command output) → fix findings → independent re-review by `reviewer2` → record the outcome in `tasks.md` → only then start the next group. A review is never recorded unless it actually happened.

## Risks / Trade-offs

- [Supervisor and log pipeline share the main event loop; a log flood may degrade window/IPC responsiveness] → P1–P4 thresholds in L6; if they fail, stop and request approval to move services into a `utilityProcess` (G-2). Services have no Electron imports to keep that move contained.
- [Electron main crash leaves process trees running on Linux; Node cannot set a parent-death signal] → crash ledger + survivor detection on next launch with user-confirmed termination; documented limitation.
- [Descendants that `setsid` and orphan themselves between scans escape attribution] → 2 s scans plus scan at stop start; session-ID attribution; documented; systemd scope evaluation (G-3).
- [PID verification/kill race without pidfd] → verify starttime immediately before each signal, never signal by PID alone except unreaped direct children; documented residual risk.
- [Login-shell environment resolution hangs or prints noise] → markers, `stdin: ignore`, 5 s timeout, fallback with warning, tested with a temporary `HOME` containing adversarial rc files.
- [Secrets in plaintext and in output] → `0600` permissions, masked UI, redaction before retention, explicit disclosure; no stronger guarantee is claimed.
- [Renderer compromise equals command execution] → no remote content, CSP, text-only rendering, escape stripping, sender checks.
- [Ubuntu 24.04 AppArmor restriction on unprivileged user namespaces breaks Chromium's sandbox] → ship an AppArmor profile in the `.deb`; verify on a real Ubuntu 24.04 host (L8); never ship `--no-sandbox`.
- [AppImage requires `libfuse2`, absent by default on recent distributions] → document; offer `.deb` as primary for Debian/Ubuntu.
- [Linux tests do not prove Windows behavior] → Windows stays unsupported (explicit error) in this change; all Windows notes are labelled unverified.
- [Large single change] → work is split into reviewable groups with independent gates; the change is archived only after L9.

## Migration Plan

Greenfield; no data migration. Configuration starts at `schemaVersion: 1`. Rollout: Linux-only pre-release builds after L9, labelled "Linux only; Windows not yet supported". Rollback for users: uninstall; configuration in the user data directory is left in place and is forward-compatible within schema rules (D4).

## Approval Gates

These are not open questions: the approach is fixed, but proceeding past each gate requires explicit approval.

- **G-1 (before F1):** installation of the D13 dependencies with pinned versions; Git initialization of history (first commit, `main` branch) so groups can be reviewed by commit range; `reviewer2` session available.
- **G-2 (L6, conditional):** if P1–P4 fail with services in main, approval to move supervisor/log services into an Electron `utilityProcess`.
- **G-3 (L3, conditional):** adopting `systemd-run --user --scope` containment on Linux, and the resulting support statement for systems without a systemd user session.
- **G-4 (Windows phase):** introducing FFI, a native addon, or a helper binary for Windows Job Objects / console control events, or accepting forced-only stop on Windows.
- **G-5 (L8):** pulling Docker base images for distribution smoke tests and access to a real Ubuntu 24.04 host.
- **G-6 (Windows phase):** any paid signing certificate or service.

## Open Questions

- Default editor templates to offer as presets (e.g., `code {path}`) — deferrable; does not change specs or tasks.
- Exact visual design tokens for the dark theme — deferrable to L5/L6 implementation.
