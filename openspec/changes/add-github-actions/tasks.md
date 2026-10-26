# Tasks

Note: `npm run spec-coverage` runs in required mode and also reads this change's specs. It fails until every scenario in `specs/quality-gates` and `specs/release-automation` has a `[spec:…]` tag in a test. Each group tags the scenarios it implements, and `npm run verify` is expected to be fully green only from the end of group 5 on.

## 1. Foundations

- [x] 1.1 Confirm with the maintainer which bypass mechanism the `master` ruleset supports for this repository (GitHub Actions as a bypass actor, or the deploy-key fallback of design D7), and whether the repository is public (needed for provenance). Record both answers in `docs/ci.md`. Verify: the answers are written there.
- [x] 1.2 Add the composite action `.github/actions/setup/action.yml` (design D2), with inputs `electron` and `cache`. It sets up Node from `.nvmrc`, installs npm 11.19.0 and asserts `npm --version`, runs `npm ci`, and adds the npm, Electron and electron-builder caches. With `electron: true` it installs `xvfb`, runs the user-namespace `sysctl` (D3), then checks `unshare --user true` and fails with a clear message if it does not work. Verify: `actionlint` (Docker image, pinned digest) reports no errors locally.
- [x] 1.3 Add `test/unit/workflow-policy.test.ts` (design D11). It reads every file under `.github/` as text and asserts:
  - a top-level `permissions:` in every workflow;
  - `timeout-minutes` in every job;
  - every non-local `uses:` pinned to a 40-hex SHA;
  - no `pull_request_target`;
  - no `--no-sandbox` and no `VEYDR_ALLOW_SKIP_OFFLINE`;
  - `persist-credentials: false` on checkouts outside the release `publish` job.

  The test fails on lines it cannot classify. Tag `quality-gates/unpinned-action-is-rejected`, `missing-permissions-or-timeout-is-rejected`, `no-privileged-pull-request-trigger` and `sandbox-and-offline-test-are-not-weakened`. Verify: `npm test` passes. A temporary fixture with an unpinned `uses:` makes it fail (checked once, then removed).
- [x] 1.4 Start `docs/ci.md` with an overview of the pipeline (the D1 table), the workflow security rules from 1.3, and why user namespaces are enabled on runners. Link it from README's documentation table. Verify: `npm test` passes, including `readme-docs.test.ts`.

## 2. Release version logic

- [x] 2.1 Implement `scripts/release-version.mjs` (design D5). Exported pure functions: `parseVersion`, `compareVersions` (SemVer 2.0 precedence, including prerelease identifiers), and `checkVersion({ requested, current, tags })`. CLI subcommands `check <v>` (writes `tag` and `prerelease` to `$GITHUB_OUTPUT` when that variable is set) and `apply <v>` (`npm version --no-git-tag-version`, then asserts that only `package.json` and `package-lock.json` changed). Verify: `npm run lint` and `npm run typecheck` pass.
- [x] 2.2 Add `test/unit/release-version.test.ts`, covering:
  - malformed versions (`1.2`, `v1.2.3`, `1.2.3+build.5`);
  - versions not greater than the latest tag or `package.json`;
  - an existing tag;
  - prerelease detection;
  - `0.3.0` accepted after `v0.3.0-rc.1`;
  - precedence edge cases (`1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-beta < 1.0.0-rc.1 < 1.0.0`, numeric versus alphanumeric identifiers).

  Tag the `release-automation` scenarios `malformed-version`, `version-not-greater-than-the-latest`, `prerelease-version` and `prerelease-ordering`. Verify: `npm test` passes.
- [x] 2.3 Add an `apply` test that runs the CLI in a temporary copy holding only `package.json` and `package-lock.json`, and asserts both files carry the new version and nothing else changed. Verify: `npm test` passes.

## 3. CI workflow (pull requests and master)

- [x] 3.1 Add `.github/workflows/ci.yml` (design D4), with these jobs:
  - `static`: typecheck, lint, spec-coverage, `npm audit --omit=dev --audit-level=low`, actionlint;
  - `unit`;
  - `integration`;
  - `e2e`: `xvfb-run`; uploads `test-results/` on failure;
  - `package`: `xvfb-run npm run test:packaging`; uploads packages with 7-day retention;
  - `ci-ok`: `if: always()`, checks every `needs.*.result`.

  Triggers are `pull_request` and `push` on `master` plus `merge_group`. Concurrency cancels superseded PR runs. Verify: actionlint passes, and the workflow runs green on this change's pull request.

  Status: actionlint passes locally. The green run on this change's pull request is deferred: until groups 4 and 5 tag their scenarios, `spec-coverage` (and so `static` and `ci-ok`) fails by design (see the note at the top). It is checked together with 3.3, after group 5.
