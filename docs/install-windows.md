# Installing on Windows

**Windows: preview. Unsigned installer; verified in CI on Windows Server 2025.** Veydr for Windows is an x64 installer for the current user. It is built and tested in CI on GitHub's `windows-2025` runner (Windows Server 2025) for every pull request and push to `master`, but nothing on this page was checked on a Windows 10 or 11 desktop: see [Not verified](#not-verified). What commands, processes, output and ports do on Windows, and what the CI runner cannot show about them, is in the Windows sections of [commands.md](commands.md#windows-preview), [processes.md](processes.md#windows-preview), [logs.md](logs.md#windows-preview) and [ports.md](ports.md#windows-preview).

In the commands below, replace `X.Y.Z` with the version you install.

## Requirements

- **Windows x64.** There is no build for Arm64 or 32-bit Windows.
- **No administrator rights.** The installer installs for your user only, and its manifest asks Windows for no elevation (`asInvoker`, checked in CI). A silent install by a standard user succeeded in CI without elevation; whether the interactive installer shows a UAC prompt was not observed (see [Not verified](#not-verified)).
- The **.NET Framework 4.8** runtime, as a precaution. Veydr's helper, `veydr-helper.exe`, is compiled with the .NET Framework 4.8 compiler (see [dependencies.md](dependencies.md#windows-process-tree-helper-gate-g-4-2026-11-03)) and has run only with 4.8, on Windows Server 2025, in CI. Windows 10 version 1903 and later and Windows 11 include 4.8. Windows 10 1809 and earlier, LTSC 2019 among them, ship 4.7.2: the helper is expected to run on any 4.x runtime, but that was not tested, so install 4.8 there. Windows 10 and 11 are not verified.

## The installer

The installer is `Veydr-X.Y.Z-x64-setup.exe`: an NSIS installer built by electron-builder from `electron-builder.yml` with `npm run dist:windows`. It is:

- **per-user and one-click:** it installs into your own profile, with no pages to go through, and needs no administrator rights;
- **unsigned:** the installer, the application (`Veydr.exe`) and its helper (`veydr-helper.exe`) carry no Authenticode signature, so Windows shows no publisher for them (see [SmartScreen](#smartscreen));
- **without auto-update:** Veydr never checks for or downloads a newer version, and the package carries no update metadata. You update by running a newer installer (see [Updating](#updating)).

## Download and verify

Released versions are on the [GitHub Releases page](https://github.com/alexnakagama/veydr/releases). A release made after the Windows installer was added carries, besides the Linux packages:

- `Veydr-X.Y.Z-x64-setup.exe`, the installer;
- `SHA256SUMS`, the checksums of every package of the release, the installer included;
- `install-windows-steps.jsonl`, the record of the installation test the release ran on this installer: its first line names the installer's SHA-256, and each later line one step, as the administrator and as a standard user. It is not in `SHA256SUMS` and not attested, so it is information, not proof: anyone who could change the release could change it.

Earlier releases have Linux packages only. For a version without an installer, [build it yourself](#building-the-installer).

No release has carried the installer yet. The first release that does is also the first run of the release workflow's Windows path (see [ci.md](ci.md#releasing)), so the files above and the checks below have not yet been used on a real release. The same installer and checksum checks run in CI and in every manual build.

Because the installer is unsigned, nothing in Windows tells you who built it. Run both checks before you start it. The checksum shows that your download is complete and matches the release's `SHA256SUMS`, but that file comes from the same release page, so it does not show where the installer came from. The attestation does: it ties the installer to this repository's release workflow. In PowerShell, in the folder with the downloaded installer and `SHA256SUMS`:

```powershell
$name = 'Veydr-X.Y.Z-x64-setup.exe'
$line = Get-Content SHA256SUMS | Where-Object { $_ -ceq "$((Get-FileHash -Algorithm SHA256 -LiteralPath $name).Hash.ToLower())  $name" }
if ($line) { "${name}: OK" } else { "${name}: FAILED" }
```

It must print `OK`. Then check the build provenance with the [GitHub CLI](https://cli.github.com/):

```powershell
gh attestation verify Veydr-X.Y.Z-x64-setup.exe --repo alexnakagama/veydr --signer-workflow alexnakagama/veydr/.github/workflows/release.yml
```

This is the provenance check. It succeeds only for a file whose digest this repository's release workflow attested, and prints the workflow run and the source commit it was built from. More on both checks is in [ci.md](ci.md#verifying-a-release-package).

## SmartScreen

When you start the downloaded installer, Windows may show **"Windows protected your PC"**, with the publisher **"Unknown publisher"**. Microsoft Defender SmartScreen shows this for downloaded programs without an established reputation, and an unsigned program has none until many people have run it. Verify the file first, as described above. Then choose **More info**, check that the file name is `Veydr-X.Y.Z-x64-setup.exe`, and choose **Run anyway**. If the checks failed, do not run it.

Antivirus software may also flag or slow down the unsigned files, in particular the helper, which Veydr starts for every command and, while the **Ports** view is open, every 3 seconds (see [ports.md](ports.md#windows-preview)). The CI runner has Microsoft Defender only, and shows no SmartScreen prompt, so neither is verified.

## Install

Start the installer. A one-click installer has no pages: it shows its progress, installs, and then starts Veydr. That is electron-builder's behavior; CI installs silently only, so it is not verified (see [Not verified](#not-verified)).

To install without any window, as CI does, run it silently from PowerShell:

```powershell
Start-Process -Wait .\Veydr-X.Y.Z-x64-setup.exe -ArgumentList '/S'
```

A silent install does not start Veydr.

## What is installed where

| What | Where |
|---|---|
| The application | `%LOCALAPPDATA%\Programs\veydr`, with `Veydr.exe` and `Uninstall Veydr.exe` |
| The application archive | `%LOCALAPPDATA%\Programs\veydr\resources\app.asar` |
| The helper | `%LOCALAPPDATA%\Programs\veydr\resources\veydr-helper.exe`, beside the archive, never inside it |
| A Start menu entry | `Veydr.lnk` in your Start menu's Programs folder |
| An uninstall entry | your user's part of the registry (`HKEY_CURRENT_USER`), shown in **Settings › Apps › Installed apps** |
| Your configuration and run record | `%APPDATA%\Veydr`, created by Veydr when it first runs, not by the installer |

The installer creates no desktop shortcut, no uninstall entry under `HKEY_LOCAL_MACHINE`, and no `Run` or `RunOnce` value or Startup shortcut, so Veydr does not start when you log in. These are what CI checks; other autostart places, such as scheduled tasks or services, were not inspected, and the installer is not configured to create any. Your configuration lives outside the install directory, so installing, updating and uninstalling leave it alone.

## Checking an installation

Close Veydr first, then run its smoke test in PowerShell:

```powershell
& "$env:LOCALAPPDATA\Programs\veydr\Veydr.exe" --smoke-test | Write-Output
$LASTEXITCODE
```

It prints a line starting with `VEYDR_SMOKE_TEST` with a JSON report of seven checks, and exits with status 0 if every check passed. The checks are the ones described in [install-linux.md](install-linux.md#checking-an-installation); on Windows the `platform` check reads the environment Veydr was started with and lists the listening ports through the installed helper, so it also shows that the helper can be found and started. The smoke test creates the configuration directory if needed and writes and removes a probe file there. It does not read or write `config.json` or the run record by design; in CI, which ran it with no configuration present, it left none of Veydr's own files behind. Electron keeps its own profile data (caches, local storage) in the same directory, and the smoke test, like any start of Veydr, may write there.

## Updating

1. Quit Veydr. Quitting stops every command it started, as described in [processes.md](processes.md#windows-preview).
2. Download and verify the newer installer, and run it. It installs over the existing installation.

Your configuration is kept. Do not run the installer while Veydr is running: it may close Veydr, which would end its commands as an abnormal exit does ([processes.md](processes.md#after-an-abnormal-exit-on-windows)). That case is not tested.

## Uninstalling

Quit Veydr, then remove it in **Settings › Apps › Installed apps** (choose **Veydr**, then **Uninstall**), or run its uninstaller silently:

```powershell
Start-Process -Wait "$env:LOCALAPPDATA\Programs\veydr\Uninstall Veydr.exe" -ArgumentList '/S'
```

Uninstalling removes the install directory, the Start menu entry and the uninstall entry. If another program briefly holds the Start menu entry open, as a virus scanner may, the uninstaller retries removing it for up to 10 seconds. The uninstaller copies itself and returns before it has finished, so the directory may take a few seconds to disappear. Your configuration in `%APPDATA%\Veydr` is kept, as removing the `.deb` keeps `~/.config/Veydr`. To remove it too, delete that folder.

## Permissions of the install directory

The installer sets no permissions of its own. The install directory and every file in it get the permissions your profile gives new files below `%LOCALAPPDATA%`: the profile's inherited default. On the CI runner, for the administrator and for a standard user alike, that was full control for three accounts only: you, `SYSTEM`, and the Administrators group. CI fails if any other account may write to the directory, `Veydr.exe`, `app.asar`, the helper, or any other installed file.

The limit: the directory is writable by you, by design of a per-user install. Any program that runs as your user can therefore replace `Veydr.exe` or the helper, as it could replace any other program in your profile. Such a program can already start processes as you, so this gives it nothing new. Veydr does not check these permissions when it starts the helper; it checks only that the helper is a regular file at the expected path that answers with the protocol version Veydr needs. If your profile's defaults grant other accounts write access below `%LOCALAPPDATA%`, the installation inherits that, and Veydr does not detect it.

## Integrity of the application

The application's code is in `resources\app.asar`. `Veydr.exe` holds the SHA-256 of the archive's index, which lists every file with its size and its own hash, and Electron validates the archive against it:

- at startup, an archive whose index was changed is refused: Veydr does not start, and the changed code does not run;
- when a file is read from the archive, its bytes are checked against its hash in the index: an archive whose file bytes alone were changed, its index untouched, is refused as well.

Both were measured in CI on the packaged build (`test/packaging-windows/fuses.test.ts`): by changing the main bundle, which Electron loads as code, and, for changed bytes, also the page of Veydr's window, which Veydr reads as a file. Other files of the archive were not modified in a test; they are read in the same two ways. What the validation does not cover:

- `Veydr.exe` itself, which holds the expected hash and is unsigned: whoever can write the install directory can replace it together with the archive;
- files outside the archive: the helper, the uninstaller, and Electron's own libraries and resources beside `Veydr.exe`;
- a file in the archive that is never read.

The packaged build also ignores `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect`, and loads no application code from outside the archive. The security baseline is in [security-baseline.md](security-baseline.md).

## Building the installer

On Windows x64, with **Node.js 24** and **npm 11.19.0 or newer** (see the README's [Prerequisites](../README.md#prerequisites)), in a clone of the repository:

```powershell
npm ci
npm run dist:windows
```

This builds the helper from its source first, then writes `dist\Veydr-X.Y.Z-x64-setup.exe`, named after the version in `package.json`. The build needs Windows; elsewhere it stops with "the Windows helper can only be built on Windows". The first run downloads electron-builder's NSIS tools (see [dependencies.md](dependencies.md#packaging-toolchain-task-91)). `npm run test:packaging:windows` builds it and runs the packaging tests too; the installation tests among them run only in CI, since they install into your profile.

To run Veydr from source instead, without installing it, see [Running from source on Windows](../README.md#running-from-source-on-windows).

## What CI verifies

For every pull request and push to `master`, and for every release, the `windows-package` job builds the installer on `windows-2025` and tests it (`test/packaging-windows/`):

- the package holds the helper beside the archive, no executable inside the archive, no update metadata, and no signature on any executable (`package-contents.test.ts`);
- the fuses, and the archive validation described above (`fuses.test.ts`);
- the smoke test of the unpacked build (`smoke.test.ts`);
- as the runner's administrator: a silent install, the installed files, the Start menu and uninstall entries, no desktop shortcut and no logon entry, no Veydr left running, the installed application's smoke test, a command tree started and ended through the installed helper, the permissions, an install over the existing installation, and a silent uninstall that keeps the configuration (`installer.test.ts`);
- as a temporary standard user without administrator rights: a silent install, the permissions, the installed helper (its version and the port listing), the installed application's smoke test, and a silent uninstall (`standard-user-install.test.ts`).

A release attaches the record of these steps, `install-windows-steps.jsonl`, for the installer it attaches; no release has done so yet. Every manual build (`build.yml`) also checks its `SHA256SUMS` with the command in [Download and verify](#download-and-verify), under PowerShell 7 and Windows PowerShell 5.1.

## Not verified

The CI runner is a Windows Server 2025 virtual machine without an interactive desktop. These stay unverified until a check on a real Windows 10 or 11 installation:

- the SmartScreen prompt for the downloaded installer (`smartscreen`);
- an interactive install: the one-click installer's window, and Veydr starting after it;
- a full session in the installed application, with its window driven by a user: CI runs the installed application's smoke test and the helper, and the end-to-end suite runs against the same build unpackaged, but nothing drives the installed application's window;
- installing or updating while Veydr is running;
- starting Veydr from the Start menu or Explorer, and the environment it then gets (`env-desktop-launch`), with no Job Object around it (`ctx-job`);
- logging off or shutting down Windows while commands run (`pt-logoff`);
- elevation prompts (`ux-uac-prompt`): whether the interactive installer shows one, and a command that requests elevation;
- a localized Windows (`l10n-console`);
- third-party antivirus software (`av-third-party`);
- the `koffi` foreign-function check, which was not approved and which Veydr does not use (`ffi-koffi-electron`).

The names in parentheses are the probe checks of [windows-evidence.md](windows-evidence.md#not-verifiable-on-the-runner), where each is listed with what would verify it. The conditions of the Windows sections of [processes.md](processes.md#not-verified-on-the-ci-runner) apply to the installed application as well.

In two CI runs before the fix, the Start menu entry was left after a silent uninstall that removed everything else: the uninstaller tried to delete it once, while another process held it open. The uninstaller now retries for up to 10 seconds, and CI tests the uninstall with the entry held open for 5. A program that holds it longer can still leave it; if a `Veydr.lnk` is left after uninstalling, delete it from your Start menu's Programs folder.
