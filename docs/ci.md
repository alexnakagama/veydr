# CI and releases

Veydr's checks run on GitHub Actions, on GitHub-hosted `ubuntu-24.04` runners. The workflows call the same npm scripts you run locally (`npm run verify`, `npm run test:e2e`, `npm run test:packaging`, and so on) and never re-implement them, so a failure in CI can be reproduced with the same command. The requirements are in the OpenSpec change `add-github-actions` (`specs/quality-gates` and `specs/release-automation`), and the decisions in its `design.md`.

> [!NOTE]
> The pipeline is being added in stages. So far the shared runner setup (`.github/actions/setup`), the workflow policy test and `ci.yml` exist; the other workflows below are added by the later task groups of the change. Until the scenarios of the security, nightly, build and release workflows are tagged in tests (task groups 4 and 5), the spec coverage step of `ci.yml`'s `static` job fails, and so does `ci-ok`.

## Pipeline overview

| Workflow | Triggers | Purpose | Blocks |
|---|---|---|---|
| `ci.yml` | `pull_request` to `master`, `push` to `master`, `merge_group` | Quality gate: typecheck, lint, spec coverage, production audit, workflow lint, unit, integration, E2E, packaging | Merge, through the aggregate check `ci-ok` |
| `security.yml` | `pull_request`, `push` to `master`, weekly schedule | CodeQL analysis; dependency review (pull requests only) | Merge (dependency review is required; CodeQL alerts go to the Security tab) |
| `nightly.yml` | Daily schedule, manual run with a `ref` | Performance scenarios P1–P4, `scripts/smoke-linux.sh`, `scripts/acceptance-linux.sh` | Nothing; failures are reported in one tracking issue |
| `build.yml` | Manual run with a `ref` and a `smoke` option | Packages any ref into downloadable `.deb` and AppImage artifacts with `SHA256SUMS` | Nothing |
| `release.yml` | Manual run with a `version` | Validates the version, runs the full gate on the bumped tree, then pushes the bump commit and tag and creates a draft release | n/a |

Every job prepares the runner with the local composite action `.github/actions/setup`. It sets up Node from `.nvmrc`, installs npm 11.19.0 (the version [dependencies.md](dependencies.md) was verified with; the step fails if `npm --version` reports anything else), runs `npm ci`, and restores the npm, Electron and electron-builder caches, keyed on `package-lock.json`. Its inputs:

| Input | Default | Effect |
|---|---|---|
| `electron` | `"false"` | `"true"` installs Xvfb and enables unprivileged user namespaces (see below), for jobs that launch Electron |
| `cache` | `"true"` | `"false"` turns off every cache, so the release installs everything fresh from lock-verified sources |

Pass both inputs as quoted strings (`electron: "true"`), the spelling the policy test checks for. Restored Electron and electron-builder downloads are not re-verified against their checksums. That is acceptable for pull requests and `master`, because GitHub scopes caches by branch, so a pull request cannot poison `master`'s cache. It is also why the release runs with `cache: "false"`.

## CI

`.github/workflows/ci.yml` is the quality gate. It runs on every pull request to `master`, on every push to `master`, and for merge groups (so a merge queue can be turned on without editing the workflow). A pull request run checks the pull request's merge commit, the default checkout for `pull_request`. Every run executes the same jobs; nothing depends on the event that started it.

When a pull request gets a new push while its checks are still running, the older run is cancelled. Runs for pushes to `master` and merge groups are never cancelled or dropped: each gets a concurrency group of its own.

| Job | What it runs | Reproduce locally | Artifacts | Timeout |
|---|---|---|---|---|
| `static` | `npm run typecheck`, `npm run lint`, `npm run spec-coverage`, `npm audit --omit=dev --audit-level=low`, actionlint | The same commands; actionlint as shown below | None | 20 min |
| `unit` | `npm test` | `npm test` | None | 20 min |
| `integration` | `npm run test:integration` | `npm run test:integration` | None | 30 min |
| `e2e` | `xvfb-run --auto-servernum npm run test:e2e` | `npm run test:e2e` (with `xvfb-run --auto-servernum` in front on a machine without a display) | `e2e-test-results`: Playwright's `test-results/`, only when the job fails, kept 7 days | 45 min |
| `package` | `xvfb-run --auto-servernum npm run test:packaging` | `npm run test:packaging` | `linux-packages`: `dist/*.deb` and `dist/*.AppImage`, kept 7 days | 45 min |
| `ci-ok` | Checks the result of every job above | n/a | None | 5 min |

