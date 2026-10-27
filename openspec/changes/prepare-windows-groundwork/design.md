# Design

## Context

See `proposal.md` for motivation. Foundation design D5 put everything OS-dependent behind `src/main/platform` and allowed only `src/main/index.ts` and `src/main/platform/index.ts` to read `process.platform` (lint-enforced). Three places outside that boundary still bake in Linux behavior:

- `effectiveEnvironment` and `previewEntries` (`src/main/projects/environment.ts`) merge overrides with exact key matching, and the duplicate-override checks in `src/shared/config/schema.ts` (stored command) and `src/shared/api/commands.ts` (`commandInputSchema`) use a `Set` of exact keys.
- `writeFileAtomic` (`src/main/config/atomic.ts`) renames once and always flushes the directory; it is used by the config store and the run ledger (`src/main/supervisor/ledger.ts`).
- The renderer hard-codes `/bin/sh` and a leading-`/` check in `CommandEditor.tsx`.

`projectPathKey` (shared) already recognizes Windows path syntax but compares exactly. Shared code also runs in the renderer, so it cannot use `node:path` or read the platform.

The only native Windows environment is GitHub's `windows-2025` runner (Windows Server, English locale, no interactive desktop).

## Goals / Non-Goals

**Goals:**
- Shared code and services behave correctly under Windows conventions, proven by unit tests that run on Linux with the Windows conventions injected and on the Windows runner.
- A required Windows CI job (typecheck, lint, unit) that later Windows changes extend.
- No observable change for Linux users.

**Non-Goals:**
- Any working Windows implementation of `ProcessTree`, `CommandResolver`, `EnvProvider`, or `PortInspector`; the Windows stub keeps rejecting with `UnsupportedPlatformError`.
- Running integration, end-to-end, or packaging tests on Windows.
- Choosing shell conventions for Windows (W2); Windows shell mode stays unusable because the stub rejects every resolve.

## Decisions

### D1. Conventions are data on `Platform`, not behavior spread across services

Add `readonly conventions: PlatformConventions` to `Platform`:

```ts
interface PlatformConventions {
  readonly envNames: EnvNameRule            // 'exact' | 'case-insensitive' (shared type)
  readonly defaultShell: string | null      // null: no default, the user must enter one
  readonly directorySync: boolean           // whether a directory can be flushed
}
```

| | Linux | Windows stub | Unsupported |
|---|---|---|---|
| `envNames` | `exact` | `case-insensitive` | `exact` |
| `defaultShell` | `/bin/sh` | `null` | `null` |
| `directorySync` | `true` | `false` | `true` |

`createUnsupportedPlatform` takes the conventions as a parameter so the Windows stub can supply Windows values while still rejecting every operation. `EnvNameRule` and a pure helper `envNameKey(name, rule)` (identity or `toUpperCase()`) live in `src/shared/config` because the renderer and the shared schemas need them.

*Alternative:* let each consumer read `process.platform`. Rejected: breaks the D5 lint boundary and makes Windows behavior untestable on Linux.

*Why `null` for the Windows default shell:* Veydr's shell mode runs `<shell> -c <script>`. Neither `cmd.exe` nor PowerShell accepts `-c` with that meaning, so offering one now would encode a wrong convention. W2 sets the value together with the argument convention.

### D2. Duplicate-override checks: exact in static schemas, platform rule in main and the editor

Zod schemas in `src/shared` are module-level constants used by both IPC validation and config validation; making them platform-dependent would mean schema factories threaded through the contract. Instead:

- The static schemas keep their exact-match duplicate check (it remains correct on every OS: exact duplicates are always duplicates).
- `ProjectService.upsertCommand` additionally rejects overrides whose `envNameKey` collides under the platform rule, with the same `Duplicate variable "<name>"` message, before anything is saved.
- `effectiveEnvironment(base, overrides, rule)` deletes every base entry whose key equals the override under the rule before setting the override, so the override's spelling wins. `previewEntries` merges by the same key, showing the override's name.
- The command editor uses `envNames` from `app.getInfo` to flag case-only duplicates inline, matching the server-side message.

This deviates from the scope note "the duplicate-key check in schema uses it": the outcome (rejection, nothing saved) is the same, without a contract-wide schema refactor. A stored Windows configuration with case-only duplicates cannot exist yet, because Windows has never been supported; load-time handling is therefore not needed now.

*Alternative:* build the config and contract schemas from a factory `schemas(rule)`. Rejected for now: invasive across `src/shared/api/contract.ts`, preload, and tests for no user-visible gain.

### D3. Project path keys are syntactic

