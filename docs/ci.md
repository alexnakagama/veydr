# CI and releases

Veydr's checks run on GitHub Actions, on GitHub-hosted `ubuntu-24.04` runners; one job, `windows`, runs on `windows-2025`, as do the manual [Windows probes](#windows-probes). The workflows call the same npm scripts you run locally (`npm run verify`, `npm run test:e2e`, `npm run test:packaging`, and so on) and never re-implement them, so a failure in CI can be reproduced with the same command. The requirements are in `openspec/specs/quality-gates` and `openspec/specs/release-automation`, and the decisions in the `design.md` of the archived OpenSpec change `openspec/changes/archive/2026-10-26-add-github-actions`.

## Pipeline overview

| Workflow | Triggers | Purpose | Blocks |
|---|---|---|---|
| `ci.yml` | `pull_request` to `master`, `push` to `master`, `merge_group` | Quality gate: typecheck, lint, spec coverage, production audit, workflow lint, unit, integration, E2E, packaging; typecheck, lint, and unit tests also on Windows | Merge, through the aggregate check `ci-ok` |
| `security.yml` | `pull_request`, `push` to `master`, weekly schedule | CodeQL analysis; dependency review (pull requests only) | Merge (dependency review is required; CodeQL alerts go to the Security tab) |
| `nightly.yml` | Daily schedule, manual run with a `ref` | Performance scenarios P1–P4, `scripts/smoke-linux.sh`, `scripts/acceptance-linux.sh` | Nothing; failures are reported in one tracking issue |
| `build.yml` | Manual run with a `ref` and a `smoke` option | Packages any ref into downloadable `.deb` and AppImage artifacts with `SHA256SUMS` | Nothing |
| `release.yml` | Manual run with a `version` | Validates the version, runs the full gate on the bumped tree, then pushes the bump commit and tag and creates a draft release | n/a |
| `windows-probe.yml` | Manual run with a `negative-control` option | Probes how Windows behaves on the `windows-2025` runner and records the answers as evidence for the Windows platform work; Windows stays unsupported | Nothing; never a required check |

Every job prepares the runner with the local composite action `.github/actions/setup`. It sets up Node from `.nvmrc`, installs npm 11.19.0 (the version [dependencies.md](dependencies.md) was verified with; the step fails if `npm --version` reports anything else), runs `npm ci`, and restores the npm, Electron and electron-builder caches, keyed on `package-lock.json`. On Windows the Electron and electron-builder cache is left out: no Windows job downloads Electron. Its inputs:

| Input | Default | Effect |
|---|---|---|
| `electron` | `"false"` | `"true"` installs Xvfb, enables unprivileged user namespaces and turns off core dumps (see below), for jobs that launch Electron. These steps run on Linux only: on Windows, `"true"` installs just the dependencies, and a job that launches the built app downloads Electron with `node scripts/ensure-electron.cjs` |
| `cache` | `"true"` | `"false"` turns off every cache, so the release installs everything fresh from lock-verified sources |
| `dependencies` | `"true"` | `"false"` skips `npm ci` (and the Electron cache), for a job that needs only Node and npm. The release's `validate` and `publish` jobs use it; `publish` holds a write token, and no dependency's install script should run next to it. It cannot be combined with `electron: "true"` |

Pass the inputs as quoted strings (`electron: "true"`), the spelling the policy test checks for. Restored Electron and electron-builder downloads are not re-verified against their checksums. That is acceptable for pull requests and `master`, because GitHub scopes caches by branch, so a pull request cannot poison `master`'s cache. It is also why the release runs with `cache: "false"`.

## CI

`.github/workflows/ci.yml` is the quality gate. It runs on every pull request to `master`, on every push to `master`, and for merge groups (so a merge queue can be turned on without editing the workflow). A pull request run checks the pull request's merge commit, the default checkout for `pull_request`. Every run executes the same jobs; nothing depends on the event that started it.

When a pull request gets a new push while its checks are still running, the older run is cancelled. Runs for pushes to `master` and merge groups are never cancelled or dropped: each gets a concurrency group of its own.

