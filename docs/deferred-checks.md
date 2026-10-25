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

## Status after L8 (2026-10-25)

| Area | Outcome | Evidence |
|---|---|---|
| Electron fuses | Done. The six fuses are set; run-as-node, `NODE_OPTIONS`, `--inspect`, and an `app` folder are ignored by the packaged binary (controls with the stock binary). Limitation: Electron does not validate `app.asar` integrity on Linux, so the integrity fuse has no effect there (see `security-baseline.md`). | `test/packaging/fuses.test.ts` |
| Packaged behavior | Done. In the packaged app DevTools do not open when requested; the UI is served from `app.asar`; the dev-server override is absent from the bundle. | `--smoke-test` (`test/packaging/smoke.test.ts`), `test/packaging/package-contents.test.ts` |
| Packaging contents | Done. The archive holds `out/main`, `out/preload`, `out/renderer`, `package.json`, and `zod` only; no probe strings, source maps, docs, or tests; no update metadata. | `test/packaging/package-contents.test.ts` |
| Process sandbox on target distros | Veydr now refuses `--no-sandbox`; the AppImage's desktop entry no longer adds it. The `.deb` ships the AppArmor profile and sets `chrome-sandbox` setuid only without user namespaces. Container results: `install-linux.md`. A real Ubuntu 24.04 host (AppArmor restriction): **BLOCKED**, no host available (task 9.6). | `test/packaging/package-contents.test.ts`, E2E `failure.spec.ts`, `scripts/smoke-linux.sh` |
| Single instance / focus | Not re-checked in L8: the containers run `--smoke-test` only, under Xvfb (X11), which takes the lock but does not exercise a second launch. Remains as in F1. | — |
| Network isolation at OS level | Not done in L8: no packet capture or network-namespace run of the packaged app. Remains for L9. | — |
