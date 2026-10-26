# CI and releases

Veydr's checks run on GitHub Actions, on GitHub-hosted `ubuntu-24.04` runners. The workflows call the same npm scripts you run locally (`npm run verify`, `npm run test:e2e`, `npm run test:packaging`, and so on) and never re-implement them, so a failure in CI can be reproduced with the same command. The requirements are in the OpenSpec change `add-github-actions` (`specs/quality-gates` and `specs/release-automation`), and the decisions in its `design.md`.

> [!NOTE]
> The pipeline is being added in stages. So far the shared runner setup (`.github/actions/setup`), the workflow policy test, `ci.yml`, `security.yml`, `nightly.yml`, `build.yml` and Dependabot exist; `release.yml` is added by the last task group of the change. Until the release scenarios are tagged in tests (task group 5), the spec coverage step of `ci.yml`'s `static` job fails, and so does `ci-ok`.

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

## Security

`.github/workflows/security.yml` has two jobs.

| Job | Runs on | What it does | Blocks | Timeout |
|---|---|---|---|---|
| `codeql` | Every pull request, every push to `master`, every merge group, and Mondays at 04:00 UTC | CodeQL analysis of the JavaScript and TypeScript sources (`build-mode: none`, so nothing is installed or built) | Nothing directly; alerts appear in the repository's **Security → Code scanning** tab | 30 min |
| `dependency-review` | Pull requests only (skipped on pushes, merge groups and the schedule) | Compares the dependency graph of the pull request's base and head, and fails if the pull request adds a package with a known vulnerability of **moderate** or higher severity | Merge: it is one of the two [required checks](#required-checks) | 10 min |

Notes:

- **The weekly CodeQL run** analyses `master` (GitHub runs scheduled workflows on the default branch) even when nothing was pushed, so new queries in a CodeQL release and newly published advisories still reach the Security tab.
- **Dependency review covers every scope.** The action's default fails only for runtime dependencies. Development dependencies run in CI and on developers' machines too, so the workflow sets `fail-on-scopes: runtime, development, unknown`. No advisory is exempt, and the verdict is never turned into a warning.
- **Merge groups.** The workflow also runs for merge groups, so a merge queue can be turned on without editing it: `dependency-review` is skipped there, which counts as passing for a required check, because it already ran on the pull request.
- **`codeql` is the only job in any workflow with `security-events: write`**, which it needs to upload its results. Pull requests opened by Dependabot get a read-only token by default, but a workflow's `permissions:` key still applies to them, so `codeql` can upload there too. If CodeQL fails on a Dependabot pull request with "Resource not accessible by integration", that assumption no longer holds; `codeql` is not a required check, so it does not block the merge. `dependency-review` reads the dependency graph through the API with `contents: read` and needs no checkout.
- **A failing dependency review.** The job summary names the package, the advisory and the first patched version. Pick a patched version (the [dependencies.md](dependencies.md) rules apply), or drop the dependency. If an advisory does not apply to how Veydr uses the package, record why in the pull request and ask the maintainer. The workflow has no allow-list, on purpose.
- **To act on a CodeQL alert**, open it in the Security tab, fix the code in a pull request, and the alert closes once the analysis of `master` no longer finds it. A false positive is dismissed in the Security tab with a reason, never by editing the workflow.

## Dependabot

`.github/dependabot.yml` opens update pull requests every Monday:

| Ecosystem | Where | Grouping | Cooldown |
|---|---|---|---|
| npm | `package.json` and `package-lock.json` | Minor and patch updates together in one pull request (`npm-minor-and-patch`); each major update on its own | 7 days |
| GitHub Actions | The workflows and the local composite actions under `.github/actions/` | All actions in one pull request | 7 days |