`projectPathKey` lowercases a path that is a Windows path by syntax (`^[A-Za-z]:[\\/]` or a `\\` UNC prefix), after trimming trailing separators, and also normalizes `/` to `\` for such paths. POSIX paths are unchanged. This needs no platform input, so the shared schema's duplicate-path check and `ProjectService` keep calling the same function. Paths are already stored as `realpath` results; the key only affects comparison, never the stored path.

*Trade-off:* NTFS directories with per-directory case sensitivity (enabled for WSL) are treated as case-insensitive. Accepted: rare, and the failure mode is a refused duplicate, not data loss.

### D4. Atomic write: bounded rename retries, injected directory sync

`writeFileAtomic` gains two options:

- `renameRetry: { attempts: number; delayMs: number; sleep?: (ms) => Promise<void> }`, default `{ attempts: 5, delayMs: 50 }` with linear backoff (50, 100, 150, 200 ms; under 0.5 s total). Only `EPERM`, `EBUSY`, and `EACCES` are retried; any other error, or the last attempt's error, propagates unchanged. The temporary file is left for the next save to remove (existing behavior), so the target is always the complete previous version.
- `syncDirectory` stays per call; a new store/ledger-level option `directorySync: boolean` (from `platform.conventions.directorySync`, passed by `src/main/index.ts`) turns it off entirely. With it off, no `DirectorySyncError` is raised or logged.

Retries apply on Linux too: `EPERM`/`EBUSY`/`EACCES` from `rename` on Linux are effectively permanent (permissions), so Linux pays at most about 0.5 s before the same error it reports today. Accepted for one code path tested on both systems.

*Alternative:* retry only when a Windows flag is set. Rejected: adds a second path that Linux CI never exercises.

### D5. `app.getInfo` carries the conventions the renderer needs

`appInfoSchema` gains `defaultShell: string | null` and `envNames: EnvNameRule` (additive; the bridge groups are unchanged, so the smoke test's bridge check is unaffected). `CommandEditor` uses `defaultShell` for new shell commands (empty field with placeholder when `null`) and validates with the shared `isAbsolutePath`; the example in the validation message comes from `defaultShell` or is omitted. The Ports view's restricted explanation becomes "the operating system does not show its process to you".

### D6. Windows CI job

A `windows` job in `.github/workflows/ci.yml` on `windows-2025`: setup (dependencies, no Electron), typecheck, lint, `npm test`. It is added to `ci-ok`'s `needs`. Lint runs on both OSes so CRLF or path-separator assumptions in lint rules surface. Setup action changes: the Electron/electron-builder cache step is skipped on Windows (`runner.os != 'Windows'`), since this job never downloads Electron; the existing `bash` steps work with the runner's Git Bash. `test/unit/workflow-policy.test.ts` is updated for the new job list and runner.

`.gitattributes` (`* text=auto eol=lf`, `*.bin binary`, `*.png binary`) makes the Windows checkout byte-identical for fixtures and tests that compare text.

### D7. Declared skips

Linux-only suites use `describe.skipIf(process.platform !== 'linux')` with the reason in the title, e.g. `'[linux-only: reads /proc] linux procfs'`, so the reason appears in the runner output. Test files are outside the `process.platform` lint boundary (it covers `src/`). For whole projects that never run on Windows in this change (integration, e2e, packaging), the Windows job simply does not invoke them; those scripts are unchanged. Spec-coverage is unaffected: titles keep their `[spec:…]` tags and coverage is computed from source, not from runs.

Triage rule for unit tests that fail on Windows: fix the test if its assumption is incidental (hard-coded `/` joins, POSIX absolute paths as fixtures for platform-neutral code); mark it Linux-only if it exercises Linux behavior (procfs, signals, file modes, the Linux platform modules).

### D8. `scripts/verify.mjs`

Run npm through `process.execPath` and `process.env.npm_execpath` when set (true under `npm run verify`), falling back to `spawnSync('npm', …, { shell: true })` on Windows only. This avoids spawning `npm.cmd` without a shell, which Node 24 rejects with `EINVAL`.

## Risks / Trade-offs

- [Unit triage turns out larger than expected] → Linux-only marking is an allowed outcome per test; the task lists the files found during exploration, and the job only becomes required in `ci-ok` once it is green.
- [Windows Server runner differs from Windows 10/11 desktops] → this change makes no runtime claims; only shared logic and tooling are exercised.
- [Case-insensitive env merge picks the wrong spelling] → the override's spelling wins, matching how Windows treats the block; covered by the spec scenario.
- [Retry delay hides a real permission problem for up to about 0.5 s] → the final error is unchanged and still reported; bounded.
- [`windows-2025` image changes under us] → same exposure as `ubuntu-24.04`; pinned by label like the existing jobs.

## Migration Plan

No configuration or schema migration. Rollout is the normal merge; rollback is a revert. Branch protection already requires only `ci-ok`, so adding the `windows` job to its `needs` makes it required without repository-settings changes.