| Job | What it runs | Reproduce locally | Artifacts | Timeout |
|---|---|---|---|---|
| `static` | `npm run typecheck`, `npm run lint`, `npm run spec-coverage`, `npm audit --omit=dev --audit-level=low`, actionlint | The same commands; actionlint as shown below | None | 20 min |
| `unit` | `npm test` | `npm test` | None | 20 min |
| `integration` | `xvfb-run --auto-servernum npm run test:integration` | `npm run test:integration` (with `xvfb-run --auto-servernum` in front on a machine without a display) | None | 30 min |
| `e2e` | `xvfb-run --auto-servernum npm run test:e2e` | `npm run test:e2e` (with `xvfb-run --auto-servernum` in front on a machine without a display) | `e2e-test-results`: Playwright's `test-results/`, only when the job fails, kept 7 days | 45 min |
| `package` | `xvfb-run --auto-servernum npm run test:packaging` | `npm run test:packaging` | `linux-packages`: `dist/*.deb` and `dist/*.AppImage`, kept 7 days | 45 min |
| `windows` | On `windows-2025`: `npm run typecheck`, `npm run lint`, `npm test` | The same commands on Windows | None | 30 min |
| `ci-ok` | Checks the result of every job above | n/a | None | 5 min |

Notes on the jobs:

- **`static` runs every check, even after one fails.** Each step runs as long as the setup succeeded and the run was not cancelled, so one run reports every typecheck, lint, coverage, audit and workflow-lint problem at once. The job fails if any of them did.
- **The production audit blocks.** `--omit=dev` limits it to the dependencies that ship in the packages, and `--audit-level=low` fails on an advisory of any severity. A new advisory for a production dependency therefore fails the next run, even without a code change. Development dependencies are covered by dependency review on pull requests and by Dependabot. `npm audit` queries the npm registry, so the step also fails when the registry cannot be reached. The log tells the two apart: an advisory lists the affected package and severity, while a registry problem shows a network or HTTP error. For a registry error, rerun the failed job; for an advisory, update the dependency or follow [dependencies.md](dependencies.md).
- **actionlint** runs from the official `rhysd/actionlint` Docker image (1.7.12), pinned by digest, which also runs shellcheck on every `run:` script. To run the same check locally:

  ```bash
  docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667 -color
  ```

