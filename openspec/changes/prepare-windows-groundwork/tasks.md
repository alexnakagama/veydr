# Tasks

Note: `npm run spec-coverage` runs in required mode and also reads this change's specs. Each group tags the scenarios it implements with `[spec:<capability>/<scenario-slug>]`, so `npm run verify` is fully green only once group 7 is done. Windows remains unsupported throughout: the Windows stub keeps rejecting every operation, and the README and docs keep the "Linux only; Windows not yet supported" wording.

## 1. Platform conventions

- [x] 1.1 Add `EnvNameRule` (`'exact' | 'case-insensitive'`) and the pure helper `envNameKey(name, rule)` to `src/shared/config` (design D1). Add `PlatformConventions` (`envNames`, `defaultShell`, `directorySync`) and `Platform.conventions` to `src/main/platform/types.ts`. Verify: `npm run typecheck` passes.
- [x] 1.2 Set the conventions per design D1: Linux `exact` / `/bin/sh` / `true`; `createUnsupportedPlatform` takes conventions as a parameter; the Windows stub passes `case-insensitive` / `null` / `false`, and the unsupported platform passes `exact` / `null` / `true`. Extend `test/unit/platform.test.ts`: the conventions of each selected platform, the existing check that every Windows operation still rejects with `UnsupportedPlatformError`, and `envNameKey` for both rules. Verify: `npm test` passes.

## 2. Environment variable names follow the platform rule

- [x] 2.1 Give `effectiveEnvironment` and `previewEntries` (`src/main/projects/environment.ts`) an `EnvNameRule` parameter (design D2): an override replaces every base entry with the same key under the rule, and the override's spelling wins. Pass `platform.conventions.envNames` through from `src/main/index.ts` to the callers in `src/main/supervisor/plan.ts` and `src/main/ipc/handlers.ts`. In `test/unit/environment-service.test.ts`, add tests tagged `[spec:project-registry/override-differing-in-case-on-windows]` (base `Path`, override `PATH`, `case-insensitive`: one entry with the override's name and value, in both functions) and `[spec:project-registry/override-differing-in-case-on-linux]` (same input, `exact`: both entries). Verify: `npm test` passes, and the existing `override-applied` tests still pass.
- [x] 2.2 Make `ProjectService.upsertCommand` (`src/main/projects/service.ts`) reject overrides that collide under the platform rule, with the existing `Duplicate variable "<name>"` message, before saving. The rule is injected through `ProjectServiceDeps`. In `test/unit/project-service.test.ts`, add a test tagged `[spec:project-registry/overrides-differing-only-in-case-rejected-on-windows]` (`NODE_ENV` and `node_env` with `case-insensitive`: a `UserError` naming the variable, and the stored config unchanged). Also add a test that the same pair is accepted with `exact`. Verify: `npm test` passes.

## 3. Project path keys

