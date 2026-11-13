# Design

## Context

See `proposal.md` for the motivation. What shapes the approach:

- **What exists.**
  - `electron-builder.yml` has only a `linux` section. Its `files`, `asar`, `publish: null` and `electronFuses` settings are shared by every target.
  - `windowsHelperPath(appPath)` returns `<app path>/out-helper/veydr-helper.exe`. In a packaged app the app path is `resources\app.asar`, from which no executable can start.
  - `scripts/build-windows-helper.mjs` compiles the helper with the .NET Framework 4.8 `csc.exe`, on Windows only, into the git-ignored `out-helper/`.
  - `--smoke-test` fails its `platform` check on Windows when ports cannot be listed, so it already detects a helper that cannot be found or started.
- **W0 evidence** (`docs/windows-evidence.md`, run 41657147660):
  - `nsis-build` is `PASS`: electron-builder builds a per-user, one-click NSIS installer (112.5 MB) on `windows-2025`.
  - `nsis-install` is `PASS`: a silent install to `%LOCALAPPDATA%\Programs\veydr`, a `--smoke-test` launch whose report and exit code are readable on a pipe, and a silent uninstall.
  - Both ran as the runner's administrator only, with the options given on the command line. The standard-user install is new evidence in this change.
  - Not testable on the runner: `smartscreen`, `ux-uac-prompt`, `env-desktop-launch`, `pt-logoff`, `av-third-party`.
- **Handed to W4 by earlier changes:**
  - ship the helper outside `app.asar` and change only its path (W1 design D5);
  - check the permissions of the directory the helper is installed into (W1 review);
  - repeat the smoke test on the packaged app, as a standard user (W1 design, W3 proposal);
  - decide signing under gate G-6: "any paid signing certificate or service" needs the maintainer's approval;
  - replace "run from source" with the shipped preview statement (W2 proposal).
- **Constraints:**
  - No Windows machine is available. The `windows-2025` runner is the only place Windows behavior is verified, and a claim counts as verified only from a CI run.
  - The fuses turn off `--inspect` and the Node options, so Playwright cannot drive a packaged app. The Linux acceptance pass drives the window with `xdotool`, which has no Windows counterpart in the repository.
  - No npm dependency may be added without review (`docs/dependencies.md`), and no helper binary may be committed.
  - electron-builder only warns when an `extraResources` source file is missing (`fileMatcher.js`: "file source doesn't exist"); it still builds the package.
  - In electron-builder's NSIS template a silent install does not start the app (`installSection.nsh`: run after finish only if not silent, or with `--force-run`).

## Goals / Non-Goals

**Goals:**

- A Windows installer built in CI from the same configuration as the Linux packages, attached to every release with checksums and build provenance.
- A packaged app that finds and uses its helper, shown by tests against the installed app.
- Every W4 hand-off item closed with a test or a documented limit.
- Docs that claim exactly what CI shows, and list what it cannot show.

**Non-Goals:**

- Signing, or any spending under G-6.
- Auto-update, a per-machine install, MSI, MSIX, a portable build, arm64, winget, or the Microsoft Store.
- A packaged acceptance pass on Windows that drives the user interface (see D7).
- Verification on an interactive Windows 10/11 desktop: SmartScreen, an Explorer launch, UAC, logoff.
- A runtime check of the helper's file permissions (see D4).
- Installing over a running Veydr (see D3).
- Protection of `Veydr.exe` itself, which holds the archive's expected hash and is unsigned (see D3, D8).
- Nightly runs of the Windows packaging tests: they already run for every pull request and push.

## Decisions

### D1. Installer: NSIS, per-user, one-click, x64, configured in `electron-builder.yml`

```yaml
win:
  target:
    - target: nsis
      arch: [x64]
  icon: build/windows/icon.ico
  extraResources:
    - from: out-helper/veydr-helper.exe
      to: veydr-helper.exe
nsis:
  oneClick: true
  perMachine: false
  packElevateHelper: false
  differentialPackage: false
  createDesktopShortcut: false
  createStartMenuShortcut: true
  include: build/windows/installer.nsh
  deleteAppDataOnUninstall: false
  artifactName: ${productName}-${version}-x64-setup.${ext}
```

