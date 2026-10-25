# Design

## Context

See proposal.md for why this change is needed; the requirements are in `specs/quality-gates` and `specs/release-automation`. Constraints that shape the approach:

- **Checks already exist as npm scripts.** `typecheck`, `lint`, `test`, `test:integration`, `test:e2e`, `test:perf`, `spec-coverage`, `dist:linux`, `test:packaging` and `verify` cover everything, plus `scripts/smoke-linux.sh` and `scripts/acceptance-linux.sh` for the Docker-based checks. CI calls these scripts and never re-implements them.
- **Strict toolchain.** `.npmrc` has `engine-strict=true` and `min-release-age=7`. `package.json` requires Node `>=24` and npm `>=11.19.0`, and `allowScripts` is enforced only by npm 11.16 or newer (`docs/dependencies.md`). Whatever npm the runner's Node ships is not good enough by default.
- **The sandbox is part of what is tested.** E2E refuses `--no-sandbox` (`test/e2e/support/fixtures.ts`). `test/e2e/offline.spec.ts` needs `unshare --user --net`, and fails instead of skipping unless `VEYDR_ALLOW_SKIP_OFFLINE=1`. GitHub's `ubuntu-24.04` image sets `kernel.apparmor_restrict_unprivileged_userns=1`, which breaks both.
- **Electron needs a display.** E2E, perf and packaging tests launch a window.
- **Spec coverage includes this change.** `scripts/spec-coverage.mjs` reads the specs of active changes, in required mode, so every scenario in this change's specs needs a `[spec:…]` tag in a test before `verify` passes.
- **No new dependencies without a written justification.** There is no YAML parser among the direct dependencies; `js-yaml` exists only as a transitive dependency.
- **The repository has no `.github/` directory**, its default branch is `master`, and `package.json` is at `0.0.0`.

## Goals / Non-Goals

**Goals:**
- Keep workflow YAML thin. Logic that can be wrong (version validation, ordering) lives in Node scripts with unit tests.
- Ship exactly what was tested. The release attaches the files its own gate built and tested, never a rebuild.
- Least privilege by default. Write scopes appear only in the release publish job and the nightly report job.

**Non-Goals:**
- Matrix builds across Node versions or operating systems. The app targets one Node (`.nvmrc`) and Linux x64.
- Test sharding or a merge queue. One maintainer and a test suite of minutes do not justify them.
- Caching the build output (`out/`) between jobs. Each job builds what it tests; `electron-vite build` is fast.
- Reusable workflows shared across repositories.

## Decisions

### D1. Workflow set

| File | Triggers | Purpose | Blocks |
|---|---|---|---|
| `ci.yml` | `pull_request` → `master`, `push` → `master`, `merge_group` | Quality gate (spec: quality-gates) | Merge (`ci-ok`) |
| `security.yml` | `pull_request`, `push` → `master`, weekly cron | CodeQL; dependency review (PR only) | Merge (dependency review is required; CodeQL alerts go to the Security tab) |
| `nightly.yml` | daily cron, `workflow_dispatch(ref)` | perf P1–P4, `smoke-linux.sh`, `acceptance-linux.sh` | Nothing; failures go to a tracking issue |
| `build.yml` | `workflow_dispatch(ref, smoke: bool)` | Manual packages | Nothing |
| `release.yml` | `workflow_dispatch(version)` | Release (spec: release-automation) | n/a |

`merge_group` costs nothing and means a merge queue can be turned on later without editing the workflow. The production audit (`npm audit --omit=dev --audit-level=low`) runs inside `ci.yml`'s static job, not in `security.yml`, so it is part of `ci-ok`.

Alternative considered: one large workflow with `if:` conditions per trigger. Rejected. Separate files keep each workflow's permissions and triggers obvious, and that is what the policy test checks.

### D2. A local composite action for runner setup

`.github/actions/setup/action.yml` does the setup once for every job:
- `actions/setup-node` with `node-version-file: .nvmrc` and the npm cache;
- `npm install -g npm@11.19.0`, the exact version `docs/dependencies.md` was verified with, kept as one constant;
- `npm ci`, plus a cache for `~/.cache/electron` and `~/.cache/electron-builder` keyed on `package-lock.json`.

Inputs: `electron: true` adds `xvfb` and enables user namespaces (D3). `cache: false` turns off every cache, for the release (D8).

Alternative considered: copying the setup steps into each job. Rejected. Five workflows with four or five jobs each would drift, and the npm version pin would end up in many places.

### D3. Enabling user namespaces instead of weakening tests

Electron jobs run `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` before any test. This puts the runner in the state F1 was verified in (Debian 13 with namespaces allowed), so the sandbox and the offline test run for real. The policy test rejects `--no-sandbox` and `VEYDR_ALLOW_SKIP_OFFLINE` anywhere in `.github/`.

