# Proposal

## Why

Developers juggle several local projects, each needing multiple long-running commands (API servers, frontend dev servers, workers) spread across separate terminals. Veydr is a local-first desktop application that lets them register projects, configure commands, start/stop them explicitly, and watch their logs and ports from one place. The repository is empty; this change establishes the architecture, the security baseline, and the first complete product capabilities so implementation can begin on Linux with explicit boundaries for a later Windows adaptation.

## What Changes

- Establish an Electron + TypeScript + Node.js application (no Go, Rust, sidecar, or separate backend service) with three hardened layers: main process (privileged logic), sandboxed preload (narrow typed API), and sandboxed React renderer (presentation only).
- Introduce platform boundaries (`ProcessTree`, `CommandResolver`, `EnvProvider`, `PortInspector`) with Linux implementations and Windows stubs that fail explicitly; shared code must not depend on OS-specific modules.
- Add local configuration storage with schema versioning, validation, atomic persistence, backup and recovery, and restrictive file permissions. No accounts, cloud, telemetry, or mandatory network access.
- Add project registration (local folders, path validation, missing-folder handling, open in file manager, open in configured editor) and command configuration (direct executable + arguments by default, explicit shell mode, working directory, environment overrides, secret-flagged values).
- Add process supervision on Linux: explicit start/stop/restart, a per-command state machine, process-group based tree termination with graceful-then-forced stop, quit orchestration, and crash recovery via a ledger that reports and cleans up survivors on next launch.
- Add log capture and streaming with bounded per-run memory, line splitting, batching, safe text-only rendering of ANSI output, search/filter, follow/pause, copy, clear, and best-effort secret redaction.
- Add read-only listening-port inspection on Linux, attributing ports to managed processes and marking restricted information explicitly.
- Add Linux packaging (AppImage and `.deb`) with smoke tests; Windows packaging is deferred.
- Validate high-risk assumptions (tree termination, crash cleanup, high-volume logging, main-process responsiveness) through automated tests in the real application instead of a separate prototype.
- Windows runtime behavior is explicitly **out of scope** for this change and is not claimed; it is addressed by follow-up changes with native Windows evidence.

## Capabilities

### New Capabilities

- `desktop-shell`: Electron application shell, security baseline, preload API contract, IPC validation, single-instance behavior, and platform-boundary rules.
- `config-storage`: Location, schema versioning, validation, atomic persistence, backup/recovery, and secret-handling limitations of local configuration.
- `project-registry`: Registering, validating, and removing projects; configuring commands, working directories, environment overrides, and execution mode; opening folders and editors.
- `process-supervision`: Explicit lifecycle of configured commands, state reporting, process-tree termination, application-quit behavior, and crash recovery.
- `process-logs`: Capture, retention, streaming, rendering safety, and user controls for process output.
- `port-inspection`: Read-only reporting of listening ports and their owning processes.

### Modified Capabilities

None (no existing specs).

## Impact

- **Code**: New single-package TypeScript application at the repository root (`src/main`, `src/preload`, `src/renderer`, `src/shared`, platform modules under `src/main/platform`) as described in `design.md`.
- **Dependencies** (pending approval at the start of implementation): `electron`, `react`, `react-dom`, `typescript`, `electron-vite`, `vite`, `electron-builder`, `zod`, `@tanstack/react-virtual`, `vitest`, `@playwright/test`, `eslint`, `typescript-eslint`, `eslint-plugin-react-hooks`. No FFI, native addon, or helper binary; introducing one requires explicit approval.
- **Systems**: Linux desktop (x64). Linux tree termination relies on process groups; stronger containment via systemd user scopes is an evaluated option requiring approval. Windows is not supported by this change.
- **Process**: Implementation proceeds in task groups, each gated by an independent `reviewer2` review and re-review.
