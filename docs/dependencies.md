# Dependencies

All direct dependencies are pinned to exact versions (`test/unit/package-policy.test.ts`). Every locked package resolves from `registry.npmjs.org` with a sha512 integrity hash. `.npmrc` sets `engine-strict=true` and `min-release-age=7`, and `package.json` requires npm `>=11.19.0`. That is the npm version F1 was developed and verified with, not a proven minimum: `allowScripts` support first appears in npm 11.16.0 (11.15.0 and 11.14.0 have no allow-scripts code; checked by unpacking the release tarballs), and an npm older than that would silently ignore the key and run install scripts. The key's enforcement was checked on 11.19.0: with it, `electron-winstaller`'s install script does not run in `npm ci`; without it, it does.

## Install scripts

Only `electron-winstaller` (Windows installer, via `electron-builder`) and `fsevents` (macOS file watching, optional) have install scripts; both are set to `false` in `allowScripts`, and the policy test fails if a new locked package with an install script has no explicit decision. Electron 44 downloads its binary lazily on first use (`scripts/ensure-electron.cjs` resolves it before E2E runs).

## `npm audit` (8 moderate, accepted)

All eight entries are one advisory, `sprintf-js` ≤ 1.1.3 DoS through unbounded precision specifiers (GHSA-hp3w-g68c-fv3c, CWE-1284, CVSS 5.3), propagated through:

`electron-builder` → `app-builder-lib` → `@electron/get@3.1.0` → `global-agent` → `roarr` → `sprintf-js`

* `npm audit --omit=dev` reports **0 vulnerabilities**: the shipped dependency tree (`zod`) is clean.
* Build-time only: `electron-builder` is a devDependency and none of this ships in the application. Electron's own downloader is `@electron/get@5.1.0`, which is not affected.
* Not exploitable in practice: it needs attacker-controlled format strings in `roarr` logging inside `global-agent`, which is active only behind proxy environment variables.
* The only fix `npm audit` offers is a downgrade of `electron-builder` to 26.5.0, which trades an unreachable DoS for older tooling. Not applied. **Revisit before packaging (task 9.1)**.

## Version choices

* **Electron 44.9.3**: latest 44.x patch when pinned. 45.0.0 followed on the same day (2026-10-21; 44.9.3 at 03:31Z, 45.0.0 at 06:03Z, per the registry) and was deliberately not adopted: a new major with no soak time. Adopt a newer major deliberately, from the stable line, when its first patch releases ship. Electron releases a major roughly every eight weeks and supports only the latest few majors, so schedule a re-evaluation at each group review.
* **TypeScript 6.0.3**: `typescript-eslint@8.72.0` peers `typescript >=4.8.4 <6.1.0`; TypeScript 7 is outside that range.
* **Freshness**: several G-1 pins were published within days of installation (`@tanstack/react-virtual` the same day, `vite` and `electron` about a day before). Lockfile integrity matches the registry. `.npmrc` now sets `min-release-age=7`, so any *new* resolution (`npm install`, `npm update`) refuses versions younger than seven days; `npm ci` follows the lockfile and is unaffected, so the existing young pins remain until they are deliberately bumped. A security fix may justify an override (`--min-release-age=0` for that one command, recorded in the review). Verify `npm ci` and `npm audit` after any bump.
* **`@tanstack/react-virtual` 3.14.22** is on the G-1 approved list (design D13) and stays pinned. Nothing imports it until log virtualization (group L6). It was published the same day it was installed; the lockfile integrity hash matches the registry's. Because it is unused, it is not part of the shipped app (devDependency, bundled only when imported). At the start of L6, re-check its publish date and advisories and bump only deliberately. No G-1 dependency was added or removed during F1 review.