Notes on the jobs:

- **`static` runs every check, even after one fails.** Each step runs as long as the setup succeeded and the run was not cancelled, so one run reports every typecheck, lint, coverage, audit and workflow-lint problem at once. The job fails if any of them did.
- **The production audit blocks.** `--omit=dev` limits it to the dependencies that ship in the packages, and `--audit-level=low` fails on an advisory of any severity. A new advisory for a production dependency therefore fails the next run, even without a code change. Development dependencies are covered by dependency review on pull requests and by Dependabot. `npm audit` queries the npm registry, so the step also fails when the registry cannot be reached. The log tells the two apart: an advisory lists the affected package and severity, while a registry problem shows a network or HTTP error. For a registry error, rerun the failed job; for an advisory, update the dependency or follow [dependencies.md](dependencies.md).
- **actionlint** runs from the official `rhysd/actionlint` Docker image (1.7.12), pinned by digest, which also runs shellcheck on every `run:` script. To run the same check locally:

  ```bash
  docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667 -color
  ```

- **Electron jobs** (`integration`, `e2e`, `package`) run the setup action with `electron: "true"`, which installs Xvfb and enables unprivileged user namespaces (see [User namespaces on runners](#user-namespaces-on-runners)). On Ubuntu 24.04 or later, reproducing an E2E failure locally needs the same `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`; Debian 13 needs nothing.
- **Downloading artifacts.** Use the run's summary page, or `gh run download <run-id> --name linux-packages`.

### `ci-ok`, the aggregate check

`ci-ok` needs every other job and runs with `if: always()`, so it runs whatever happened to them. It succeeds only if every one of them reports `success`. A failed, cancelled or skipped job makes it fail, and its log lists which jobs did not succeed. A plain `needs:` would not do this: without `if: always()`, `ci-ok` would itself be skipped when a job it needs fails, and branch protection treats a skipped required check as passing. The aggregation is a short Node script, run with the Node that comes with the runner image, and `workflow-policy.test.ts` runs that exact script against sample results.

Because it runs whatever happened, `ci-ok` also runs in a pull request run that was cancelled by a newer push, and reports a failure for that older commit. This is expected and harmless: the newer commit's own run is the one branch protection looks at.

A new job must be added to `ci-ok`'s `needs:` list. The policy test fails if any job is missing from it. The policy test also pins the `if:` condition of every step in the check jobs, because a step whose condition is false is skipped while its job still succeeds, and `ci-ok` would then pass without that check.

### Required checks

The `master` ruleset requires exactly two checks:

- **`ci-ok`** from `ci.yml`;
- **`dependency-review`** from `security.yml`, which fails a pull request that adds a dependency with a known vulnerability of moderate or higher severity.

Only these two are required, so adding, removing or renaming a job in `ci.yml` never needs a change to the repository settings. The jobs behind `ci-ok` are not required individually.

## Repository settings

These answers were confirmed with the maintainer on 2026-10-25 (task 1.1 of the change):

- **Bypass for the release commit: GitHub Actions.** The `master` ruleset's bypass list offers **GitHub Actions** as a bypass actor for this repository, so the release workflow pushes its version-bump commit and tag with the workflow's `GITHUB_TOKEN` (design D7, option A). The deploy-key fallback (a deploy key with bypass, stored as the `RELEASE_DEPLOY_KEY` secret) is not needed. The release workflow still supports it, in case the bypass actor stops being available.
- **Visibility: public.** The repository is public (checked through the GitHub API on 2026-10-25), so build provenance attestations can be created for release packages. GitHub supports them only for public repositories, or private ones on GitHub Enterprise Cloud. If the repository becomes private, the release's attestation step fails instead of being skipped.

## Workflow security rules

`test/unit/workflow-policy.test.ts` checks every file under `.github/` as part of `npm test`:

- **No default permissions.** Every workflow declares `permissions: {}` at the top level and grants scopes per job. `read-all` and `write-all` are not allowed anywhere; each job lists the scopes it needs.
- **Write scopes only where needed.** A job may hold a `write` scope only if the test's `writeScopes` list names it:
  - `contents`, `id-token` and `attestations` for `release.yml`'s `publish` job;
  - `issues` for `nightly.yml`'s `report` job;
  - `security-events` for `security.yml`'s `codeql` job.
- **No repository secrets in checks.** The only expressions that read secrets are `secrets.GITHUB_TOKEN`, everywhere, and `secrets.RELEASE_DEPLOY_KEY`, only in `release.yml`. `secrets: inherit` is not allowed.
- **No expressions in scripts.** `${{ … }}` never appears inside a `run:` script, because the runner substitutes it before the shell parses the script, so a dispatch input such as `version` or `ref` could inject commands. Pass values through `env:` and use `"$NAME"` in the script.
- **Every job has a `timeout-minutes`** between 1 and 120.
- **Pinned actions.** Every `uses:` that is not a local action (`./…`) is pinned to a full 40-character commit SHA, followed by the version as a comment (`# v7.1.0`). The test checks only the comment's shape, not that it matches the SHA. Dependabot updates both together. A Docker image is pinned by its `sha256` digest.
- **No `pull_request_target` or `workflow_run`.** Both run with a write token and the repository's secrets on behalf of code from a pull request.
- **The sandbox and the offline test are never weakened.** These must not appear anywhere under `.github/`:
  - `--no-sandbox`, `--disable-setuid-sandbox`, `--disable-gpu-sandbox` and `--disable-seccomp-filter-sandbox`;
  - `ELECTRON_DISABLE_SANDBOX` and `chromiumSandbox: false`;
  - `VEYDR_ALLOW_SKIP_OFFLINE`.

  A job that launches Electron must first run the setup action with `electron: "true"`. Launching means running `xvfb-run` or `Xvfb`, Playwright, or `npm run test:integration`, `test:e2e`, `test:perf` or `test:packaging`.
- **No stored credentials.** Every `actions/checkout` sets `persist-credentials: false`, except in the release workflow's `publish` job, which pushes the release commit.

The forbidden strings are matched as plain text in every file under `.github/`, comments and Markdown included, so even a note that names them fails the test.

The test reads the files as text with line-level patterns, so no YAML parser is needed. That only works with a narrow style: block style, two-space indentation, one key per line, no anchors, and no flow collections other than `{}` and `[]`. This applies to every YAML file, including `.github/dependabot.yml`. Write `cooldown:` with `default-days: 7` on the next line, not `cooldown: { default-days: 7 }`, and write `patterns:` with `- "*"` on the next line, not `patterns: ["*"]`. The test fails on any line it cannot classify, so a construct it does not understand is rejected, not let through.

## User namespaces on runners

Chromium's sandbox needs unprivileged user namespaces, and `test/e2e/offline.spec.ts` needs a user and network namespace (`unshare --user --map-root-user --net`) to prove Veydr works offline. GitHub's `ubuntu-24.04` image sets `kernel.apparmor_restrict_unprivileged_userns=1`, which blocks both.

With `electron: "true"`, the setup action runs `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` before any test. This puts the runner in the state the app was verified in (Debian 13, namespaces allowed), so the sandbox and the offline test run for real. The step then checks `unshare --user true` and `unshare --user --map-root-user --net true`, and fails with a clear error if either does not work, rather than letting the sandbox fail later inside Playwright.

The alternatives were rejected: setting `VEYDR_ALLOW_SKIP_OFFLINE` would hide exactly what the offline test exists for, and installing Veydr's AppArmor profile on the runner covers only the packaged binary, not `node_modules/electron`. The packaged app under Ubuntu 24.04's restriction remains a manual check (see the README's platform notes); CI does not claim to cover it.