Alternatives considered:
- setting the skip variable: hides the very check `offline.spec.ts` exists for;
- installing Veydr's AppArmor profile on the runner: that covers the packaged binary, not `node_modules/electron`.

The Ubuntu 24.04 AppArmor path itself stays a manual check (task 9.6). CI deliberately does not claim to cover it.

### D4. CI job graph

```
setup cache warm-up (none, each job uses the composite action)

static ---------+  typecheck, lint, spec-coverage, npm audit --omit=dev, actionlint
unit -----------+  npm test
integration ----+  npm run test:integration
e2e ------------+  xvfb-run npm run test:e2e        (uploads test-results/ on failure)
package --------+  xvfb-run npm run test:packaging  (uploads dist/*.deb, *.AppImage, 7 days)
                v
ci-ok   if: always(); fails unless every need's result == 'success'
```

The jobs run in parallel, and concurrency cancels superseded runs on the same PR. `ci-ok` checks `needs.*.result` explicitly, so a skipped or cancelled job counts as a failure; a plain `needs:` would treat a skipped dependency as non-blocking. Only `ci-ok` and `dependency-review` are required in the ruleset, so renaming or adding jobs never touches repository settings.

`actionlint` runs from its official Docker image pinned by digest. Pinning by digest is the image equivalent of pinning by SHA; no binary is downloaded with `curl`.

### D5. `scripts/release-version.mjs`

There is no semver library. Precedence (SemVer 2.0 §11, including prerelease identifiers) takes about 40 lines, and pure exported functions are unit-tested, the way `spec-coverage.mjs` exports `slugify`.

- `check <version>` validates the format (rejects a leading `v` and `+build`). It reads `package.json` and `git tag --list 'v*'` and requires the version to be strictly greater than all of them and its tag to be unused. It writes `prerelease=true|false` and `tag=vX.Y.Z` to `$GITHUB_OUTPUT` when that variable is set, and exits 1 with a message naming the latest version otherwise.
- `apply <version>` runs `npm version <v> --no-git-tag-version`, which updates both `package.json` and `package-lock.json` the way npm does. It then asserts that `git status --porcelain` shows only those two files.

### D6. Release pipeline: build on a bump that is never pushed, publish last

```
validate  (contents: read)
  - fail unless github.ref == refs/heads/master
  - release-version.mjs check $version            -> outputs tag, prerelease, source_sha = github.sha
      |
      +--> verify   : checkout source_sha, apply bump, npm run verify
      +--> e2e      : checkout source_sha, apply bump, xvfb-run npm run test:e2e
      +--> package  : checkout source_sha, apply bump, xvfb-run npm run test:packaging
      |                upload dist packages as artifact "release-packages"
      |                   |
      |                   +--> smoke      : download, scripts/smoke-linux.sh      (uploads logs)
      |                   +--> acceptance : download, scripts/acceptance-linux.sh (uploads steps.jsonl)
      v
publish  (needs all; contents: write, id-token: write, attestations: write)
  - checkout source_sha, apply bump, git add package.json package-lock.json, commit as github-actions[bot]
  - download release-packages + acceptance record; sha256sum -> SHA256SUMS
  - actions/attest-build-provenance on the packages
  - git tag -a vX.Y.Z; git push --atomic origin HEAD:refs/heads/master refs/tags/vX.Y.Z
  - gh release create vX.Y.Z --draft --generate-notes [--prerelease] --verify-tag  <packages> SHA256SUMS acceptance-linux-steps.jsonl
```

Why this order:
- **Nothing reaches the remote until the gate passes.** Every gate job applies the same bump to the same commit, so the packages they test carry the release version. Only `publish` writes anything.
- **`--atomic` push.** The commit and the tag land together or not at all.
- **A moved `master` stops the release.** If `master` moved during the run, the push is a non-fast-forward and fails, and the run must be restarted from the new `master`. That is the correct outcome: the released commit must be the one that was tested.
- **What ships is what was tested.** The packages are uploaded once, by `package`, and the same files are smoke-tested, acceptance-tested, attested and attached.
- **A failure after the push leaves nothing broken.** If attestation or `gh release create` fails after the push, rerunning just the failed `publish` job is safe for the release step. The tag already exists, so the job runs a `gh release view` check first and only creates the draft if it is missing; it skips the commit and push when the tag already points at a commit whose parent is `source_sha`.

The concurrency group `release` uses `cancel-in-progress: false`, so two releases never interleave.

Alternative considered: tag first, then build from the tag. Rejected. A failed build leaves a published tag that has to be deleted, and `master` would carry an untested version bump.

### D7. Pushing past branch protection

