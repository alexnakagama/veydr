# Proposal

## Why

Veydr's quality bar is enforced only by commands run by hand on one machine (`npm run verify`, E2E, packaging tests, the Docker smoke and acceptance scripts), and no release has ever been published. Nothing stops a change that breaks the build from landing on `master`. Every package is built locally, so it can't be traced back to a commit. The first public release needs a repeatable pipeline that runs the same gates on every change and every release, with the evidence attached.

## What Changes

- Add GitHub Actions CI that runs on every pull request and every push to `master`: typecheck, lint, spec coverage, unit, integration, E2E (real sandboxed Electron under Xvfb), Linux packaging plus packaging tests, and workflow linting. A single aggregate check (`ci-ok`) is the one required status for branch protection.
- Add PR gates: dependency review (no newly introduced vulnerable dependencies) and a blocking production-dependency audit.
- Add security scanning: CodeQL for JavaScript/TypeScript on PRs, on `master`, and weekly.
- Add a nightly workflow (also manually runnable) for the slow checks: performance scenarios P1–P4, the distribution smoke matrix (`scripts/smoke-linux.sh`) and the packaged acceptance pass (`scripts/acceptance-linux.sh`). It reports failures through one tracking issue and never blocks merges.
- Add a manual build workflow that packages any ref into downloadable `.deb` and AppImage artifacts with checksums, without making a release.
- Add a manual release workflow. The maintainer enters a version, and the workflow:
  - validates the version;
  - bumps `package.json` and `package-lock.json`;
  - runs the full gate (verify, E2E, packaging, smoke, acceptance) on the bumped tree;
  - only after that passes, pushes the bump commit and the tag `vX.Y.Z`;
  - creates a **draft** GitHub Release with the packages, `SHA256SUMS`, a build provenance attestation, and that run's acceptance record.
- Add the release and versioning logic as small Node scripts with unit tests, plus a workflow policy test: actions pinned to commit SHAs, explicit least-privilege `permissions`, timeouts. This keeps the workflow files thin and the important behavior verifiable locally.
- Add Dependabot for npm and GitHub Actions, with a 7-day cooldown that matches `.npmrc` `min-release-age=7`.
- Add `CODEOWNERS`, a pull request template, `docs/ci.md` (pipeline, required checks, the one-time repository ruleset setup, how to cut a release) and README links.
- Not in this change: Windows/macOS builds, code signing (gate G-6), auto-update metadata (`publish: null` stays), coverage-percentage gates, self-hosted runners.

## Capabilities

### New Capabilities

- `quality-gates`: Which checks run automatically for pull requests, pushes, and on schedule. Which of them block a merge, and how failures are reported. Also the security posture of the workflows that run them.
- `release-automation`: How a version is chosen and validated, the gate a release must pass, which artifacts a release and a manual build produce, and the guarantee that a failed release leaves no tag or version commit behind.

### Modified Capabilities

None. The product's behavior does not change.

## Impact

- **New files**:
  - `.github/workflows/` (ci, security, nightly, build, release), `.github/dependabot.yml`, `.github/CODEOWNERS`, `.github/pull_request_template.md`;
  - `scripts/release-version.mjs`;
  - unit tests under `test/unit/`;
  - `docs/ci.md`.
- **Changed files**: `README.md` (CI badge, release links), possibly `package.json` scripts. No source code under `src/` changes.
- **Dependencies**: no new npm dependency. Third-party GitHub Actions are pinned to commit SHAs and listed in `docs/ci.md`. They come from GitHub (`actions/*`, `github/codeql-action`), plus `rhysd/actionlint` run as a pinned binary.
- **Repository settings** (manual, one time, documented): a `master` ruleset that requires `ci-ok` and allows GitHub Actions to bypass it, so the release bump commit can be pushed.
- **Runners**: GitHub-hosted `ubuntu-24.04`. Jobs that launch Electron re-enable unprivileged user namespaces with `sysctl`, because the runner's AppArmor restriction would otherwise break the Chromium sandbox Veydr requires.
