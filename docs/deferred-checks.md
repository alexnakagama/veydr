# Checks deferred to packaging (task 9.1 and later)

F1 verifies the unpackaged build (`electron .` on the built `out/`, and `electron-vite dev`) on one Linux machine: Debian 13, GNOME/Wayland, x64, unprivileged user namespaces enabled. The following are **not** verified by F1 and must be covered by L8 tasks before any release claim.

| Area | Not verified in F1 | Owner |
|---|---|---|
| Electron fuses | `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off, `EnableNodeCliInspectArguments` off, `EnableEmbeddedAsarIntegrityValidation` on, `OnlyLoadAppFromAsar` on, `EnableCookieEncryption` on; spec scenario "Run-as-node disabled". Unpackaged builds run with default fuses. | 9.1 |
| Packaged behavior | Branches keyed on `app.isPackaged`: DevTools disabled, dev-server override ignored (the override is already compiled out of non-dev builds, tested). Serving `app://` content out of an ASAR archive (`fs.readFile` on archive paths). | 9.1, 9.2 |
| Packaging contents | `out-probe/` (network-probe build) must never be packaged; the package must contain only the production `out/` and be checked for the probe strings. `docs/` and tests are not shipped. | 9.1 |
| Process sandbox on target distros | E2E asserts no `--no-sandbox` on this host only. Ubuntu 24.04 restricts unprivileged user namespaces (AppArmor profile needed), AppImage/`chrome-sandbox` permissions, Fedora/Debian 12 behavior. | 9.4, 9.5 |
| Single instance / focus | Verified on Wayland by hide/show (compositors do not report minimized state). Minimize-restore path, X11 and other desktops are untested. | 9.5 |
| Windows and macOS | Windows stubs are unit-tested to fail explicitly; no Windows or macOS runtime has been run. Windows is out of scope for this change. (Since 2026-10-27 the unit tests also run on Windows in CI, see [Windows CI lane](#windows-ci-lane-2026-10-27); runtime behavior is still unverified.) | Windows phase |
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
| Network isolation at OS level | Not done in L8: no packet capture or network-namespace run of the packaged app. Remains for L9 (done in L9, see below). | — |

## Status after L9 (2026-10-25)

| Area | Outcome | Evidence |
|---|---|---|
| Network isolation at OS level | Done for the packaged `.deb`: during the whole acceptance pass (two projects, three commands, flood, ports, quit, crash and recovery) `tcpdump` on the container's interface recorded no IP or IPv6 frame sent by the container (3 of 3 runs on the final package). A positive control proves the capture sees the container: before the run, the container opens a TCP connection to TEST-NET-1, whose SYN frames must be captured. Only frames with the container's MAC address count, because the bridge also carries the Docker host's own multicast (for example its mDNS service browsing); the kernel's ARP upkeep (a re-check of the gateway a few seconds after the control used it: in 3 of 17 earlier runs one frame from the container appeared during the run, and the one kept for inspection was this ARP request) is recorded separately, since any traffic would also appear as IP. A full user session also runs offline in the E2E suite, in a network namespace with only a loopback interface. | `scripts/acceptance-linux.sh` (`test/packaging/acceptance-linux-steps.jsonl`), `test/e2e/offline.spec.ts` |
| Single instance / focus | Unchanged: not re-checked on X11 or other desktops. | — |

## Windows CI lane (2026-10-27)

| Area | Outcome | Evidence |
|---|---|---|
| Windows and macOS | Partly started. The `windows` CI job runs typecheck, lint, and the unit tests on `windows-2025` for every pull request and push to `master`; unit tests that need a Linux facility are skipped there with a `[linux-only: …]` reason. Windows runtime behavior is still unverified: the Windows platform rejects every operation, and no integration, end-to-end, or packaging test runs on Windows. Windows remains not yet supported; macOS is unchanged. | `.github/workflows/ci.yml` (`windows`), `docs/ci.md`, `test/unit/test-platform-policy.test.ts` |