The `master` ruleset requires the `ci-ok` and `dependency-review` checks and pull requests for everyone, and lists GitHub Actions as a bypass actor (decided in exploration: option A). The bump commit is the only thing Actions ever pushes. `publish` is the only job with `contents: write`, and the policy test asserts that.

A bypass actor of type "GitHub Actions" for a user-owned repository is unconfirmed (see Risks). The fallback is a deploy key with bypass, stored as the secret `RELEASE_DEPLOY_KEY` and used only in `publish`. The workflow supports both: it pushes over SSH when the secret exists, and over `GITHUB_TOKEN` otherwise.

### D8. Caching and supply chain

- PR and `master` CI use the npm, Electron and electron-builder caches. GitHub scopes caches by branch, so a PR cannot poison `master`'s cache.
- The release runs with `cache: false`. It is slower, but everything comes fresh from lock-verified and checksum-verified sources.
- All `uses:` lines are pinned to a 40-hex SHA with a trailing `# vX.Y.Z` comment, which Dependabot keeps up to date.
- `persist-credentials: false` on every `actions/checkout` except in `publish`.

### D9. Nightly reporting through `gh`

A final `report` job runs with `if: failure()` and `issues: write` only. Using the preinstalled `gh` CLI, it finds an open issue labelled `nightly-failure` and comments with the run URL, or opens one if none is open. It never closes issues; the maintainer closes them after fixing the problem. No third-party action is needed.

### D10. Dependabot

`npm` and `github-actions` ecosystems, weekly. `cooldown: { default-days: 7 }` for npm, matching `min-release-age`. Grouped PRs: npm minor and patch updates in one group, major updates individually, all actions together. Each Dependabot PR goes through `ci-ok` like any other PR. `docs/dependencies.md`'s rule (verify `npm ci` and `npm audit` after a bump) is exactly what `ci-ok` checks.

### D11. How the specs are verified

Scenarios about the repository's own files are checked by `test/unit/workflow-policy.test.ts`. It reads `.github/**/*.yml` as text and asserts with line-level regular expressions, the way the other docs and policy tests assert on Markdown. This needs no YAML parser, so no new dependency. Scenarios about version logic are tested in `test/unit/release-version.test.ts`.

Some scenarios describe GitHub's runtime behavior (the dependency review verdict, the Dependabot cooldown, a draft that is not public). Their tests assert the configuration that produces the behavior. They are also exercised once for real by the rehearsal release (tasks group 6), and `docs/ci.md` records that rehearsal.

## Risks / Trade-offs

- **[A GitHub Actions bypass actor may not be offered for a personal repository's ruleset]** → Check this first when setting up the repository (task 1.1). If it is not offered, use the deploy-key fallback in D7. The workflow supports both.
- **[GitHub changes the runner's AppArmor default or the sysctl name]** → The E2E job checks after setup that `unshare --user true` succeeds and fails with a clear message otherwise, instead of letting the sandbox fail inside Playwright.
- **[Docker Hub rate limits or image drift break smoke and acceptance]** → In nightly runs this only produces a tracking issue. In a release it blocks, which is correct; rerun the release. Base image tags are the ones G-5 approved, unchanged.
- **[Acceptance is timing-sensitive: an ARP frame appeared in 3 of 17 early runs]** → The script already separates ARP from IP frames. If it flakes in CI, the release can rerun only the failed job. A flaky gate must not be weakened silently.
- **[npm 11.19.0 install itself is subject to `min-release-age`]** → It is pinned and older than seven days. The setup step asserts `npm --version`.
- **[The release takes 20–30 minutes, because the full gate runs again]** → Accepted. Releases are rare, and running the gate on the bumped tree is the guarantee.
- **[The workflow policy test uses regular expressions, not a parser]** → Keep the workflow style simple and consistent (block style, one `uses:` per line). The test fails on anything it cannot classify instead of passing it.
- **[Provenance requires a public repository (or GitHub Enterprise for private ones)]** → `docs/ci.md` states it. If the repository is private at release time, the attestation step fails loudly rather than being skipped.

## Migration Plan

1. Merge the workflows. Until the ruleset exists, nothing is required, so this PR's own `ci-ok` run serves as the first proof.
2. Create the `master` ruleset (D7) following `docs/ci.md`. The maintainer does this by hand; the steps are documented.
3. Rehearse with a prerelease, `0.1.0-rc.1`. Check the draft, verify the checksums and the attestation, then delete the draft (and the tag, if desired) or publish it.
4. Rollback: delete `.github/workflows/*` or disable a workflow in the Actions settings. Nothing in the app depends on CI.

## Open Questions

- The exact cron times (nightly at 03:00 UTC, CodeQL weekly on Monday) can be adjusted at any time without changing the specs or tasks.