- **Per-user, one-click** is the configuration W0 measured. It needs no elevation, so the unverifiable UAC prompt never appears, and a standard user can install.
- **Install directory:** `%LOCALAPPDATA%\Programs\veydr`. electron-builder names it after `package.json`'s `name`; the executable is `Veydr.exe`, after `productName`. Both were observed in W0.
- **`artifactName`** writes `x64` literally. The name is then fixed whatever electron-builder does with `${arch}` for a single-architecture NSIS target, and the release can check it: `Veydr-X.Y.Z-x64-setup.exe`.
- **`packElevateHelper: false`:** a per-user install never elevates, so `elevate.exe`, one more unsigned executable, is left out.
- **`differentialPackage: false`:** no `.blockmap` is built. Together with `publish: null` this keeps the output free of update metadata, as on Linux.
- **Start menu entry only.** A desktop shortcut is not created.
- **`include`: one uninstall hook** (added in group 7, confirmed by the maintainer on 2026-11-13). electron-builder's uninstaller deletes the Start menu entry once, right after `WinShell::UninstShortcut` rewrites it, and ignores a failure. In two CI runs (43456337022, 43474232791) `Veydr.lnk` outlived a silent uninstall that removed everything else. `build/windows/installer.nsh` defines only `customUnInstall`, which runs before electron-builder's removal and removes the same entry under the same condition (not when an update keeps the shortcuts), retrying for up to 10 s. It runs no program and writes no registry value; a unit test limits it to that. The administrator's uninstall test holds `Veydr.lnk` open without delete sharing for 5 s, which reproduces the failure without the hook.
- **`deleteAppDataOnUninstall: false`:** uninstalling keeps `%APPDATA%\Veydr` (configuration and run ledger), as removing the `.deb` keeps `~/.config/Veydr`.
- **`runAfterFinish`** keeps its default. An interactive one-click install has no finish page, so starting the app is the only sign that it worked. A silent install does not start it; a test asserts that.
- **Icon:** `scripts/render-icons.cjs` also writes `build/windows/icon.ico` from the PNGs it renders (16, 32, 48, 64, 128 and 256 px, stored as PNG entries). The file is committed like the PNGs. It is outside `build/icons/`, which electron-builder reads as the Linux icon set.
- **Scripts:**
  - `dist:windows`: `node scripts/build-windows-helper.mjs && node scripts/ensure-electron.cjs && npm run build && electron-builder --win --publish never`. The helper build comes first, so on another system the script stops at once with "the Windows helper can only be built on Windows".
  - `test:packaging:windows`: `npm run dist:windows && vitest run --project packaging-windows`.

Alternatives considered:

- *Assisted (multi-page) installer, or per-machine:* not measured in W0, and per-machine needs elevation.
- *Keep passing the options on the command line, as the probe did:* the configuration would live in a script and could not be reviewed in one place.
- *MSI, MSIX, portable:* other toolchains with no evidence; MSIX needs signing.
- *Squirrel:* it is an updater, and auto-update is a non-goal.

### D2. The helper ships as `resources\veydr-helper.exe`

- `win.extraResources` copies `out-helper/veydr-helper.exe` beside `app.asar`. `files` is unchanged, so the archive still holds only `out/`, `package.json` and `zod`.
- `windowsHelperPath` takes `{ packaged, appPath, resourcesPath }`:
  - packaged: `<resourcesPath>\veydr-helper.exe`;
  - unpackaged: `<appPath>\out-helper\veydr-helper.exe`, as today.

  `src/main/index.ts` passes `app.isPackaged`, `app.getAppPath()` and `process.resourcesPath`. Nothing else in the platform changes: the helper check (absolute path, a regular file, the protocol version) already runs before every use.
