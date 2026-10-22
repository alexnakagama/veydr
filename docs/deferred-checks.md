# Checks deferred to packaging (task 9.1 and later)

F1 verifies the unpackaged build (`electron .` on the built `out/`, and `electron-vite dev`) on one Linux machine: Debian 13, GNOME/Wayland, x64, unprivileged user namespaces enabled. The following are **not** verified by F1 and must be covered by L8 tasks before any release claim.

| Area | Not verified in F1 | Owner |
|---|---|---|
| Electron fuses | `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off, `EnableNodeCliInspectArguments` off, `EnableEmbeddedAsarIntegrityValidation` on, `OnlyLoadAppFromAsar` on, `EnableCookieEncryption` on; spec scenario "Run-as-node disabled". Unpackaged builds run with default fuses. | 9.1 |
| Packaged behavior | Branches keyed on `app.isPackaged`: DevTools disabled, dev-server override ignored (the override is already compiled out of non-dev builds, tested). Serving `app://` content out of an ASAR archive (`fs.readFile` on archive paths). | 9.1, 9.2 |
| Packaging contents | `out-probe/` (network-probe build) must never be packaged; the package must contain only the production `out/` and be checked for the probe strings. `docs/` and tests are not shipped. | 9.1 |
| Process sandbox on target distros | E2E asserts no `--no-sandbox` on this host only. Ubuntu 24.04 restricts unprivileged user namespaces (AppArmor profile needed), AppImage/`chrome-sandbox` permissions, Fedora/Debian 12 behavior. | 9.4, 9.5 |
| Single instance / focus | Verified on Wayland by hide/show (compositors do not report minimized state). Minimize-restore path, X11 and other desktops are untested. | 9.5 |
| Windows and macOS | Windows stubs are unit-tested to fail explicitly; no Windows or macOS runtime has been run. Windows is out of scope for this change. | Windows phase |
| Network isolation at OS level | The E2E guard sees Node and Chromium networking only (see `network-isolation.md`). A packet capture or network-namespace run of the packaged app is not part of F1. | 9.5 |
| Dev-server mode | Verified manually once (2026-10-22): `electron-vite dev` window loads `http://localhost:5173/`, IPC works, no Node globals, CSP header present, inline script and navigation blocked. Not part of the automated suite. | n/a |

Tasks 9.1, 9.4 and 9.5 in `tasks.md` reference this list.
