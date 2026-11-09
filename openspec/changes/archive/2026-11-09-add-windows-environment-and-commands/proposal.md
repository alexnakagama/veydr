# Proposal

## Why

W1 (`add-windows-process-supervision`) built the Windows process tree, but starting a command from the app on Windows still fails. There is no command resolver and no environment, `launchDetached` rejects, and the platform reports `supported: false`. W2 is the change the roadmap names for making commands startable on Windows. W3 (ports) and W4 (packaging) build on it. W0's evidence (`docs/windows-evidence.md`, "Shell mode (W2)") already fixes the risky parts: how `.cmd` files are quoted, why Node's `shell: true` is unsafe, the `PATHEXT` lookup, and the non-UTF-8 output.

## What Changes

- **Commands start on Windows.** A Windows `CommandResolver`:
  - finds direct-mode programs on the effective `PATH` with `PATHEXT`, never in the working directory (W0 `cmd-pathext`, `cmd-pathext-cwd`);
  - accepts `.exe`, `.com`, `.bat` and `.cmd`, and refuses other `PATHEXT` types with a message;
  - keeps the working-directory rules of Linux, using Windows path semantics.
- **One quoting route through `cmd.exe`.** Batch files (`npm.cmd` and other shims) and shell-mode scripts run through `cmd.exe /d /v:off /s /c` with a verbatim command line.
  - **Batch-file arguments:**
    - a simple argument (letters, digits and `_ + - . : / \ @`) is passed as written, as W1 did, so `build.bat release` with `%1` and `%~1` keeps working;
    - any other argument is quoted by the algorithm W0 validated for `%*` forwarders (`scripts/windows-probe/cmd-quote.mjs`, all `cmd-route-verbatim-*` checks `PASS`).
  - An argument with a line break or NUL is refused before anything starts, as is a line beyond 8191 characters.
  - Node's `shell: true` is never used.
  - **Helper protocol version 2:** Veydr builds every command line, and sends it with the program path to the helper over stdin after the token, so its length is not changed by the helper's own argument quoting. The helper still refuses a batch file unless the program it is given is `cmd.exe`.
- **Shell mode on Windows supports `cmd.exe` only.** The default shell is `<SystemRoot>\System32\cmd.exe`. Another shell is refused on Windows with a message that names the supported one. PowerShell is a possible later change.
- **The Windows environment.** Commands start from Veydr's own inherited environment, without Electron's runtime variables. Variable names that differ only in letter case (`Path` and `PATH`) are merged into one before anything is spawned. A `PATH` change made after Veydr started needs a Veydr restart, and the docs say so.
- **Output that is not UTF-8.**
  - The command's console is set to output code page 65001 (UTF-8) before the command runs, so `cmd.exe` and other console programs write UTF-8.
  - On Windows, a line that is still not valid UTF-8 is decoded with the system's ANSI code page instead of being shown as replacement characters. Linux is unchanged.
- **Opening the editor on Windows.** `launchDetached` starts the editor unsupervised and hidden. An editor that is a `.cmd` file (as `code.cmd` is) runs through the same `cmd.exe` quoting route, so no shell interprets its arguments.
- **End-to-end tests on Windows.** The e2e harness stops depending on `/proc`: process checks go through a portable helper. Each e2e spec is sorted into one of three kinds:
  - **portable:** runs on both systems;
  - **Linux-only:** skipped on Windows with a stated reason;
  - **Windows-specific:** Windows-only specs, where the behavior differs, such as crash recovery.

  The `windows` CI job runs the suite against the built app.
- **Windows becomes a preview.** `createWindowsPlatform` reports `supported: true`.
  - The requirement "Windows supervision not yet supported" is replaced by a preview requirement.
  - README and docs say "Windows: preview, run from source, verified in CI on Windows Server 2025, no Windows package yet". The list of things the runner cannot verify stays.
- **Not changed:**
  - Port inspection on Windows stays unsupported (W3).
  - There is still no Windows package or signing (W4, G-6); `electron-builder.yml` is unchanged, and no npm dependency is added.
  - Linux behavior is unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `project-registry`:
  - direct mode gains Windows rules: `PATH` with `PATHEXT`, never the working directory, no drive-relative paths, and batch files through `cmd.exe`, which is the one case in which direct mode involves a shell;
  - shell mode on Windows is `cmd.exe` only;
  - the effective environment on Windows is Veydr's inherited one, with names merged regardless of case;
  - the editor launch allows `cmd.exe` for a batch-file editor, by the batch-file argument rules, with no new console window.
- `process-supervision`: "Windows supervision not yet supported" is replaced by "Windows supervision in preview", and "Documented crash limitation" labels the Windows limits as part of the preview instead of "not yet reachable from the app". Commands start on Windows, the platform reports itself as supported, the docs state the preview limits, and the process-tree behavior stays verified natively.
- `process-logs`: line handling decodes Windows output that is not UTF-8 with the ANSI code page, after setting the command's console to UTF-8.
- `quality-gates`:
  - the `windows` job also runs the Windows end-to-end tests against the built app;
  - the sandbox rule for end-to-end tests covers Windows, and the offline test stays in the Linux job;
  - Linux-only end-to-end tests are skipped on Windows with a stated reason.

## Impact

- **Code:**
  - `src/main/platform/windows/`: a new resolver, environment provider, `cmd.exe` quoting, editor launch, client support for protocol version 2, and `index.ts`;
  - `veydr-helper.cs`: protocol version 2 (program and command line over stdin, run verbatim; batch files only under `cmd.exe`) and the UTF-8 console;
  - `src/main/logs/splitter.ts`: a Windows decoding fallback chosen by the platform;
  - `src/main/app/smoke.ts`: the platform check on Windows, since port inspection is still unsupported;
  - the composition root.
  - The supervisor, the ledger format, and the Linux platform are unchanged.
- **Renderer:** the shell field on Windows shows `cmd.exe` as the only choice. The "not supported" banner disappears on Windows, while the Ports view still shows that port inspection is unavailable.
- **Tests:**
  - unit tests for the resolver, quoting, environment, decoding and the editor launch, on every system;
  - Windows-only integration tests for starting commands through the real helper;
  - a portable e2e process helper, the e2e specs sorted by system, and Windows-only e2e specs where the behavior differs;
  - the `start-on-windows` test is replaced.
- **CI:** the `windows` job (in `.github/workflows/ci.yml`) gains the Electron setup and an e2e step, and `workflow-policy.test.ts` and `docs/ci.md` change with it.
- **Docs:** README (the platform table and support statement), `docs/dependencies.md` (the helper's protocol version 2), `docs/processes.md`, `docs/commands.md`, `docs/logs.md`, `docs/deferred-checks.md`, a "Running from source on Windows" section, and the W0 evidence notes that W2 resolves.
- **Follow-ups:**
  - W3 adds `ports` to the helper and lifts "Windows port inspection not yet supported".
  - W4 packages the app and the helper outside `app.asar`, checks the install directory's permissions, decides signing (G-6), and replaces "preview, from source" with the shipped preview statement.