- [x] 3.1 Change `projectPathKey` (`src/shared/config/schema.ts`) per design D3: for a Windows path by syntax (drive letter or `\\` UNC), use `\` separators and lowercase; leave POSIX paths unchanged; keep the root handling. Update its doc comment. In `test/unit/config-schema.test.ts` or `test/unit/project-service.test.ts`, add tests tagged `[spec:project-registry/windows-path-differing-only-in-case]` (`C:\Work\Shop` vs `c:\work\shop`, and `C:/Work/Shop/` vs `c:\work\shop`, each rejected as a duplicate by the schema and by the service's duplicate lookup) and `[spec:project-registry/posix-path-differing-only-in-case]` (`/home/dev/Shop` and `/home/dev/shop` both accepted by the schema). Verify: `npm test` passes, and the existing `reject-duplicate` tests still pass.

## 4. Atomic writes

- [x] 4.1 Add bounded rename retries to `writeFileAtomic` (`src/main/config/atomic.ts`) per design D4: retry only `EPERM`, `EBUSY`, and `EACCES`, at most 5 attempts with linear backoff starting at 50 ms, with an injectable `sleep`; any other error and the last error propagate unchanged. Replace the Windows note in the module comment with a description of the retry. In `test/unit/config-atomic.test.ts`, use the fault-injecting `ConfigFs`:
  - a test tagged `[spec:config-storage/file-briefly-held-by-another-program]`: `EBUSY` twice, then success; the target holds the new content;
  - a test tagged `[spec:config-storage/file-held-beyond-the-retry-bound]`: `EPERM` on every attempt; the call rejects with that error, and the target is still the complete previous content;
  - a test that `ENOSPC` is not retried.

  Verify: `npm test` passes.
- [x] 4.2 Add a `directorySync: boolean` option to `createConfigStore` and `createRunLedger`, defaulting to `true`. With `false`, no directory is opened, and no `DirectorySyncError` is raised or logged. `src/main/index.ts` passes `platform.conventions.directorySync`. In `test/unit/config-store.test.ts` and `test/unit/run-ledger.test.ts`, add tests that with `directorySync: false` the fake filesystem's `openDirectory` is never called and no `config.directory-sync-failed` record is logged. Verify: `npm test` passes, and `npm run lint` passes (no `process.platform` read outside the allowed modules).
- [x] 4.3 Document in `docs/configuration.md` that a save briefly retries when another program holds the file, and still fails cleanly with the previous file intact. Verify: `npm test` passes, including `config-docs.test.ts`.

## 5. App info and renderer

- [x] 5.1 Add `defaultShell: string | null` and `envNames` to `appInfoSchema` (`src/shared/api/app.ts`), filled from `platform.conventions` in `src/main/index.ts` (design D5). Update `test/unit/api-contract.test.ts` and any `AppInfo` fixtures in the renderer tests. Verify: `npm test` and `npm run typecheck` pass. The smoke test's bridge-group check in `test/unit/smoke.test.ts` is unchanged and passes.
- [x] 5.2 In `src/renderer/src/CommandEditor.tsx`:
  - remove `DEFAULT_SHELL`; new shell commands start with `defaultShell` from app info, or an empty field when it is `null`;
  - validate the shell path with the shared `isAbsolutePath`; the message's example comes from `defaultShell` and is left out when it is `null`;
  - flag override names that collide under `envNames` with the same `Duplicate variable "<name>"` message as main.

  Extend `test/unit/renderer-commands.test.ts` with these cases:
  - `C:\Windows\System32\cmd.exe` passes validation;
  - `bin/sh` fails;
  - the default shell comes from the info;
  - `PATH` with `Path` is a duplicate under `case-insensitive` and allowed under `exact`.

  Verify: `npm test` passes, and `npm run test:e2e` passes on Linux (the command editor flows are unchanged with `/bin/sh` as the default).
- [x] 5.3 Change the restricted-owner explanation in `src/renderer/src/PortsView.tsx` (banner text and badge title) to say that the operating system does not show the process. Update any assertion in `test/unit/renderer-ports.test.ts` or `test/e2e/ports.spec.ts` that quotes the old text. Verify: `npm test` passes, and `npm run test:e2e -- ports` passes.

## 6. Tooling

- [x] 6.1 Fix `scripts/verify.mjs` per design D8: run npm through `process.execPath` with `npm_execpath` when it is set; otherwise spawn `npm` with `shell: true` on Windows only. Verify: `npm run verify` on Linux still runs and reports every stage.
- [x] 6.2 Add `.gitattributes` with `* text=auto eol=lf` and `binary` for `*.bin`, `*.png`, `*.ico`, and `*.jsonl` fixtures. Verify: `git add --renormalize . && git status --short` shows no content changes. A fresh clone with `core.autocrlf=true` (in a temporary directory) has LF in `test/fixtures/procfs/stat-cat.txt`, and `cmp` reports no differences for `test/fixtures/procfs/cmdline-parentheses.bin`.

## 7. Windows CI lane

- [x] 7.1 Mark Linux-only unit tests with `describe.skipIf(process.platform !== 'linux')` or `it.skipIf(...)`, putting the reason in the title as `[linux-only: <facility>]` (design D7). Start with suites that exercise Linux behavior: `linux-procfs`, `linux-ports`, `linux-process-tree`, `linux-survivors`, the mode assertions in `config-store` and `config-atomic`, and `runtime-env` cases that depend on POSIX `PATH` syntax. For tests whose POSIX assumption is incidental (e.g. hard-coded `/` joins in `config-store`, `protocol`, `ipc-operations`, `supervisor-plan`), fix the test instead. Verify: `npm test` passes on Linux with no new skips reported.
- [x] 7.2 Add `test/unit/test-platform-policy.test.ts`. It scans `test/**/*.ts` and fails when a `skipIf`/`runIf` on `process.platform` lacks a `[linux-only: …]` (or `[windows-only: …]`) reason in its title, or when a test body returns early on `process.platform`. Tag it `[spec:quality-gates/linux-only-test-on-windows]`. Add a second case, tagged `[spec:quality-gates/linux-only-test-on-linux]`, asserting that every such guard runs the test on Linux (the condition is `process.platform !== 'linux'`, or `runIf(process.platform === 'linux')`). Verify: `npm test` passes, and a temporary unlabeled `skipIf` makes it fail (checked once, then removed).
- [x] 7.3 Add the `windows` job to `.github/workflows/ci.yml` (design D6): `runs-on: windows-2025`, explicit `permissions: contents: read`, a timeout, and pinned checkout with `persist-credentials: false`. It runs setup without Electron, then typecheck, lint, and `npm test` as separate steps with the same `if:` pattern as `static`. Add it to `ci-ok`'s `needs`. In `.github/actions/setup/action.yml`, skip the Electron/electron-builder cache step when `runner.os == 'Windows'`. Update `test/unit/workflow-policy.test.ts`:
  - the expected job list includes `windows`;
  - `ci-ok` aggregates it;
  - the `pull-request-runs-the-full-check-set` test also asserts the Windows job's typecheck, lint, and unit steps.

  Verify: `npm test` passes, and `actionlint` (the pinned image) reports no errors.
- [ ] 7.4 Push the branch, open a pull request, and triage the `windows` job until it is green: fix each failing unit test or mark it Linux-only per design D7. Record in the PR description which tests were fixed and which were marked, with their reasons. Verify: the `windows` job and `ci-ok` succeed on the pull request.
- [x] 7.5 Document the `windows` job in `docs/ci.md` (job table: command, runner, what it does not cover yet), and the `[linux-only: …]` convention. Note in `docs/deferred-checks.md` that Windows now runs typecheck, lint, and unit tests, while runtime behavior is still unverified. Verify: `npm test` passes, including the docs tests and `readme-docs.test.ts`, whose platform label is unchanged.

## 8. Integration check

- [ ] 8.1 Run `npm run verify` and `npm run test:e2e` on Linux. Verify: both pass, and `spec-coverage` reports zero unmapped scenarios, including this change's new ones.
- [ ] 8.2 Check that nothing claims Windows support: `grep -rn "Windows" README.md docs/` shows only "not yet supported" statements and the new CI notes, and `test/unit/supervisor.test.ts`'s `start-on-windows` test still passes. Verify: both checks hold, as recorded in the pull request.

## Workflow follow-up

- Archive the change once the pull request is merged and `ci-ok` is green on `master`.
- Start `assess-windows-platform` (W0) on top of the `windows` job; gate G-4 (koffi or helper binary) is decided there.
