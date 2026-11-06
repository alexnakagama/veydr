# Proposal

## Why

Veydr's Windows platform rejects every operation, so no command can be supervised on Windows. W0 (`assess-windows-platform`) recorded how Windows behaves on the `windows-2025` runner and took the native-code decision for process trees: option C, a Job Object helper built with the .NET Framework 4.8 `csc.exe` (design "Outcome" of the archived change). W1 is the first implementation change. W2 (commands and environment) and W3 (ports) build on the helper it introduces, so it comes first.

## What Changes

- **Gate G-4 approved: a helper binary for Windows.** The maintainer approved option C on 2026-11-03: a helper program built from committed C# source with the .NET Framework 4.8 `csc.exe` on Windows, never committed as a binary. A build script compiles it for development, tests, and CI; W4 packages it. It stays unsigned until the signing decision (G-6).
- **Windows process trees.** A Windows `ProcessTree` replaces the stub's `spawn`, `stop`, `findSurvivors`, and `terminateSurvivors`, through the helper:
  - every command runs in its own Job Object, assigned while the command is still suspended, so no descendant can start outside it (W0: `pt-job-race`);
  - the job also ends the command's tree if Veydr or the helper ends abnormally;
  - process identity is the PID plus the process creation time, checked before any process outside the job is ended.
- **Graceful, then forced stop on Windows.** The helper attaches to the command's hidden console and sends Ctrl+Break; after the stop timeout it terminates the job (W0: `pt-ctrl-break-attach-*`, `pt-job-terminate`). Commands are started hidden, never detached (W0: `pt-ctrl-break-detached`).
- **Crash recovery on Windows.** Runs are recorded in the run ledger as on Linux. On the next launch, recorded processes still alive and still identical are shown and can be terminated; nothing is restarted.
- **Windows CI runs the process-tree integration tests.** The `windows` job gains a step that builds the helper and runs the Windows process-tree integration tests natively. Linux integration tests stay Linux-only, skipped with a reason.
- **Not changed:** commands still cannot be started from the app on Windows. The command resolver, the environment (W2), and port inspection (W3) stay unsupported, so starting a command on Windows still fails with an unsupported-platform error and creates no process. README and docs keep "Windows not yet supported". No npm dependency is added, `electron-builder.yml` is unchanged, and Linux behavior is unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `process-supervision`: adds Windows process-tree termination (Job Object containment, identity-checked survivors), the Windows graceful-stop route, and the documented Windows crash limitation. The "Windows supervision not yet supported" requirement is narrowed: the process-tree layer is implemented and verified on native Windows, while starting a command from the app on Windows still fails until commands and environment are implemented.
- `quality-gates`: the Windows CI job also builds the helper and runs the Windows process-tree integration tests on every pull request and push to `master`.

## Impact

- **Code:** `src/main/platform/windows/` (process tree, survivors, helper client and protocol), `src/main/platform/types.ts` only if the interface needs a Windows-neutral addition, and the composition root, which passes the helper's path. `src/main/supervisor/` is unchanged apart from tests.
- **Helper:** C# source under `src/main/platform/windows/helper/`, built by a new `scripts/build-windows-helper.mjs` into a git-ignored directory. It is a new kind of build output and the first non-JavaScript executable Veydr ships; `docs/dependencies.md` records the G-4 decision.
- **Tests:** unit tests for the protocol and identity rules on every system; Windows-only integration tests (`[windows-only: Job Objects]`) for spawn, stop, escaped descendants, crash, and survivors; the rewritten `start-on-windows` test.
- **CI:** `.github/workflows/ci.yml` (`windows` job), `test/unit/workflow-policy.test.ts`, `docs/ci.md`.
- **Docs:** `docs/processes.md` (Windows notes, labelled as not yet reachable from the app), `docs/deferred-checks.md`, `docs/dependencies.md`.
- **Follow-ups:** W2 `add-windows-environment-and-commands` makes commands startable and makes Windows `supported`; W3 uses the same helper for `GetExtendedTcpTable`; W4 packages the helper and decides signing (G-6).