- [x] 3.2 Extend `workflow-policy.test.ts` for `ci.yml`:
  - the triggers;
  - the job set contains every check named in the spec;
  - `ci-ok` uses `if: always()` and fails on any non-`success` result;
  - the concurrency group with `cancel-in-progress` for pull requests;
  - the production audit step.

  Tag the `quality-gates` scenarios `pull-request-runs-the-full-check-set`, `push-to-master-runs-the-same-checks`, `superseded-pull-request-runs-are-cancelled`, `all-checks-pass`, `one-check-fails-or-is-skipped` and `production-dependency-becomes-vulnerable`. Verify: `npm test` passes.
- [ ] 3.3 Prove `ci-ok` behaves as specified. On a throwaway pull request, a deliberately failing unit test makes `ci-ok` fail; reverting it makes `ci-ok` succeed. Record the two run links in `docs/ci.md`. Verify: both links are recorded.
- [x] 3.4 Document the CI section in `docs/ci.md`: the jobs, what each runs, its artifacts, how to reproduce a CI failure locally with the same npm script, and the required checks (`ci-ok`, `dependency-review`). Add the CI status badge to README. Verify: `npm test` passes.

## 4. Security, dependency updates, scheduled and manual builds

- [x] 4.1 Add `.github/workflows/security.yml`: CodeQL (javascript-typescript) on `pull_request`, on `push` to `master`, and on a weekly cron, with `security-events: write` only in that job; and `dependency-review` on pull requests with `fail-on-severity: moderate`. Extend the policy test and tag `quality-gates/weekly-analysis-without-code-changes` and `pull-request-adds-a-vulnerable-dependency`. Verify: `npm test` passes, and both jobs run on the pull request.

  Status: `npm test` and actionlint pass locally. Both jobs running on the pull request is checked once the change's pull request is opened, and recorded in `docs/ci.md` (Run records).
- [x] 4.2 Add `.github/dependabot.yml` (design D10): npm weekly with `cooldown.default-days: 7` and grouped minor and patch updates; github-actions weekly, grouped. Extend the policy test and tag `quality-gates/freshly-published-version-is-not-proposed`. Verify: `npm test` passes, and the Dependabot tab shows no config errors after merge.

  Status: `npm test` passes. The Dependabot tab can only be checked after merge; it is listed in `docs/ci.md` (Run records).
- [x] 4.3 Add `.github/workflows/nightly.yml`: daily cron plus `workflow_dispatch` with a `ref` input. Jobs:
  - `perf`: `xvfb-run npm run test:perf`;
  - `smoke`: build the packages, then `scripts/smoke-linux.sh`, uploading `test-results/smoke-linux/`;
  - `acceptance`: `scripts/acceptance-linux.sh`, uploading `test-results/acceptance-linux/`;
  - `report`: `if: failure()`, `issues: write`; finds or creates the `nightly-failure` issue with `gh` and comments with the run link (design D9).

  Extend the policy test and tag `quality-gates/nightly-failure-is-reported-once` and `nightly-run-on-demand`. Verify: `npm test` passes, and one manual dispatch completes, with its outcome recorded in `docs/ci.md`.

  Status: `npm test` and actionlint pass locally. A dispatch needs the workflow on GitHub; it is run once the change's pull request is open, and recorded in `docs/ci.md` (Run records).
- [x] 4.4 Add `.github/workflows/build.yml`: `workflow_dispatch` with `ref` and `smoke` (boolean). It builds the packages with `test:packaging`, writes `SHA256SUMS`, and uploads them with 14-day retention; with `smoke: true` it runs `scripts/smoke-linux.sh`. It has `contents: read` only and no push, tag or release steps. Extend the policy test (read-only permissions, no `git push`, no `gh release`) and tag `release-automation/building-a-branch` and `optional-smoke-matrix-on-a-manual-build`. Verify: `npm test` passes, and a manual dispatch on `master` produces downloadable packages whose `sha256sum -c SHA256SUMS` succeeds.

  Status: `npm test` and actionlint pass locally; the policy test runs the `SHA256SUMS` step on sample files. The dispatch on `master` needs the workflow merged; it is recorded in `docs/ci.md` (Run records).
