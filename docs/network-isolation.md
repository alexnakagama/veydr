# Network isolation

Veydr is local-only: no telemetry, no update checks, no remote content (spec `desktop-shell`, "Local-only operation").

## What enforces it

| Layer | Mechanism |
|---|---|
| Renderer content | Only `app://veydr/` is loaded; navigation, redirects, subframe navigation, `<webview>` and new windows are denied (`src/main/app/security.ts`). |
| Renderer requests | CSP `connect-src 'none'`, `default-src 'none'` (`src/main/app/csp.ts`). |
| WebRTC | CSP does not govern WebRTC, so `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')` is applied to every web contents. |
| Chromium services | Spellchecker (dictionary downloads from a Google CDN) disabled at session creation; permission, device and display-capture requests denied. |
| Dev server | `ELECTRON_RENDERER_URL` is honored only in `electron-vite dev` builds (`__VEYDR_DEV__`), only for plain-http loopback URLs, and is compiled out of every other build. |

## What the E2E guard observes

Every test using the `veydr` fixture runs the app with two observers (`test/e2e/support`):

* **Node hook** (`net-guard.cjs`, loaded with `-r`): `net.Socket.connect` (covers `http`, `https`, `tls`, `fetch`), `dgram` send/connect, and `dns.*` lookups, in the main process.
* **Chromium net-log** (`--log-net-log`, capture mode `Everything`): URL requests to non-local schemes, plus connection-level events (TCP/UDP/socket connects, `UDP_BYTES_SENT`, DNS transactions and host-resolver requests). The raw-socket events are what reveal WebRTC/STUN traffic, which has no URL.

The guard fails a test when either observer reports an attempt, or when an observer was not active (so an empty report is never vacuous).

## Offline and at the OS level

* **Offline E2E** (`test/e2e/offline.spec.ts`): the suite runs a full session (register, edit, start, output, ports, stop) inside a network namespace that has only a loopback interface and no route; every step works.
* **Packet capture of the packaged app** (`scripts/acceptance-linux.sh`, task 10.2): the installed `.deb` is driven through the acceptance pass in a Debian 13 container while `tcpdump` records the container's interface. No IP or IPv6 frame sent by the container was recorded (2026-10-25, 3 of 3 runs on the final package); a positive control (a TCP connection attempt to TEST-NET-1 before the run) shows the capture does see the container's frames. ARP frames are recorded apart: the kernel re-checks the gateway on its own, and any traffic would also appear as IP. This sees every process in the container, including the ones outside Node and Chromium listed below, but only for that run and that environment (Xvfb, openbox, no desktop services such as GVfs or Avahi).

## The guard is a regression detector, not a proof

It cannot see, and the repository does not claim to rule out:

* OS-level activity outside the Node and Chromium stacks (DBus, `xdg-open`, desktop-portal calls, GTK/libsecret).
* Traffic from processes the app spawns (managed commands are user-configured and are not "Veydr" traffic).
* Node-hook gaps: the main process only; `dns.Resolver` instances and worker threads are not wrapped.
* Anything that happens after the observation window of a test (the smoke flow waits 5 s after the UI is interactive).
* Resource hints (`dns-prefetch`, `preconnect`) are not blocked by CSP. They need script or markup injection into the renderer, which the threat model already treats as full compromise (design D2); the guard does detect them.

Detection is itself tested by the **probe build** (`npm run build:probe` → `out-probe/`, selected by `--mode probe`): it fires a Node `fetch`, a Chromium `net.fetch` or a WebRTC STUN attempt at TEST-NET-1 (`192.0.2.1`, never routed), and the E2E suite asserts each is caught. Tests assert that the production bundle contains none of the probe code. `out-probe/` must never be packaged (packaging config in group L8 must include only `out/`).
