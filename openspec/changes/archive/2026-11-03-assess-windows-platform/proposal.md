# Proposal

## Why

Windows support is planned as a preview: "verified in CI on Windows Server 2025". The four implementation changes (W1 process supervision, W2 environment and commands, W3 port inspection, W4 packaging) each depend on Windows behavior nobody has observed yet:

- whether descendants survive each way of stopping a process tree;
- how `.cmd`/`.bat` files can be started without command injection;
- where a user's environment comes from;
- how listening ports map to processes;
- whether Electron and an installer work on the runner.

The groundwork change added a Windows CI lane, but it runs only the unit tests. No Windows machine is available, so the `windows-2025` GitHub Actions runner is the only place this evidence can come from. The foundation design also requires a decision on native code (gate G-4: FFI, a helper binary, or forced-only stop) before W1, and that decision should rest on recorded observations rather than assumptions.

## What Changes

- **Windows probes.** A manually started workflow, `windows-probe.yml`, runs a set of probes on `windows-2025`:
  - process-tree stopping: `taskkill`, Job Objects, console control events, and libuv's own job;
  - `.cmd`/`.bat` quoting against an injection corpus;
  - executable lookup with `PATHEXT`;
  - registry and inherited environment;
  - child output encoding;
  - listening ports and process identity;
  - Electron launch under Playwright;
  - an NSIS installer build with silent install and uninstall.

  Probes use Node, PowerShell, and C# P/Invoke from PowerShell, so they add no npm dependency. The workflow is never a required check and changes nothing in the repository.
- **Veydr's real context, not the runner's.** Probes run from a parent without a console, as Veydr's GUI main process does, because console control events and console windows depend on it. The probes whose results depend on privileges also run as a temporary standard user, since the runner account is an administrator. Control checks invalidate any area whose context could not be established.
- **Recorded evidence.** Every check is a yes/no question with a predicted answer, recorded before any probe runs.
  - Each probe reports only its answers.
  - A summary derives each check's status by comparing the answer with the prediction: `PASS`, `FAIL` (prediction wrong), `EXPECTED-FAIL`, or `NOT-TESTABLE`. Each status other than `PASS` carries a reason.
  - The summary has one line per check, in the same style as the Linux smoke summary.
  - The results of a reviewed run are committed with the run's identity: commit, runner image version, and date.
  - `docs/windows-evidence.md` explains them, and lists what the runner cannot show (logoff and shutdown, Windows 10/11 desktop, UAC elevation prompts, localized Windows, third-party antivirus, SmartScreen).
  - A unit test keeps the document and the recorded results consistent.
- **Gate G-4 decision.** This change's `design.md` records the native-code choice for W1 and W3 and the shell-mode route for W2, each pointing at recorded results. A koffi load test inside Electron runs only if the G-4 options call for it and the maintainer approves it separately; otherwise it stays an unresolved check for W1.
- **CI setup on Windows.** The setup action's Electron steps (Xvfb, user namespaces, core dumps) run only on Linux, so a Windows job can prepare Electron. The workflow policy keeps requiring `electron: "true"` before Electron is launched, on both systems.
- **Not changed:** no product code, no new dependency, no change to `electron-builder.yml` or to any required check. Windows stays "not yet supported" in the README, the docs, and the app until W1–W4.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. The probe workflow follows the existing "Workflow security policy" requirement of `quality-gates`, which covers every file under `.github/`. The change adds evidence and tooling but no product behavior, so it sets `skip_specs: true`.

## Impact

- **CI:**
  - new `.github/workflows/windows-probe.yml` (manual `workflow_dispatch`, read-only permissions, uploads probe output as an artifact);
  - `.github/actions/setup/action.yml`, whose Linux-only Electron steps get a `runner.os` guard;
  - `test/unit/workflow-policy.test.ts`, for the new workflow, the guard, and direct Electron launches (`--smoke-test`, `ensure-electron.cjs`) in its Electron-launch detection;
  - `.gitattributes`, so the committed probe results are reviewable text.
- **Probe code:** `scripts/windows-probe/`:
  - Node `.mjs` drivers;
  - Windows PowerShell 5.1 scripts;
  - a minimal C# helper compiled during the probe run, never committed as a binary.

  None of it is part of the application bundle or the packages.
- **Evidence:** `test/windows-probe/` (recorded summary and per-probe results), `docs/windows-evidence.md`, and a unit test that checks the two against each other.
- **Docs:** `docs/ci.md` (the probe workflow), `docs/deferred-checks.md` (unresolved Windows checks).
- **Cost:** Windows runner minutes. Each run is started by hand and bounded by job timeouts.
- **Follow-ups (out of scope):** W1 `add-windows-process-supervision`, W2 `add-windows-environment-and-commands` (including the shell argument convention and its configuration migration), W3 `add-windows-port-inspection`, W4 `add-windows-packaging`, which ships the installer labelled preview.
