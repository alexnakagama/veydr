# Proposal

## Why

Windows support is planned (foundation design D15), but code outside `src/main/platform` still assumes Linux: environment variable names are compared case-sensitively, the atomic write assumes POSIX rename and directory-flush semantics, the command editor rejects Windows paths, and `npm run verify` cannot run on Windows. Nothing runs on Windows in CI either, so these assumptions go unnoticed. The Windows changes (W0 `assess-windows-platform`, then W1–W4) need a codebase whose shared parts already behave correctly on Windows, and a Windows CI lane to collect native evidence on. This change provides both without claiming Windows support.

## What Changes

- **Platform conventions.** The `Platform` interface gains a small set of conventions chosen by the composition root: how environment variable names compare (exact on Linux, case-insensitive on Windows), the default shell for new shell-mode commands (`/bin/sh` on Linux, none on Windows until W2), and whether the filesystem supports flushing a directory. The Windows stub reports Windows conventions; its operations still reject with `UnsupportedPlatformError`.
- **Environment overrides follow the platform's name rule.** Applying overrides, the environment preview, and saving a command use the platform's comparison, so on Windows an override `PATH` replaces the inherited `Path` and two overrides differing only in case are rejected.
- **Project paths compare case-insensitively when they are Windows paths** (drive letter or UNC), so `C:\proj` and `c:\proj` cannot be registered twice. POSIX paths keep exact comparison.
- **Atomic writes tolerate transient locks.** A rename failing with `EPERM`, `EBUSY`, or `EACCES` is retried a bounded number of times before the save fails. The directory flush is skipped where the platform does not support it, instead of logging a warning on every save. Applies to the configuration and the run ledger.
- **Renderer stops assuming POSIX.** The command editor validates the shell path with the shared `isAbsolutePath` and takes its default shell from `app.getInfo`; the Ports view's "restricted" explanation no longer names Linux.
- **Tooling.** `scripts/verify.mjs` runs npm in a way that works on Windows under Node 24; a `.gitattributes` keeps text files LF and marks binary fixtures as binary.
- **Windows CI lane.** A `windows` job on `windows-2025` runs typecheck, lint, and unit tests on every pull request and push to `master`, and is part of `ci-ok`. Tests that need Linux (integration, end-to-end, packaging, and Linux-only unit tests) are skipped on Windows with a named reason, never silently.
- **Not changed:** Windows remains "not yet supported" in the specs, the README, and the app. No Windows process supervision, command resolution, environment, port inspection, or packaging is added.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `project-registry`: duplicate project detection treats Windows paths case-insensitively; environment overrides match inherited variables and each other according to the platform's variable-name rule.
- `config-storage`: atomic persistence retries a save step that fails because another program briefly holds the file, and stays atomic when it gives up.
- `quality-gates`: the pull request and `master` check set includes a Windows lane (typecheck, lint, unit tests), and tests that cannot run on an operating system are skipped there with a stated reason.

## Impact

- **Code:** `src/main/platform/{types,index,unsupported}.ts`, `src/main/platform/{linux,windows}/index.ts`, `src/main/projects/{environment,service}.ts`, `src/main/config/{atomic,fs,store}.ts`, `src/main/supervisor/ledger.ts`, `src/main/index.ts`, `src/main/ipc/handlers.ts`, `src/shared/config/schema.ts`, `src/shared/api/app.ts`, `src/renderer/src/{CommandEditor,PortsView,App}.tsx`.
- **API:** `app.getInfo` gains the platform's default shell and environment-name rule (additive; the preload bridge shape is unchanged).
- **Configuration:** no schema version change; existing Linux configurations validate exactly as before.
- **Tests and CI:** new unit tests for conventions, case rules, and rename retries; `skipIf` guards with reasons on Linux-only suites; `.github/workflows/ci.yml`, `.github/actions/setup/action.yml`, `test/unit/workflow-policy.test.ts`; `scripts/verify.mjs`; new `.gitattributes`.
- **Docs:** `docs/ci.md` (new job), `docs/configuration.md` (retry behavior). README platform statements are unchanged.
- **Dependencies:** none.
- **Follow-ups (out of scope):** shell argument conventions and the schema migration they need, `.cmd`/`.bat` routing and quoting, `PATHEXT` (W2); output code pages (W0/W2); logoff shutdown and smoke-test output from the GUI executable (W1/W4); DPAPI-backed secrets; Job Objects, process identity, port inspection, and the koffi-versus-helper decision under gate G-4 (W0, then W1/W3).
