# Proposal

## Why

W1–W3 made Windows work from the app: process trees, commands and the environment, and port inspection, all verified natively in CI. But Windows still runs only from source. The user must clone the repository, install Node, and build the app and the helper. Every page says "No Windows package yet".

W4 is the last step of the Windows roadmap (foundation design, `add-windows-packaging`). It ships the installer and closes the items earlier changes left for it:

- the helper's path is inside `app.asar` in a packaged app, so a packaged Veydr reports "Windows helper not found";
- the permissions of the directory the helper is installed into were never checked;
- the smoke test was never repeated on a packaged app, nor as a standard user;
- the signing decision (gate G-6) is open;
- the preview statement still says "run from source".

W0 already showed that the route works on the runner: `nsis-build` and `nsis-install` are `PASS` for a per-user, one-click NSIS installer.

## What Changes

- **A Windows installer.** `electron-builder.yml` gains a `win`/`nsis` section: an x64, per-user, one-click NSIS installer named `Veydr-X.Y.Z-x64-setup.exe`. It installs to `%LOCALAPPDATA%\Programs\veydr` without administrator rights, adds a Start menu entry and an uninstaller, and ships no update metadata. `npm run dist:windows` builds it, on Windows only.
- **The helper ships outside the archive.** `veydr-helper.exe` is built from source by the packaging script (`dist:windows`) and packaged as `resources\veydr-helper.exe`, beside `app.asar`. A packaged app looks for it there; an unpackaged app keeps `out-helper/`. No helper binary is committed.
- **Windows packaging tests.** A new test set runs on `windows-2025` against the built package and the installed app:
  - the archive and the `resources` directory hold only what they should;
  - the fuses are set, and an `app.asar` whose index was modified is refused (Electron validates the archive's index on Windows, unlike on Linux; a change to a file's bytes alone is a documented limit);
  - `--smoke-test` passes for the unpacked build and for the installed app, including the `platform` check, which lists ports through the packaged helper;
  - a command tree starts and stops through the installed helper;
  - silent install, reinstall over an existing install, and silent uninstall work, and the uninstall keeps the user's configuration;
  - the install directory and the helper are writable only by the installing user, SYSTEM and Administrators;
  - the install, the permissions, the installed helper and the uninstall also pass as a temporary standard user, with the smoke test there too if Electron can start for that account on the runner (design D5).
- **CI, manual builds and releases.**
  - `ci.yml` gains a `windows-package` job, required through `ci-ok`.
  - `build.yml` builds the installer of any ref, with its `SHA256SUMS`.
  - `release.yml` gains two gate jobs on the bumped tree: `windows` (helper build, Windows integration and end-to-end tests) and `windows-package`. The draft release then carries the installer, covered by `SHA256SUMS` and by the build provenance attestation, and a Windows install record that names the SHA-256 of the installer it tested.
- **Signing decision (G-6): unsigned, to be confirmed by the maintainer before group 2.** No paid certificate or signing service is bought. The installer, `Veydr.exe` and the helper are unsigned, so SmartScreen warns on first run. The docs say so and tell the user how to verify the download (`SHA256SUMS`, `gh attestation verify`). G-6 stays a gate for any later spending.
- **The shipped preview statement.** README and docs replace "Run from source … No Windows package yet" with **"Windows: preview. Unsigned installer; verified in CI on Windows Server 2025."** A new `docs/install-windows.md` covers installing, verifying, SmartScreen, updating, uninstalling, and what was not verified. Running from source stays documented.
- **Not changed:**
  - no npm dependency is added, and the Linux packages are built as before;
  - no auto-update, no per-machine install, no MSI, MSIX, portable or arm64 build, no winget or Store listing;
  - Windows stays a preview: nothing is claimed for an interactive Windows 10/11 desktop beyond what CI on Windows Server 2025 shows.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `desktop-shell`: "Hardened packaged runtime" states what Electron validates of the archive on Windows, and its limits. New requirements cover the per-user Windows installation and the helper shipped with the package.
- `process-supervision`: "Windows supervision in preview" describes Windows as installed from an unsigned installer (or run from source) instead of "run from source, with no Windows package".
- `quality-gates`: "Pull request and main-branch checks" adds Windows packaging with its packaging tests. "Windows helper built from source" covers the packaged helper.
- `release-automation`: the release gate, the draft release and the manual build include the Windows installer. A new requirement covers the Windows install record.

## Impact

- **Product code:** `src/main/platform/index.ts` (`windowsHelperPath`) and its caller in `src/main/index.ts`. Nothing else in `src/` changes.
- **Packaging:** `electron-builder.yml` (`win`, `nsis`), a committed `build/windows/icon.ico` rendered by `scripts/render-icons.cjs`, and `package.json` scripts `dist:windows` and `test:packaging:windows`.
- **Tests:** a new `test/packaging-windows/` set and vitest project; unit tests for the helper path, the docs, and the workflows (`workflow-policy.test.ts`); the docs tests that assert the preview sentence.
- **Scripts:** `scripts/windows-probe/standard-user.ps1` gains an `-Installer` parameter, with a new driver `installer-standard-user.mjs`; `scripts/sha256sums.mjs` writes `SHA256SUMS` on Windows in GNU format.
- **CI:** `.github/workflows/ci.yml`, `build.yml` and `release.yml`. No new secret and no new write scope.
- **Docs:** new `docs/install-windows.md`; README, `docs/processes.md`, `commands.md`, `logs.md`, `ports.md`, `install-linux.md`, `ci.md`, `security-baseline.md`, `dependencies.md`, `deferred-checks.md` and `windows-evidence.md`.
- **Build-time downloads:** electron-builder downloads its NSIS toolchain on the Windows runner, as it already did in the W0 `nsis` probe. Recorded in `docs/dependencies.md`.
- **Users:** Windows users get an installer on GitHub Releases from the first release after this change. Linux users see no change.
- **Follow-ups (out of scope):** signing if the maintainer approves spending under G-6; an interactive check on a Windows 10/11 desktop (SmartScreen, Explorer launch, logoff); the explicit handle list for started processes (`docs/deferred-checks.md`, "Windows handle inheritance").
