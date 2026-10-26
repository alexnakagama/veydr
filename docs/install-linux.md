# Installing Veydr on Linux

Veydr is built for **Linux x64** only; Windows and macOS are not supported yet. Two packages are produced by `npm run dist:linux` (in `dist/`):

| Package | File | Use it on |
|---|---|---|
| `.deb` (recommended) | `Veydr-<version>-amd64.deb` | Debian and Ubuntu |
| AppImage | `Veydr-<version>-x86_64.AppImage` | other distributions; needs `libfuse2` and user namespaces (below). **Does not start on Ubuntu 24.04** by default (its AppArmor restriction denies the AppImage user namespaces, so the launcher adds `--no-sandbox`, which Veydr refuses): use the `.deb` there |

## Install

Released packages, with `SHA256SUMS` and a build provenance attestation, are on [GitHub Releases](https://github.com/alexnakagama/veydr/releases); check a download as described in [ci.md](ci.md#verifying-a-release-package) before installing it. In the commands below, replace `X.Y.Z` with the version.

**.deb** (Debian, Ubuntu):

```bash
sudo apt install ./Veydr-X.Y.Z-amd64.deb
```

`apt` installs the libraries Veydr needs. Veydr is installed in `/opt/Veydr`, linked as `/usr/bin/veydr`, and gets a desktop entry. The package also:

- installs an **AppArmor profile** (`/etc/apparmor.d/veydr`) where AppArmor supports it. It lets `/opt/Veydr/veydr` create the user namespaces Chromium's sandbox needs; Ubuntu 24.04 otherwise forbids that for unprivileged programs (`kernel.apparmor_restrict_unprivileged_userns=1`). On releases whose AppArmor does not understand the profile (ABI 4.0), such as Ubuntu 22.04, it is skipped; they do not restrict user namespaces.
- makes `/opt/Veydr/chrome-sandbox` **setuid root** only if the system cannot create user namespaces at all; otherwise it stays `0755`.

Remove it with `sudo apt remove veydr` (the profile is unloaded and removed too). Your configuration in `~/.config/Veydr` is kept.

**AppImage**:

```bash
chmod +x Veydr-X.Y.Z-x86_64.AppImage
./Veydr-X.Y.Z-x86_64.AppImage
```

## Requirements

- **x64**, glibc **2.25** or newer (the newest symbol version any packaged binary requires; measured with `objdump -T`, `test/packaging/glibc.test.ts`). Every supported distribution ships 2.35 or newer.
- **Chromium's sandbox**: Veydr never runs without it and refuses to start if `--no-sandbox` is given. The sandbox needs unprivileged **user namespaces**, or the setuid `chrome-sandbox` that only the `.deb` can install.
- **AppImage only**:
  - **`libfuse2`** (FUSE 2) to mount itself. Recent distributions do not install it by default (Ubuntu 22.04+: `sudo apt install libfuse2` on 22.04, `libfuse2t64` on 24.04; Fedora: `fuse-libs`). Without it the AppImage fails with a FUSE error. Running it with `APPIMAGE_EXTRACT_AND_RUN=1` (or `--appimage-extract-and-run`) works without FUSE: it extracts itself to `/tmp` on every start.
  - **User namespaces** must be available to it. Where they are not (Ubuntu 24.04's AppArmor restriction applies to AppImages; some hardened systems disable them), the AppImage's launcher adds `--no-sandbox`, and Veydr then refuses to start with a message pointing to the `.deb`.
  - The launcher puts the image's directories in front of `PATH`, `LD_LIBRARY_PATH`, `XDG_DATA_DIRS`, and `GSETTINGS_SCHEMA_DIR` for Veydr itself. Veydr removes them again from the environment of the commands it starts (see [commands.md](commands.md)); folders and URLs opened through the desktop (**Open folder**) are opened by Electron with Veydr's own environment.

## Checking an installation

`veydr --smoke-test` (or `./Veydr-….AppImage --smoke-test`) checks that Veydr can run on this system and exits: status 0 if every check passed, 1 otherwise. It prints one line starting with `VEYDR_SMOKE_TEST` with a JSON report of each check:

| Check | Passes when |
|---|---|
| `process-sandbox` | Veydr was not started with `--no-sandbox` (otherwise nothing else is checked) |
| `config-dir-writable` | the configuration directory can be created and a file written to it (a temporary file, removed again) |
| `platform` | the Linux implementation is available and can read `/proc` (it lists the listening sockets) |
| `ui-loaded` | the interface loads from the package in a hidden window and renders |
| `preload-bridge` | the page sees exactly the application API groups |
| `renderer-isolation` | the window runs sandboxed with context isolation |
| `devtools-disabled` | (packaged builds) DevTools do not open when requested |

It never reads or changes `config.json` or the record of running commands, and starts no command. If another Veydr is running for the same user (or the configuration directory is not writable), it exits with 1 before checking anything. Messages about IPC handlers missing on standard error are expected: the smoke test loads the interface without its services.

## Supported distributions

Checked with `scripts/smoke-linux.sh` (Docker containers, Xvfb, an unprivileged user; each distribution once with user namespaces available and once without, using Docker's default seccomp profile). See "Recorded results" for what each run showed.

| Distribution | glibc | `.deb` | AppImage | Supported |
|---|---|---|---|---|
| Ubuntu 22.04 | 2.35 | PASS¹ | PASS | yes |
| Ubuntu 24.04 | 2.39 | PASS¹ | PASS² | pending 9.6 (real host with the AppArmor restriction not verified) |
| Debian 12 | 2.36 | PASS¹ | PASS | yes |
| Debian 13 | 2.41 | PASS¹ | PASS | yes |
| Fedora 44 | 2.43 | n/a | PASS | yes (AppImage) |

¹ With user namespaces available. The setuid `chrome-sandbox` path (systems without user namespaces) is not verified: the mode is set, but Veydr was not seen starting with it.
² In a container, which does not have Ubuntu 24.04's AppArmor restriction; on a real Ubuntu 24.04 desktop the AppImage does not start by default (see the package table).

**Recorded results** (2026-10-25, `test/packaging/smoke-linux-summary.txt`, the script's summary verbatim). With user namespaces: the `.deb` installs with `apt`, keeps `chrome-sandbox` at `0755`, and passes the smoke test; the AppImage passes with `APPIMAGE_EXTRACT_AND_RUN=1`. Without `libfuse2` the AppImage fails to mount itself on every distribution (**expected**, documented above). Without user namespaces: the `.deb`'s post-install script makes `chrome-sandbox` setuid (`4755`) as intended, but whether Veydr then starts could not be tested (the container lacks the `CAP_SYS_ADMIN` the setuid helper needs; **not verified**); the AppImage's launcher adds `--no-sandbox` and Veydr refuses to start (**expected**).

## Not verified

- **A real Ubuntu 24.04 host** with the AppArmor user-namespace restriction (task 9.6): **BLOCKED**, no such host was available. Containers share the host's kernel (Debian 13), which has no such restriction, so the `.deb`'s AppArmor profile is installed by the package but has not been seen working under the restriction; its syntax is checked with `apparmor_parser` (AppArmor 4.1). Expected without the profile: Chromium cannot create its sandbox and Veydr does not start.
- The setuid `chrome-sandbox` path of the `.deb` (systems without user namespaces): the mode is set correctly, but Veydr was not seen starting with it (see above).
- The AppImage mounted through FUSE inside the containers (they have no `/dev/fuse`); it was run with `APPIMAGE_EXTRACT_AND_RUN=1`, which uses the same launcher. On the build host (Debian 13, no `libfuse2`), likewise.
- Desktops other than GNOME on Wayland (the build host) and Xvfb (the containers); the smoke test does not exercise a second launch or window focus.