- **The npm cooldown matches `.npmrc`.** `min-release-age=7` makes `npm ci` refuse any version published less than seven days ago, so Dependabot waits the same seven days before proposing one. A pull request it opens therefore always installs. The policy test reads both files and fails if the numbers differ.
- **Actions wait a week too.** A just-published action release is not proposed before it has been public for a week, which gives a compromised or broken release time to be noticed. Dependabot updates the pinned SHA and its `# vX.Y.Z` comment together.
- **Security updates are not delayed.** The cooldown applies to version updates only. Dependabot security updates (enabled in the repository's **Settings → Code security**) are opened as soon as an advisory exists.
- **Every Dependabot pull request goes through `ci-ok` and dependency review** like any other. That is exactly the check [dependencies.md](dependencies.md) asks for after a bump (`npm ci` and `npm audit`). Review the changelog of a major update before merging.
- After the file reaches `master`, **Insights → Dependency graph → Dependabot** shows its status; a configuration error appears there.

## Nightly

`.github/workflows/nightly.yml` runs the checks that are too slow for every pull request. It never blocks a merge: it is not triggered by pull requests or pushes, so none of its jobs can be a required check.

It runs every day at 03:00 UTC on `master`, and on demand: **Actions → Nightly → Run workflow**, optionally with a `ref` (a branch, tag or commit; empty means the branch the run is started on). From the command line:

```bash
gh workflow run nightly.yml --ref master -f ref=my-branch
```

| Job | What it runs | Artifacts (kept 14 days) | Timeout |
|---|---|---|---|
| `perf` | `xvfb-run --auto-servernum npm run test:perf`: performance scenarios P1–P4 | `perf-test-results` (Playwright's `test-results/`), only when it fails | 60 min |
| `smoke` | `npm run dist:linux`, then `scripts/smoke-linux.sh`: the distribution smoke matrix | `smoke-linux` (`test-results/smoke-linux/`: a log per image and mode, and `summary.txt`), unless the run was cancelled | 90 min |
| `acceptance` | `npm run dist:linux`, then `scripts/acceptance-linux.sh`: the packaged acceptance pass in `debian:13` | `acceptance-linux` (`test-results/acceptance-linux/`: `steps.jsonl`, the driver log, the packet capture), unless the run was cancelled | 60 min |
| `report` | Only when one of the jobs above failed: reports the failure (see below) | None | 5 min |

`smoke` and `acceptance` run the setup action with `electron: "true"`. Their containers start the packages with unprivileged user namespaces allowed, and the runner's AppArmor restriction (see [User namespaces on runners](#user-namespaces-on-runners)) also blocks them inside Docker. `acceptance-linux.sh` uses the runner's Node.js and the repository's Playwright, mounted read-only into the container. Both scripts pull their base images from Docker Hub, so a rate limit or an outage shows up as a failed nightly run.

### How failures are reported

The `report` job has `issues: write` and nothing else. With the runner's `gh` CLI, it:

1. creates the `nightly-failure` label if it does not exist;
2. looks for an open issue with that label;
3. comments on it with the run link, the event, the ref that was checked and the jobs that did not succeed, or, if no such issue is open, opens one ("Nightly checks are failing") with the same text.

So there is at most one open tracking issue, whatever the number of failing nights. `report` never closes it. The job has a concurrency group of its own, so reports from two runs that fail at the same time run one after the other, and the second comments on the issue the first opened. A manual run that fails is reported the same way, with the ref it was asked to check.

### Triaging a nightly failure

1. Open the run linked in the latest comment of the `nightly-failure` issue, and see which jobs failed.
2. Download the artifacts of the failed job (`gh run download <run-id> --name smoke-linux`, `acceptance-linux` or `perf-test-results`).
   - **`smoke`**: `summary.txt` lists every check of every image and mode with its result; the per-image logs show why a check failed.
   - **`acceptance`**: `driver.log` shows the failing step, and `sent.txt` lists any IP frame the container sent during the run, which must be empty.
   - **`perf`**: the job log shows which scenario exceeded its limit.
3. Decide whether the cause is infrastructure or Veydr:
   - **Infrastructure** (Docker Hub rate limit, a mirror outage, a runner image change): rerun the failed jobs. If it passes, comment on the issue and close it.
   - **Veydr**: reproduce it locally with the same script (`npm run test:perf`, or `npm run dist:linux` followed by `scripts/smoke-linux.sh` or `scripts/acceptance-linux.sh`), fix it in a pull request, and reference the issue. After the next nightly run passes, close the issue.
4. A timing-sensitive check that flakes is fixed or documented, never weakened silently (design Risks: the acceptance pass's ARP handling).

Close the issue only once a nightly run passes, so that the next failure opens a fresh issue instead of adding to a stale one.

GitHub disables a scheduled workflow after 60 days without activity in the repository, and says so on the **Actions → Nightly** page. If nightly runs stop appearing, re-enable it there. Scheduled workflows are also disabled in forks by default, so a fork does not open issues of its own unless its owner enables them.

## Manual builds

`.github/workflows/build.yml` packages any branch, tag or commit without making a release: **Actions → Build → Run workflow**, with:

| Input | Default | Meaning |
|---|---|---|
| `ref` | empty | Branch, tag or commit to build; empty means the branch the run is started on |
| `smoke` | `false` | Also run the distribution smoke matrix on the built packages |

```bash
gh workflow run build.yml --ref master -f ref=my-branch -f smoke=true
```

| Job | What it runs | Artifacts (kept 14 days) | Timeout |
|---|---|---|---|
| `package` | `xvfb-run --auto-servernum npm run test:packaging`, then writes `SHA256SUMS` for the `.deb` and the AppImage and checks it | `linux-packages`: the `.deb`, the AppImage and `SHA256SUMS` | 45 min |
| `smoke` | Only with `smoke: true`: checks out the commit `package` built (not the ref again, which may have moved), downloads `linux-packages`, checks it against `SHA256SUMS`, then runs `scripts/smoke-linux.sh` on those same files | `smoke-linux`: `test-results/smoke-linux/`, whether it passes or fails, unless the run was cancelled | 90 min |

The packages carry the version that is in `package.json` at that ref; a manual build never bumps it. Both jobs have `contents: read` and nothing else, and the workflow contains no push, tag, commit or release step, so the repository's branches, tags and releases are unchanged after any run. The policy test checks both. The `package` job fails unless `dist/` holds exactly one `.deb` and one AppImage.

To download and check a build:

```bash
gh run download <run-id> --name linux-packages --dir veydr-build
```

```bash
cd veydr-build && sha256sum -c SHA256SUMS
```

Manual builds are for testing a branch on a real machine. They are not releases: they have no provenance attestation and are deleted after 14 days.

## Code owners

`.github/CODEOWNERS` makes the maintainer (`@alexnakagama`) the owner of everything, and names them again explicitly for `.github/` (the workflows, the setup action, Dependabot and these files) and for `scripts/release-version.mjs` (the release version logic). The explicit entries come last, so they still apply if a broader owner is added for `*` later. With **Require review from Code Owners** turned on in the `master` ruleset, a change to the pipeline cannot be merged without the maintainer's review.

## Pull request template

`.github/pull_request_template.md` pre-fills every pull request with a short description and three checks:

- `npm run verify` passed locally;
- every new or changed spec scenario is tagged in a test (`[spec:<capability>/<scenario>]`);
- the documentation is updated, or nothing user-facing changed.

`ci-ok` checks the first two again; the third is for the reviewer.

## Actions in use

Every third-party action is pinned to a commit SHA, with its version as a comment (see [Workflow security rules](#workflow-security-rules)). Dependabot proposes updates once a release is a week old. When you add or bump a pin by hand, apply the same delay: `github/codeql-action` is at v4.39.0 rather than the newer v4.39.1 for this reason.

| Action or image | Version | Used in |
|---|---|---|
| `actions/checkout` | v7.0.1 | Every workflow |
| `actions/setup-node` | v7.1.0 | `.github/actions/setup` |
| `actions/cache` | v6.1.0 | `.github/actions/setup` |
| `actions/upload-artifact` | v7.0.2 | `ci.yml`, `nightly.yml`, `build.yml` |
| `actions/download-artifact` | v8.0.2 | `build.yml` |
| `actions/dependency-review-action` | v5.0.0 | `security.yml` |
| `github/codeql-action` (`init`, `analyze`) | v4.39.0 | `security.yml` |
| `rhysd/actionlint` Docker image | 1.7.12, pinned by digest | `ci.yml` |

## Run records

Workflow runs that verify this pipeline on GitHub. They need the workflows on GitHub, so they are recorded after the change's pull request is opened.

| What | Run | Outcome |
|---|---|---|
| `security.yml` on the change's pull request: `codeql` and `dependency-review` both run (task 4.1) | Not yet run | — |
| Dependabot configuration accepted, no errors in the Dependabot tab after merge (task 4.2) | Not yet checked | — |
| Manual `nightly.yml` dispatch completes (task 4.3) | Not yet run | — |
| Manual `build.yml` dispatch on `master`; `sha256sum -c SHA256SUMS` succeeds on the downloaded packages (task 4.4) | Not yet run | — |

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