- **The helper is built in the job that packages it** (`dist:windows`), from the committed source. Nothing is committed or downloaded.
- **A missing helper must fail the build's check, not ship.** electron-builder only warns about a missing source file. Three things catch it:
  - `dist:windows` builds the helper first, and a failed build ends the script;
  - the package-contents test requires `resources\veydr-helper.exe`;
  - the smoke test's `platform` check fails without it.
- The `.sha256` file beside the helper in `out-helper/` is not packaged.

Alternative considered: `asarUnpack`. It places the file under `app.asar.unpacked` and needs the helper inside `files`, which would put a build product of another directory into the archive's file list. `extraResources` is the plain form of "a file beside the archive".

### D3. What the tests verify, and where

A new vitest project `packaging-windows` runs `test/packaging-windows/**/*.test.ts`, one file at a time, with timeouts long enough for an install. The Linux `packaging` project and `test/packaging/` are unchanged. Every suite is guarded with `describe.skipIf(process.platform !== 'win32')` and a `[windows-only: …]` reason, as the platform skip policy requires; `test-platform-policy.test.ts` also scans the new tree.

| File | Checks |
|---|---|
| `package-contents.test.ts` | `dist\win-unpacked\resources` holds exactly `app.asar` and `veydr-helper.exe`, and that helper answers `version` with the protocol version Veydr needs. The archive holds the same files as on Linux and no `.exe`, `.dll` or `.node`. No probe strings. `dist\` holds one installer with the expected name, and no `.blockmap`, `latest.yml` or `app-update.yml`. `Veydr.exe` carries the Veydr icon and the version. |
| `fuses.test.ts` | The six fuses in `Veydr.exe`. `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect` are ignored. A `resources\app` folder is not loaded. An `app.asar` whose index changed is refused, and so is one whose file bytes alone changed (measured; see "ASAR integrity" below). Each has a control with the stock Electron binary, as on Linux. |
| `smoke.test.ts` | `dist\win-unpacked\Veydr.exe --smoke-test` passes all seven checks, with `packaged: true` and an `appPath` ending in `\resources\app.asar`. |
| `installer.test.ts` | Silent install; the installed files; Start menu entry and uninstall entry; no logon entry or startup shortcut; no Veydr process afterwards; the installed app's smoke test; a command tree through the installed helper; the permissions; reinstall; silent uninstall keeping the configuration. |
| `standard-user-install.test.ts` | The install, the permissions, the installed helper, the smoke test where it can run, and the uninstall as a temporary standard user (D5). |

Details:

- **ASAR integrity.** electron-builder embeds the SHA-256 of the archive's *header*, its index of files with their sizes, offsets and per-file hashes, in `Veydr.exe` (`app-builder-lib/out/asar/integrity.js`, `hashHeader`). Electron compares that at startup. Nothing found in either source said that a file's bytes are compared with the per-file hashes on Windows. **Measured (task 2.4, CI runs 43238718929 and 43278811083): they are.** Electron also checks each file it reads from the archive against its hash in the header. The test therefore makes two modifications, each in a fresh copy of the unpacked build, and each with a marker file the modified main bundle would write:
  - (a) *index changed:* the main bundle is replaced by one of another size, with the header rewritten to match. Required: the app does not start, and no marker appears. This is the spec's scenario.
  - (b) *bytes only:* bytes of the main bundle are overwritten in place, the same size, the header untouched. Predicted: the marker appears (the modified code runs). **Measured: refused.** `Veydr.exe` exits 1 with "ASAR Integrity Violation: got a hash mismatch" and no marker appears. As this rule planned for that outcome, the test asserts the refusal, the docs say so, and the bytes-only limit is dropped.

  A control runs the unmodified copy and shows that it starts. `docs/security-baseline.md` and `docs/install-windows.md` state what is covered: the header at startup, and each file's bytes when that file is read; not a file that is never read; and not `Veydr.exe` itself, which is unsigned.
- **A command through the installed helper.** The test builds the product's own Windows platform (`createWindowsPlatform`) with the installed helper's path, starts a command that starts a child, stops it, and checks that both are gone; it also lists ports and finds a listener it opened. This shows that `run`, `terminate` and `ports` work from the install directory. The full process-tree behavior stays with the integration tests, which run against `out-helper/`.
- **The smoke test and the configuration directory.** A packaged app cannot be given another configuration directory on Windows. `--smoke-test` only creates the directory and writes and removes a uniquely named probe file, never `config.json` or the ledger. The tests assert that again for the installed app.
- **Uninstall keeps the configuration.** Before uninstalling, the test writes a marker file into `%APPDATA%\Veydr` and checks that it survives. Because it touches the real profile, `installer.test.ts` runs only in CI (`it.skipIf(process.env['CI'] !== 'true')`, as the standard-user port test does), on a VM that is discarded.
- **Reinstall.** The installer is run a second time over the first install while Veydr is not running. Installing over a *running* Veydr is not tested: electron-builder's installer closes the app, which ends its commands as a crash would. The docs tell the user to quit Veydr first, and list the case as not verified.
- **Install record.** A global setup of the project writes `test-results/windows-install/steps.jsonl`. Its first line names the installer as `SHA256SUMS` would (`<sha256>  <file name>`, in `detail.installer`), as the Linux acceptance record names the `.deb`. Each installer test appends one line with its step and outcome. D6 uses it.

### D4. Install-directory permissions: checked by a test, with the limit documented

- **Check.** After the install, the test reads the access control lists of the install directory, `Veydr.exe`, `resources\app.asar` and `resources\veydr-helper.exe` with `Get-Acl`, each identity translated to its SID. It fails if any allow entry grants write, modify, delete, change-permissions or take-ownership rights to a SID other than the installing user's own, SYSTEM (`S-1-5-18`), Administrators (`S-1-5-32-544`), or the owner placeholders CREATOR OWNER (`S-1-3-0`) and OWNER RIGHTS (`S-1-3-4`). An identity that cannot be translated to a SID fails the check. Names are never compared, so a localized Windows gives the same result. It runs for the administrator's install and for the standard user's.
- **What the result is.** The installer sets no permissions of its own; the list is the one the user's profile gives new files below `%LOCALAPPDATA%`. If a later installer or a changed profile default alters it, the test reports the entry but cannot say which of the two caused it. The docs describe the result as the profile's inherited default.
- **Why this is the right boundary.** The directory is inside the user's own profile, so another standard user cannot replace the helper. A process that already runs as the same user can, but it could equally replace `Veydr.exe`, or start commands itself. The gap W1's review recorded (the helper is checked, then started again from the same path) therefore gives such a process nothing new.
- **No runtime check.** Veydr does not read the ACL before starting the helper. A per-user install is writable by its user by design, so the check could only ever confirm what the installer set up. The docs state the limit.

Alternative considered: a per-machine install under `Program Files`, which a standard user cannot write. It needs elevation at install time, which cannot be verified on the runner, and it was not measured in W0.

### D5. The standard-user installation reuses W0's launcher

- `scripts/windows-probe/standard-user.ps1` gains an `-Installer` parameter, validated like `-Helper`: a fully qualified, normalized path of a regular file, whose name matches `Veydr-<version>-x64-setup.exe` case-sensitively. `<version>` is a semantic version and may have a prerelease part: the repository's version is `0.1.0-rc.1`, so every CI run uses such a name. The file is copied to the account's directory, its SHA-256 is compared after the copy, and the launcher passes that digest to the driver.
- A new driver, `scripts/windows-probe/installer-standard-user.mjs`, runs as the temporary account `veydr-probe`, without a console. It writes one result line per step:
  1. the SHA-256 of its copy of the installer, which the test compares with the record's first line, so the installer the standard user tested is the one uploaded;
  2. a silent install;
  3. the permissions (D4);
  4. the installed helper run directly: `version` answers with the protocol version, and `ports` lists a listener the driver opened;
  5. the installed app's `--smoke-test` (see below);
  6. a silent uninstall.

  Like `ports-standard-user.mjs`, it is built on `driverMain`/`runDriver` and stays out of the probe-area registries, so `checks.mjs`, the predictions and the recorded W0 evidence do not change.
- **Electron as the standard user is unmeasured.** W0 and W3 started only console programs through the launcher (`CreateProcessWithLogonW`, no console window). `--smoke-test` creates a hidden window, and an account from a secondary logon may have no access to the runner's window station and desktop, so Electron may not start for it. That would be a limit of the runner, not of the product or the installer. The rule is fixed here, before anything is measured:
  - steps 1–4 and 6 are required. They need no window, and they are what the spec's scenarios name;
  - step 5 is required too, unless its control shows the cause: the driver also starts the stock Electron binary (`node_modules/electron/dist/electron.exe --version` and a script that opens a hidden window) as the same account. If the stock binary cannot open a window either, while the same installer's smoke test passed for the administrator in the same run, step 5 is recorded as not testable with that reason, the test passes, and "the smoke test of the installed app as a standard user" joins the not-verified list in the docs;
  - if the stock binary opens a window and the installed app's smoke test still fails, the test fails: that is a defect.

  Task 4.3 records which case the runner showed. Either way no later group depends on it.
- `standard-user-install.test.ts` starts the launcher, requires the `ctx-standard-user` control (an unelevated token, not in Administrators, the registry hive loaded), and requires every step to have passed, with step 5 judged by the rule above. It runs only in CI, where it **fails** if the account cannot be created or used. The launcher removes the account whatever happens, and the test checks that it is gone.
- The workflow policy already keeps the `windows` job from overriding `CI`; the same rule is applied to `windows-package`.

This is the check "as a standard user" that W1 and W3 handed over: the helper and the port listing work from a standard user's installation, and the app's own smoke test does too where the runner lets Electron start for that account.

### D6. CI, manual builds, releases

**`ci.yml`** gains `windows-package` (`windows-2025`, 45 minutes, `contents: read`), added to `ci-ok`'s `needs`:

1. checkout and the setup action with `electron: "true"`;
2. `npm run test:packaging:windows`;
3. upload the installer as `windows-package`, kept 7 days, failing when no file is found;
4. on failure, upload `test-results/`.

It is a separate job from `windows` so the two run in parallel and neither outgrows its timeout.

**`build.yml`** gains `windows-package`, for the same `inputs.ref`:

- it runs `npm run test:packaging:windows`;
- `node scripts/sha256sums.mjs` writes `dist/SHA256SUMS` for the installer;
- it uploads the installer and `SHA256SUMS` as `windows-package`, kept 14 days.

The Linux `package` and `smoke` jobs are unchanged, so each artifact carries its own `SHA256SUMS`.

`scripts/sha256sums.mjs <directory> <file>...` writes GNU text-mode lines (`<hex>  <name>`, LF) and then verifies what it wrote. The `sha256sum` of Git for Windows marks files as binary (`*name`), as the existing build test notes, so the format is produced by a script that the unit tests run on both systems.

**`release.yml`** gains two gate jobs. Each checks out `source_sha` and applies the version, as every gate job does:

- `windows`: helper build, `npm run test:windows`, `npm run test:e2e`, with the same guard as in `ci.yml`: the test steps run only after a successful helper build, so a failed build fails the job and no test is reported as passed or skipped;
- `windows-package`: `npm run test:packaging:windows`, then uploads `release-windows-package` (the installer) and `release-windows-install` (`test-results/windows-install/`).

`publish` needs both, and changes in three places:

- it downloads the installer into the release directory, which must then hold exactly the `.deb`, the AppImage and `Veydr-X.Y.Z-x64-setup.exe`;
- `SHA256SUMS` covers the three files, so the provenance attestation, which reads `SHA256SUMS`, covers the installer with no further change;
- the first line of the Windows install record must name the installer's line in `SHA256SUMS`, as the acceptance record must name the `.deb`'s; the record is attached as `install-windows-steps.jsonl`.

No new secret, no new write scope, and `publish` stays the only job that reaches the remote. A Windows failure stops the whole release, Linux packages included: one release has one set of artifacts.

The Windows release path cannot be run before a real release. Its steps are covered by the workflow policy tests, which run the changed `publish` scripts against fixtures, and by the same scripts running in `ci.yml` and `build.yml`. A wiring mistake in a gate job fails that job, and `publish` then never starts, so it fails before any push. `docs/ci.md` says that the path is unrun until the first release.

Alternatives considered:

- *Release the Windows installer from its own workflow:* two releases could disagree about the version or the commit.
- *Run only packaging in the release, trusting the `windows` CI run of `source_sha`:* the gate's rule is that every check runs on the bumped tree.
- *One `SHA256SUMS` for all three files in a manual build:* it needs a third job, and changes the Linux job that the existing scenario and its test describe.

### D7. No packaged acceptance pass on Windows

The Linux release gate drives the installed `.deb` through a full session. On Windows this change does not:

- Playwright cannot attach to a packaged app (the fuses), and weakening the fuses for a test build would test another binary than the one shipped;
- a UI automation tool would be a new dependency, with no evidence that it works on the runner.

What covers the packaged app instead: the smoke test (UI loaded from the archive, bridge, isolation, DevTools off, environment, ports), a command tree through the installed helper, and the end-to-end suite against the same build output (`out/`) unpackaged. The gap, a full user session in the installed app, is listed in the docs as not verified.

### D8. Signing (G-6): ship unsigned, and say so

- **Decision, to be confirmed by the maintainer before group 2 (task 2.0).** G-6 is the maintainer's gate, and the answer sets what every Windows user reads about SmartScreen. Nothing is signed. No certificate or signing service is bought, so G-6 is not used, and it stays the gate for any later proposal.
- **Consequences, all documented in `docs/install-windows.md`:**
  - SmartScreen shows "Windows protected your PC" for the downloaded installer, with "Unknown publisher". The page describes "More info → Run anyway", and tells the user to verify the file first.
  - Verification: compare `Get-FileHash` with `SHA256SUMS`, and run `gh attestation verify`, which ties the file to the release workflow run and the source commit.
  - Antivirus software may flag or slow the unsigned helper, which the Ports view starts every 3 seconds while it is open (already in `docs/ports.md`).
  - The archive's index, and the bytes of each file read from it, are validated on Windows (D3), but without a signature nothing protects `Veydr.exe` itself, which holds the expected hash. `docs/security-baseline.md` states that.
- **The build never finds a certificate.** On Windows electron-builder signs only with a certificate from `CSC_LINK` or `WIN_CSC_LINK`, or from signing options in the configuration (`cscLink`, `signtoolOptions`, `azureSignOptions`). None is defined. The workflow policy test rejects every `CSC_*` or `WIN_CSC_*` variable in the workflows except `CSC_IDENTITY_AUTO_DISCOVERY: "false"` on the packaging step, which affects only macOS signing and is kept as a marker. A unit test rejects signing options in `electron-builder.yml`. What enforces the decision is a package test: `Veydr.exe`, the helper and the installer must read `NotSigned` (`Get-AuthenticodeSignature`). electron-builder still logs "signing with signtool.exe" for each executable before it finds no certificate and skips.

Alternatives considered:

- *A paid certificate or Azure Trusted Signing:* costs money and needs identity validation; a maintainer decision under G-6.
- *SignPath Foundation's free signing for open-source projects:* an application and an external service in the release path; worth a later change.
- *A self-signed certificate:* Windows trusts it no more than no signature.

### D9. The preview statement and the docs

- **The sentence**, the same on every page: **"Windows: preview. Unsigned installer; verified in CI on Windows Server 2025."** It replaces "Windows: preview. Run from source; verified in CI on Windows Server 2025. No Windows package yet." in the README, `processes.md`, `commands.md`, `logs.md` and `ports.md`, and in the tests that assert it (`readme-docs`, `processes-docs`, `commands-docs`, `logs-docs`, `ports-docs`).
- **`docs/install-windows.md`** (new): requirements; download and verification; SmartScreen; what is installed where; updating (quit Veydr, run the newer installer); uninstalling (the configuration stays); the permissions limit (D4); and "Not verified", which carries the list of `docs/windows-evidence.md` plus a full session in the installed app, an interactive install, and installing over a running Veydr. A unit test, `install-windows-docs.test.ts`, keeps the page consistent with `electron-builder.yml` (the installer's name, the install directory, the options) and checks that the files it names exist.
- **Other pages:**
  - README: the platform table, the installation section (Windows installer first, running from source kept), and the row "A Windows package" removed from the not-included list;
  - `install-linux.md`: its sentence about Windows;
  - `ci.md`: the `windows-package` job, manual builds, releasing, and verifying a release package on Windows;
  - `security-baseline.md`: the Windows packaged build, ASAR integrity on Windows, unsigned binaries;
  - `dependencies.md`: electron-builder's NSIS toolchain download, and the shipped helper;
  - `deferred-checks.md`: a dated "Windows packaging" section that closes the "Windows packaging and helper placement" row;
  - `windows-evidence.md`: "Resolved in W4" notes under the W4 statements, as W2 and W3 added theirs. The recorded results do not change.
- User-facing pages (the README, the preview sentence, `install-windows.md`) change only in group 6, after a release can carry the installer. The maintainer pages (`ci.md`, `dependencies.md`) change in the group that adds what they describe, and say what has not run yet.

## Risks / Trade-offs

- [The NSIS install was measured only as an administrator; a standard user's silent install may behave differently on the runner] → D5 measures it. If it fails for a reason in the product or the installer, it is fixed. If it cannot work on the runner for a reason outside both, the claim "installs without administrator rights" is not made, and the maintainer decides before the docs change.
- [Electron may not start for the secondary-logon account, which has never been tried] → D5 fixes the rule in advance: the helper is exercised directly, which needs no window, and the smoke test is judged against a stock-Electron control. The spec's standard-user scenarios name the install and the helper, not the smoke test.
- [Electron might validate only the archive's index, not each file's bytes] → measured in task 2.4: on Windows both a changed index (case a, which the spec requires) and changed bytes with the index untouched (case b) are refused, and the tests assert both. What stays unprotected is `Veydr.exe`, and a file that is never read from the archive is not checked.
- [`packElevateHelper: false` or `differentialPackage: false` may not remove `elevate.exe` or the `.blockmap`] → the package-contents test lists `resources\` and `dist\` exactly, so either shows up at once.
- [Unsigned binaries: SmartScreen and antivirus may block the installer or the helper on users' machines, which CI cannot show] → documented with verification steps; `smartscreen` and `av-third-party` stay in the not-verified list; signing is the named follow-up.
- [No full session is driven in the installed app] → D7; listed as not verified. The first user report from a real desktop is the next evidence.
- [The Windows release gate adds two jobs to every release, and a flaky Windows runner can block a Linux release] → a release is rerun as today; W1 recorded one slow-runner incident. The jobs run in parallel with the Linux gate.
- [The tests install into the runner's real profile] → the installer tests run only in CI, on a VM that is discarded, and they uninstall and check that nothing is left.
- [electron-builder downloads its NSIS toolchain at build time] → it did so in W0, it verifies its downloads, and `docs/dependencies.md` records it.
- [`csc.exe` output is not reproducible, so the packaged helper differs byte for byte from the one the `windows` job tested] → the same source and compiler are used, and the installed helper is exercised directly (D3).

## Migration Plan

1. Groups 1–4 of `tasks.md` add the helper path, the configuration, the tests and the CI job. No document changes its Windows statement yet, and no release carries an installer.
2. Group 5 adds the installer to manual builds and releases.
3. Group 6 changes the preview statement and adds `docs/install-windows.md`.
4. The first release after the merge attaches the installer. Before publishing that draft, the maintainer checks the three packages, `SHA256SUMS` and both records, as `docs/ci.md` describes.

Rollback: revert the pull request of the failing group. Without group 5 the release workflow builds Linux packages only, as today. A user removes the app with its uninstaller; the configuration is shared with a from-source run and stays valid.

## Open Questions

- Whether to apply to SignPath Foundation, or to propose a paid certificate under G-6, once the preview has users. Neither changes this change's specs or tasks.