- [x] 4.5 Add `.github/CODEOWNERS` (the maintainer for `*`; `.github/` and `scripts/release-version.mjs` explicitly) and `.github/pull_request_template.md`, with a checklist: `npm run verify` passed, spec scenarios tagged, docs updated. Document security, Dependabot, nightly and manual builds in `docs/ci.md`, including how to triage a `nightly-failure` issue. Verify: `npm test` passes.

## 5. Release workflow

- [x] 5.1 Add `.github/workflows/release.yml` (design D6), with concurrency group `release` and no cancellation. Jobs:
  - `validate`: refuses any ref but `master`; checks out with the tags fetched (`fetch-depth: 0` or `fetch-tags: true`), because `check` reads `git tag --list 'v*'` and the default shallow, tagless checkout would let an existing or lower version through until the final push; runs `release-version.mjs check`; outputs `tag`, `prerelease` and `source_sha`;
  - `verify`, `e2e` and `package`: each checks out `source_sha`, runs `release-version.mjs apply`, and uses setup with `cache: false`; `package` uploads `release-packages`;
  - `smoke` and `acceptance`: test the downloaded packages;
  - `publish`: commit as github-actions[bot] staging only the two files, write `SHA256SUMS`, `attest-build-provenance`, annotated tag, `git push --atomic` of the commit and tag, then `gh release create --draft --generate-notes --verify-tag [--prerelease]` with the packages, `SHA256SUMS` and the acceptance `steps.jsonl`.

  Pass the `version` input to `run:` steps through `env:` (for example `VERSION: ${{ inputs.version }}`, then `"$VERSION"` in the script), never as `${{ inputs.version }}` inside `run:`. Interpolation happens before `release-version.mjs` can validate the value.

  Verify: actionlint passes.
- [x] 5.2 Make `publish` safe to rerun (design D6). If the tag already exists and its commit's parent is `source_sha`, skip the commit and push. If the draft release already exists, skip creating it. Support the deploy-key fallback: push over SSH when `RELEASE_DEPLOY_KEY` is set (design D7). Verify: actionlint passes; the logic is reviewed against D6.
- [x] 5.3 Extend `workflow-policy.test.ts` for `release.yml`, asserting:
  - `workflow_dispatch` is the only trigger, with a required `version` input;
  - the ref guard;
  - every gate job applies the bump and that `publish` needs all of them;
  - `contents: write`, `id-token: write` and `attestations: write` appear only on `publish`;
  - `--atomic`, `--draft`, `--verify-tag` and `SHA256SUMS`;
  - the acceptance record and the attestation step.

  Tag the `release-automation` scenarios `release-started-from-master`, `release-started-from-another-branch`, `gate-fails`, `gate-passes`, `packages-carry-the-release-version`, `draft-created`, `checksums-match` and `verifying-a-release-package`. Verify: `npm test` passes and `npm run spec-coverage` reports 0 unmapped scenarios.
- [x] 5.4 Document releasing in `docs/ci.md`:
  - the one-time `master` ruleset setup: required checks `ci-ok` and `dependency-review`, the bypass actor or deploy key from 1.1;
  - how to cut a release and choose a version;
  - what to check in the draft before publishing;
  - how users verify checksums and the attestation (`gh attestation verify`);
  - how to recover from a failed release.

  Update the README Installation section to point to GitHub Releases and its verification steps. Replace the hard-coded `0.0.0` package names with `X.Y.Z`, so a version bump never leaves README stale. Verify: `npm test` passes, including the README and install docs tests.

## 6. End-to-end verification

- [ ] 6.1 Run `npm run verify` locally and confirm every stage passes, including spec-coverage with this change's scenarios. Verify: the summary prints "all stages passed".
- [ ] 6.2 With the maintainer's explicit go-ahead (it pushes a commit and a tag), create the `master` ruleset by following `docs/ci.md`. Then run the release workflow with `0.1.0-rc.1`, and confirm:
  - the bump commit and the tag landed together;
  - a draft prerelease exists with both packages, `SHA256SUMS` and the acceptance record;
  - `sha256sum -c SHA256SUMS` and `gh attestation verify` succeed on the downloaded files.

  Record the run link and the outcome in `docs/ci.md`. Verify: the record exists.
- [ ] 6.3 Rerun the release with the same version `0.1.0-rc.1`, and confirm that validation refuses it because the tag exists. Then rehearse a failing gate (for example, run it from a branch). Confirm that no tag, commit or release appears. Verify: run links are recorded in `docs/ci.md`.

## Workflow follow-up

- After 6.2, the maintainer decides whether to publish or delete the `0.1.0-rc.1` draft.
- Archive this change with `/opsx:archive` once review is complete; archiving moves `quality-gates` and `release-automation` into `openspec/specs/`.