- **Electron jobs** (`integration`, `e2e`, `package`) run the setup action with `electron: "true"`, which installs Xvfb and enables unprivileged user namespaces (see [User namespaces on runners](#user-namespaces-on-runners)). On Ubuntu 24.04 or later, reproducing an E2E failure locally needs the same `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`; Debian 13 needs nothing.
- **`windows` checks shared code on Windows; Windows is still not supported.** Like `static`, it runs each check even after one fails. It catches path-separator, case, and line-ending assumptions in the code and the tests before the Windows platform is implemented. It does not cover yet: integration, end-to-end, and packaging tests (they need Linux and are not run there), the unit tests that need a Linux facility (skipped, see below), and any runtime behavior, since the Windows platform still rejects every operation.
- **Tests that need Linux are skipped with a reason.** A unit test that needs a Linux facility (`/proc`, POSIX signals, POSIX file modes, the AppImage runtime) is guarded with `describe.skipIf(process.platform !== 'linux')` or `it.skipIf(...)`, and its title starts with `[linux-only: <facility>]`, for example `'[linux-only: /proc] /proc reader'`. On Windows the runner reports it as skipped, and its title names the facility; on Linux it runs as usual. A test whose assumption is incidental, such as a path joined with `/`, is fixed instead of skipped. `test/unit/test-platform-policy.test.ts` scans every script under `test/` and fails on a platform skip (`skipIf`, `runIf`, or a conditional `skip(condition, reason)`) without such a reason, on a guard that does not run its test on exactly the system its reason names (it evaluates the condition for Linux, Windows, and macOS), and on any other branch on the platform in test code (`if`, `?:`, `&&`, `||`, `switch`), which could let a test pass without running. It checks that a reason is present, not that it names the right facility; that is for review. `[windows-only: <facility>]` with `process.platform !== 'win32'` is the counterpart for later Windows work.
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

## Windows probes

`.github/workflows/windows-probe.yml` runs experiments on the `windows-2025` runner that answer how Windows behaves: stopping process trees, starting `.cmd` files, the registry environment, output encodings, listening ports, Electron, and an NSIS installer. The answers are the evidence the Windows platform work builds on (OpenSpec change `assess-windows-platform`, design D1–D9). Each check is a yes/no question whose predicted answer is fixed in `scripts/windows-probe/checks.mjs` before any probe runs; `summary.mjs` derives each status (`PASS`, `FAIL`, `EXPECTED-FAIL`, `NOT-TESTABLE`) from the answer and the prediction. Windows stays "not yet supported" whatever a run shows.

It is never a required check and never blocks anything: it has no pull request, push or schedule trigger, `ci.yml` does not refer to it, and `ci-ok` does not need its jobs. Every job has `contents: read` and nothing else, checks out without stored credentials, and the workflow contains no commit, tag or push step, so a run changes nothing in the repository. The policy test checks all of this. Windows runner minutes cost more than Linux ones, so start it only when a probe changed or the runner image did.

Start it from **Actions → Windows probe → Run workflow**, or from the command line. GitHub offers a manual workflow only once its file is on the default branch, but the run itself uses the version on the branch it is started on:

```bash
gh workflow run windows-probe.yml --ref <branch>
```

| Input | Default | Meaning |
|---|---|---|
| `negative-control` | `false` | `true` starts one probe driver straight from the job's shell, which has a console, to show that the console control (`ctx-no-console`) can fail. The summary header then says `negative-control true`. Such a run is never committed as evidence, and the evidence test rejects its summary |

```bash
gh workflow run windows-probe.yml --ref <branch> -f negative-control=true
```

| Job | What it runs | Artifacts (kept 14 days) | Timeout |
|---|---|---|---|
| `process-tree`, `helper`, `commands`, `environment`, `encoding`, `ports` | On `windows-2025`: one probe area each (`scripts/windows-probe/`) | `windows-probe-results-<area>`: `<area>.jsonl`, whether the probe passes or fails | 20–30 min |
| `electron`, `nsis` | On `windows-2025`: the built app and the NSIS installer. They run the setup action with `electron: "true"`, as every job that launches Electron must | `windows-probe-results-electron`, `windows-probe-results-nsis` | 45 min, 60 min |
| `summary` | On `ubuntu-24.04`, whatever happened to the probe jobs: downloads every area's results and runs `node scripts/windows-probe/summary.mjs` | `windows-probe-summary`: `summary.txt` and `results/<area>.jsonl` | 10 min |

How a probe job works:

- **Identity first.** Each job starts its results file with an identity line written by `scripts/windows-probe/identity.mjs`: the runner's `ImageOS` and `ImageVersion`, the Windows build, the Node version, and the negative-control flag. The summary runs on Ubuntu, so it takes the Windows identity only from these lines, and lists every distinct image version with the areas measured on it.
- **Answers, not statuses.** The probe appends one JSON line per check it answered (`yes`, `no`, or `null` with a reason). A check no probe reported is listed as `NOT-TESTABLE` with "no result: probe did not report it", so a crashed probe shows up as missing evidence. If no job uploaded any results at all, there is nothing to summarize: the `summary` job fails with "no .jsonl results" and writes no `summary.txt`.
- **Results are kept whatever happened.** The upload step runs with `if: always()`, so a probe that fails or reaches its timeout still uploads the lines it wrote.
- **Not implemented yet.** Until an area's probe exists, its job runs `scripts/windows-probe/placeholder.mjs`, which answers every check of the area with `null` and the reason "probe not implemented yet".
- **A temporary standard user (planned, tasks 3.2–6.2; no job does this yet).** The runner account is an administrator, so the probes whose results depend on privileges (process tree, helper, environment, ports) will also run as a local standard user, `veydr-probe`, that the job creates with a random, masked password and removes at the end, whatever the outcome. The probe files will be copied to `C:\veydr-probe-std` for it. The checks run that way are the ones whose ID ends in `-std`. Every job runs on a fresh VM, so nothing outlives the job.

### From a run to committed evidence

A run's results become evidence only after review (design D4, tasks 8.1):

1. Download the summary artifact:

   ```bash
   gh run download <run-id> --name windows-probe-summary --dir windows-probe-run
   ```

2. Check `summary.txt`: its header names the run's commit, exactly one Windows image version, and `negative-control false`; every control passed; no line says "no result: probe did not report it"; and every `FAIL` and `EXPECTED-FAIL` is understood. A `FAIL` is a prediction that did not hold, a finding, and is never fixed by editing the prediction afterwards. If the header lists several image versions, rerun the workflow.
3. Copy `summary.txt` to `test/windows-probe/summary.txt` and `results/*.jsonl` to `test/windows-probe/results/`, and commit them in the change's pull request. `.gitattributes` marks those `.jsonl` files as text, so they show in the review diff.

## Releasing

`.github/workflows/release.yml` turns `master` into a release. It is the only workflow that writes to the repository, and it does so only after the full gate passed on the exact tree it is about to push (design D6).

### One-time repository setup

Before the first release, create the `master` ruleset: **Settings → Rules → Rulesets → New ruleset → New branch ruleset**.

1. **Name** `master`, **Enforcement status** Active, **Target branches**: Include default branch.
2. **Rules**:
   - **Restrict deletions** and **Block force pushes**;
   - **Require a pull request before merging**. With one maintainer, leave the required approvals at 0; turn on **Require review from Code Owners** once there is a second reviewer (see [Code owners](#code-owners));
   - **Require status checks to pass**, with exactly `ci-ok` and `dependency-review` (source: GitHub Actions). See [Required checks](#required-checks).
3. **Bypass list**: add **Deploy keys** with the mode **Always allow** (not "For pull requests only"), and nothing else, so the release can push its version commit directly with the release deploy key below. The bypass list does not offer **GitHub Actions** for this repository (see [Repository settings](#repository-settings)).

**Release deploy key** (design D7):

1. Create a key pair without a passphrase, outside the repository and in a terminal outside any tool that records its output: `ssh-keygen -t ed25519 -N "" -C veydr-release -f veydr-release`.
2. Add `veydr-release.pub` under **Settings → Deploy keys** with **Allow write access**. It must be the only deploy key with write access: the bypass applies to every one of them.
3. Store the private key `veydr-release` as the Actions repository secret `RELEASE_DEPLOY_KEY` (**Settings → Secrets and variables → Actions**), then delete both local files.

To rotate the key, delete the deploy key and the secret and repeat these steps.

When `RELEASE_DEPLOY_KEY` exists, `publish` checks out and pushes over SSH with it; otherwise it uses the job's `GITHUB_TOKEN`. Only `release.yml` may read that secret. A push with the deploy key starts `ci.yml` for the version commit on `master`; a push with `GITHUB_TOKEN` does not, because GitHub does not start workflows for pushes made with the job token. Either way, the commit only changes the version.

### Cutting a release

Choose the version first:

- **Format**: `MAJOR.MINOR.PATCH`, or `MAJOR.MINOR.PATCH-PRERELEASE` (for example `0.2.0-rc.1`), without a leading `v` and without `+build` metadata.
- **Greater than everything before it**: it must be greater (by SemVer precedence) than the version in `package.json` and than every `v*` tag, and its tag must not exist yet. `0.3.0` is accepted after `v0.3.0-rc.1`; `0.3.0-rc.2` is not accepted after `v0.3.0`.
- **Which number**: a patch version for fixes only, a minor version for new features (before 1.0.0, also for changes that break existing configurations, which the release notes must call out), a major version for breaking changes after 1.0.0.
- **Prereleases**: a version with a prerelease suffix becomes a GitHub prerelease. Use one (`X.Y.Z-rc.1`) to rehearse a release or to get feedback before the final version.

Then start the workflow on `master`: **Actions → Release → Run workflow**, branch `master`, with the version. From the command line:

```bash
gh workflow run release.yml --ref master -f version=0.1.0
```

| Job | What it does | Timeout |
|---|---|---|
| `validate` | Fails unless the run is on `master`. Checks out with every tag and runs `node scripts/release-version.mjs check`. Outputs the tag, whether it is a prerelease, and the commit the run started from (the source commit) | 10 min |
| `verify` | On the source commit: applies the version (`release-version.mjs apply`), then `xvfb-run --auto-servernum npm run verify` (the integration tests launch the app) | 45 min |
| `e2e` | The same bump, then `xvfb-run --auto-servernum npm run test:e2e` | 60 min |
| `package` | The same bump, then `xvfb-run --auto-servernum npm run test:packaging`. Fails unless `dist/` holds exactly `Veydr-X.Y.Z-amd64.deb` and `Veydr-X.Y.Z-x86_64.AppImage`, and uploads them as `release-packages` | 60 min |
| `smoke` | `scripts/smoke-linux.sh` on the `release-packages` files | 90 min |
| `acceptance` | `scripts/acceptance-linux.sh` on the `release-packages` files; uploads its results as `release-acceptance-linux` | 60 min |
| `publish` | Only if every job above succeeded; see below | 20 min |

All jobs except `publish` have `contents: read` only and keep no credentials. Every job runs the setup action with `cache: "false"`, so nothing comes from a cache. `publish`:

1. checks out the source commit with every tag, applies the version again, and commits `package.json` and `package-lock.json` as `github-actions[bot]` ("release vX.Y.Z"), failing if the commit changes any other file;
2. checks the remote: `master` must still be the source commit. If `master` moved during the run, it stops here, because the commit that would be released is not the one that was tested; start a new release from the current `master`;
3. downloads `release-packages` and the acceptance results, writes `SHA256SUMS` for the two packages and checks it, and checks that the acceptance record names the SHA-256 of the attached `.deb`;
4. creates a build provenance attestation for every package in `SHA256SUMS`;
5. creates the annotated tag `vX.Y.Z` and pushes the commit and the tag with one `git push --atomic`, so both land or neither does;
6. creates a **draft** release for the tag with generated notes (marked as a prerelease for a prerelease version), attaching both packages, `SHA256SUMS` and `acceptance-linux-steps.jsonl`.

Nothing reaches the remote repository before step 5. An attestation from step 4 stays in the attestation log even if the push then fails; it names packages that were never released, which is harmless.

`publish` stores its write credentials in the checkout, so the steps after it (the setup action from the source commit, the official download and attestation actions, and the scripts above) run next to them. It never runs `npm ci`, so no dependency's install script does.

The acceptance record names the SHA-256 of the `.deb` it tested, and `publish` checks it against the attached `.deb`. The AppImage has no such record of its own: it is tied to the gate only by coming from the same `release-packages` artifact that `smoke` tested. Only one release runs at a time: a second run waits for the first, and a running release is never cancelled by a new one. (GitHub keeps only one waiting run per concurrency group, so starting a third run while one is waiting cancels the waiting one.)

### Before publishing the draft

The draft is visible only to people with write access until you publish it. The tag and the version commit are already public on `master`. In **Releases**, open the draft and check:

- **Tag and commit**: the tag is `vX.Y.Z`, its commit changes only `package.json` and `package-lock.json`, and its parent is the commit you meant to release.
- **Files**: exactly `Veydr-X.Y.Z-amd64.deb`, `Veydr-X.Y.Z-x86_64.AppImage`, `SHA256SUMS` and `acceptance-linux-steps.jsonl`.
- **Prerelease**: set only for a version with a prerelease suffix.
- **Notes**: the generated list of pull requests. Edit it into a short summary of what changed for users, call out anything that breaks existing configurations, and repeat the open platform limitations (Ubuntu 24.04, see the README's platform notes).
- **The downloads verify**: download the files and run the checks users run (below). Optionally install the `.deb` on a real machine and run `veydr --smoke-test`.

Then **Publish release**. To discard it instead, see [Recovering from a failed release](#recovering-from-a-failed-release).

### Verifying a release package

Users (and you, before publishing) check a download in two ways. In the folder with the downloaded files:

```bash
sha256sum --check --ignore-missing SHA256SUMS
```

Every downloaded package must report `OK`. `--ignore-missing` skips the package you did not download.

Then check the build provenance with the [GitHub CLI](https://cli.github.com/):

```bash
gh attestation verify Veydr-X.Y.Z-amd64.deb --repo alexnakagama/veydr --signer-workflow alexnakagama/veydr/.github/workflows/release.yml
```

It succeeds only for a file whose digest was attested by this repository's release workflow, and prints the workflow run and the source commit it was built from. That commit is the parent of the tagged commit: the release tests and builds the source commit plus the version bump, and the tagged commit is exactly that bump. Provenance attestations need a public repository (see [Repository settings](#repository-settings)); if the repository becomes private, the attestation step fails and the release stops before pushing.

### Recovering from a failed release

What to do depends on where the run stopped. The run's summary shows which job failed.

- **`validate` failed** (wrong branch, malformed or too low version, existing tag): nothing was built or pushed. Fix the input and start a new run.
- **A gate job failed** (`verify`, `e2e`, `package`, `smoke`, `acceptance`): nothing was pushed, and the same version can be requested again.
  - For a flaky or infrastructure failure (a Docker Hub rate limit, for example), use **Re-run failed jobs**. GitHub reruns the failed job and the jobs that depend on it, on the same source commit. Do not weaken a flaky check to get a release through (see [Triaging a nightly failure](#triaging-a-nightly-failure)).
  - For a real failure, fix it in a pull request, then start a new release from the new `master`.
- **`publish` failed before "Tag and push"** (for example the attestation, or "master moved"): nothing was pushed. Rerun the failed jobs, or, if `master` moved, start a new release.
- **`publish` failed after "Tag and push"** (creating the draft or uploading a file): the commit and the tag are on the remote. Use **Re-run failed jobs**, not **Re-run all jobs**: a full rerun starts again at `validate`, which checks out the new `master` and refuses the version because its tag now exists. `publish` recognises the tag as its own (its commit's parent is the source commit and its content is the same bump), skips the commit and the push, and creates the draft, or uploads the files again to the existing draft.
- **To abandon a version after the push**: delete the draft and the tag with `gh release delete vX.Y.Z --cleanup-tag`. The version commit stays on `master` (force pushes are blocked), so the next release must be greater than that version anyway. Release the next patch or prerelease number instead of reusing the abandoned one. A rerun of the old run's `publish` after the tag was deleted stops with "master moved", because `master` now holds the version commit; that is expected, and the way forward is again a new release with the next version.

A rerun of `publish` refuses to do anything if the tag exists but is not its own commit, or if a release for the tag exists and is already published.

## Code owners

`.github/CODEOWNERS` makes the maintainer (`@alexnakagama`) the owner of everything, and names them again explicitly for `.github/` (the workflows, the setup action, Dependabot and these files) and for `scripts/release-version.mjs` (the release version logic) and `scripts/npm.mjs`, which it runs npm through. The explicit entries come last, so they still apply if a broader owner is added for `*` later. With **Require review from Code Owners** turned on in the `master` ruleset, a change to the pipeline cannot be merged without the maintainer's review.

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
| `actions/checkout` | v7.0.1 | Every workflow: `ci.yml`, `security.yml`, `nightly.yml`, `build.yml`, `release.yml`, `windows-probe.yml` |
| `actions/setup-node` | v7.1.0 | `.github/actions/setup` |
| `actions/cache` | v6.1.0 | `.github/actions/setup` |
| `actions/upload-artifact` | v7.0.2 | `ci.yml`, `nightly.yml`, `build.yml`, `release.yml`, `windows-probe.yml` |
| `actions/download-artifact` | v8.0.2 | `build.yml`, `release.yml`, `windows-probe.yml` |
| `actions/attest-build-provenance` | v4.2.2 | `release.yml` |
| `actions/dependency-review-action` | v5.0.0 | `security.yml` |
| `github/codeql-action` (`init`, `analyze`) | v4.39.0 | `security.yml` |
| `rhysd/actionlint` Docker image | 1.7.12, pinned by digest | `ci.yml` |

## Run records

Workflow runs that verify this pipeline on GitHub. They need the workflows on GitHub, so they are recorded after the change's pull request is opened.

| What | Run | Outcome |
|---|---|---|
| `security.yml` on a pull request: `codeql` and `dependency-review` both run (task 4.1) | [Security run 40261987602](https://github.com/alexnakagama/veydr/actions/runs/40261987602) on [#4](https://github.com/alexnakagama/veydr/pull/4) | Both ran and passed. `dependency-review` first needed the repository's dependency graph, which was off: it failed with "Dependency review is not supported on this repository" until the graph was enabled on 2026-10-26 |
| Dependabot configuration accepted, no errors in the Dependabot tab after merge (task 4.2) | Not yet checked | — |
| Manual `nightly.yml` dispatch completes (task 4.3) | Not yet run | — |
| Manual `build.yml` dispatch on `master`; `sha256sum -c SHA256SUMS` succeeds on the downloaded packages (task 4.4) | Not yet run | — |
| `ci-ok` fails when a check fails (task 3.3): throwaway [#5](https://github.com/alexnakagama/veydr/pull/5) adds a deliberately failing unit test (`6e0181d`) | [CI run 40264125726](https://github.com/alexnakagama/veydr/actions/runs/40264125726) | `unit` failed on that test only; `ci-ok` failed with "these checks did not succeed: unit". With the `master` ruleset active, the merge box showed merging blocked by the failed required check `ci-ok` |
| `ci-ok` succeeds once the failure is reverted (task 3.3): the revert on #5 (`b9384d0`) | [CI run 40264758062](https://github.com/alexnakagama/veydr/actions/runs/40264758062) | Every job and `ci-ok` passed; the merge box showed all checks passed and merging allowed. #5 was closed without merging and its branch deleted |
| A failing release gate publishes nothing (task 6.3): the first `0.1.0-rc.1` release on `master` at `5ba2d7d` | Release run 40266136812 (later deleted from the Actions history by the maintainer) | `validate`, `package`, `smoke` and `acceptance` passed; `verify` and `e2e` failed, because two tests assumed the repository was at `0.0.0` (fixed in [#6](https://github.com/alexnakagama/veydr/pull/6)); `publish` was skipped. Afterwards the remote had no tags, `master` was unchanged and the Releases page showed no release or draft |
| Release `0.1.0-rc.1` from `master` at `a3c4eb1` (task 6.2) | [Release run 40270392953](https://github.com/alexnakagama/veydr/actions/runs/40270392953) | Every job passed. `publish` pushed, with the deploy key and in one atomic push, the commit `f689b5f` "release v0.1.0-rc.1" by github-actions[bot] (parent `a3c4eb1`; changes only `package.json` and `package-lock.json`, `0.0.0` → `0.1.0-rc.1`) and the annotated tag `v0.1.0-rc.1` pointing at it. The draft release shows the Draft and Pre-release labels and holds `Veydr-0.1.0-rc.1-amd64.deb`, `Veydr-0.1.0-rc.1-x86_64.AppImage`, `SHA256SUMS` and `acceptance-linux-steps.jsonl`. CI and Security then passed on `master` at `f689b5f`. The draft is left unpublished |
| The draft's downloads verify (task 6.2) | The four files above, downloaded from the draft | `sha256sum -c SHA256SUMS`: both packages OK. The acceptance record has 16 steps, all `ok`; it names the SHA-256 of the attached `.deb` and the packaged app reported version `0.1.0-rc.1`. Provenance, checked without the GitHub CLI: GitHub's attestation API returns one SLSA provenance attestation for both package digests, naming `.github/workflows/release.yml` at `refs/heads/master`, source commit `a3c4eb1` (the tagged commit's parent) and run 40270392953; its DSSE signature verifies against its signing certificate (`openssl dgst -verify`), which was issued by sigstore-intermediate during the `publish` job, for the same workflow, commit and run. **Not verified:** the certificate chain to Sigstore's trusted root and the transparency-log entry, which `gh attestation verify` checks; it was not run |
| The same version is refused once released (task 6.3): `0.1.0-rc.1` again, on `master` at `f689b5f` | [Release run 40272171521](https://github.com/alexnakagama/veydr/actions/runs/40272171521) | `validate` failed at "Check the version": `release-version: tag v0.1.0-rc.1 already exists; the version must be greater than the latest version 0.1.0-rc.1 (package.json)`. Every other job was skipped; `master` and the tag were unchanged |
| A release started from another branch is refused before building (task 6.3): `0.1.0-rc.2` from a temporary branch `rehearsal/release-from-branch` at `f689b5f` | [Release run 40272489403](https://github.com/alexnakagama/veydr/actions/runs/40272489403) | `validate` failed at "Require master": "Release refused: a release runs only on master, not on refs/heads/rehearsal/release-from-branch". Every other job was skipped. Afterwards there was no `v0.1.0-rc.2` tag, `master` was unchanged and the Releases page still showed only the `0.1.0-rc.1` draft. The branch was then deleted |
| Manual `windows-probe.yml` dispatch on the `assess-windows-platform` branch completes, and its `summary.txt` lists every check ID (assess-windows-platform task 2.5) | Not yet run | — |

## Repository settings

These answers were confirmed with the maintainer on 2026-10-25 (task 1.1 of the change), and the bypass corrected on 2026-10-26:

- **Bypass for the release commit: a deploy key.** Task 1.1 recorded that the ruleset's bypass list offers **GitHub Actions**; when the `master` ruleset was created on 2026-10-26 it did not (it offered deploy keys, roles and installed apps only). The ruleset therefore lists **Deploy keys** with **Always allow**, and the release pushes its version commit and tag with the deploy key `veydr-release`, stored as the `RELEASE_DEPLOY_KEY` secret (design D7, the fallback). The first release, `v0.1.0-rc.1`, was pushed this way (see [Run records](#run-records)).
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

  A job that launches Electron must first run the setup action with `electron: "true"`, on Linux and on Windows alike. Launching means running `xvfb-run` or `Xvfb`, Playwright, `npm run test:integration`, `test:e2e`, `test:perf` or `test:packaging`, the built app directly with `--smoke-test`, or `scripts/ensure-electron.cjs`, which downloads Electron only so it can be launched.
- **No stored credentials.** Every `actions/checkout` sets `persist-credentials: false`, except in the release workflow's `publish` job, which pushes the release commit.

The forbidden strings are matched as plain text in every file under `.github/`, comments and Markdown included, so even a note that names them fails the test.

The test reads the files as text with line-level patterns, so no YAML parser is needed. That only works with a narrow style: block style, two-space indentation, one key per line, no anchors, and no flow collections other than `{}` and `[]`. This applies to every YAML file, including `.github/dependabot.yml`. Write `cooldown:` with `default-days: 7` on the next line, not `cooldown: { default-days: 7 }`, and write `patterns:` with `- "*"` on the next line, not `patterns: ["*"]`. The test fails on any line it cannot classify, so a construct it does not understand is rejected, not let through.

## User namespaces on runners

Chromium's sandbox needs unprivileged user namespaces, and `test/e2e/offline.spec.ts` needs a user and network namespace (`unshare --user --map-root-user --net`) to prove Veydr works offline. GitHub's `ubuntu-24.04` image sets `kernel.apparmor_restrict_unprivileged_userns=1`, which blocks both.

With `electron: "true"` on a Linux runner, the setup action runs `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` before any test. This puts the runner in the state the app was verified in (Debian 13, namespaces allowed), so the sandbox and the offline test run for real. The step then checks `unshare --user true` and `unshare --user --map-root-user --net true`, and fails with a clear error if either does not work, rather than letting the sandbox fail later inside Playwright.

The alternatives were rejected: setting `VEYDR_ALLOW_SKIP_OFFLINE` would hide exactly what the offline test exists for, and installing Veydr's AppArmor profile on the runner covers only the packaged binary, not `node_modules/electron`. The packaged app under Ubuntu 24.04's restriction remains a manual check (see the README's platform notes); CI does not claim to cover it.

## Core dumps on runners

The runner image pipes core dumps to `systemd-coredump` (`kernel.core_pattern=|/usr/lib/systemd/systemd-coredump …`) and sets `fs.suid_dumpable=2`, so even Chromium's sandboxed processes, which mark themselves non-dumpable, are dumped. A crashing process stays in the kernel's exit path until its core has been written, and Electron learns that the process is gone only then. On a runner that took more than 30 seconds for a renderer, so `failure.spec.ts`'s crashed-renderer test hung: the renderer had crashed, but Veydr had not been told yet.

With `electron: "true"` on a Linux runner, the setup action therefore runs `sudo sysctl -w fs.suid_dumpable=0 'kernel.core_pattern=|/bin/false'`: no process on the runner writes a core dump. Nothing collected the dumps anyway; a crash still shows in the test output, as it does on a developer machine with dumps disabled (`ulimit -c 0`).
