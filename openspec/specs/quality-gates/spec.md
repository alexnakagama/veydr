# quality-gates Specification

## Purpose

Defines the automated checks that guard Veydr's main branch: what runs for every change and on a schedule, what blocks a merge, how failures are reported, and the security rules every workflow follows.

## Requirements

### Requirement: Pull request and main-branch checks
Every pull request targeting `master`, and every push to `master`, SHALL run typecheck, lint, spec coverage, unit tests, integration tests, end-to-end tests against the built application, Linux packaging with the packaging tests, and workflow linting. The same events SHALL also run typecheck, lint, and unit tests on Windows.

#### Scenario: Pull request runs the full check set
- **WHEN** a pull request targeting `master` is opened or updated
- **THEN** typecheck, lint, spec coverage, unit, integration, end-to-end, packaging, and workflow-lint checks run against the pull request's merge commit
- **AND** typecheck, lint, and unit tests also run on a Windows runner against the same commit

#### Scenario: Push to master runs the same checks
- **WHEN** a commit is pushed to `master`
- **THEN** the same set of checks runs against that commit

#### Scenario: Superseded pull request runs are cancelled
- **WHEN** a pull request is updated while checks for its previous commit are still running
- **THEN** the run for the previous commit is cancelled

### Requirement: Single aggregate required check
The pipeline SHALL report one aggregate status named `ci-ok`. It succeeds only when every check in the pull request and main-branch set succeeded. It fails when any of them failed, was cancelled, or was skipped.

#### Scenario: All checks pass
- **WHEN** every check in the set succeeds
- **THEN** `ci-ok` succeeds

#### Scenario: One check fails or is skipped
- **WHEN** any check in the set fails, is cancelled, or is skipped
- **THEN** `ci-ok` fails

### Requirement: End-to-end tests keep the OS sandbox
End-to-end tests in the pipeline SHALL run the application with Chromium's sandbox enabled and with the offline network-namespace test active. The pipeline MUST NOT pass `--no-sandbox` or set `VEYDR_ALLOW_SKIP_OFFLINE`.

#### Scenario: Sandbox and offline test are not weakened
- **WHEN** the end-to-end job runs
- **THEN** its configuration contains neither `--no-sandbox` nor `VEYDR_ALLOW_SKIP_OFFLINE`, and the job enables unprivileged user namespaces before launching the application

### Requirement: Dependency gates
Pull requests SHALL fail when they introduce a dependency with a known vulnerability of moderate or higher severity. Every pipeline run SHALL fail when the production dependency tree has any known vulnerability.

#### Scenario: Pull request adds a vulnerable dependency
- **WHEN** a pull request's dependency changes add a package with a known moderate-or-higher vulnerability
- **THEN** the dependency review check fails

#### Scenario: Production dependency becomes vulnerable
- **WHEN** an advisory is published for a package in the production dependency tree
- **THEN** the production audit check fails on the next run

### Requirement: Static security analysis
The repository's JavaScript and TypeScript code SHALL be analysed by CodeQL on every pull request, on every push to `master`, and at least weekly.

#### Scenario: Weekly analysis without code changes
- **WHEN** a week passes with no pushes
- **THEN** a scheduled CodeQL analysis runs on `master`

### Requirement: Scheduled extended checks
The performance scenarios, the distribution smoke matrix, and the packaged acceptance pass SHALL run at least nightly, and on manual request. Their failures MUST NOT block merges. They SHALL be reported through a single open tracking issue, which is created or updated with a link to the failing run.

#### Scenario: Nightly failure is reported once
- **WHEN** a nightly run fails while a tracking issue for nightly failures is already open
- **THEN** that issue receives a comment linking the run, and no second issue is opened

#### Scenario: Nightly run on demand
- **WHEN** the maintainer starts the nightly workflow manually
- **THEN** the same extended checks run against the selected ref

### Requirement: Workflow security policy
Every workflow SHALL declare explicit permissions, defaulting to none, and grant write scopes only to the jobs that need them. Every job SHALL have a timeout. Every third-party action SHALL be referenced by a full commit SHA. Workflows triggered by pull requests MUST NOT have access to repository secrets or write permissions.

#### Scenario: Unpinned action is rejected
- **WHEN** a workflow references an action by tag or branch instead of a 40-character commit SHA
- **THEN** the workflow policy test fails

#### Scenario: Missing permissions or timeout is rejected
- **WHEN** a workflow lacks a top-level `permissions` declaration or a job lacks `timeout-minutes`
- **THEN** the workflow policy test fails

#### Scenario: No privileged pull request trigger
- **WHEN** any workflow is triggered by `pull_request_target`
- **THEN** the workflow policy test fails

### Requirement: Automated dependency updates
Dependency update pull requests SHALL be proposed weekly for npm packages and for GitHub Actions. npm updates SHALL wait at least seven days after a version's release, matching the project's minimum release age.

#### Scenario: Freshly published version is not proposed
- **WHEN** an npm dependency publishes a new version less than seven days old
- **THEN** no update pull request proposes that version

### Requirement: Operating-system limits of tests are declared
A test that cannot run on an operating system SHALL be skipped there with a stated reason that names the missing facility, such as `/proc` or POSIX signals. Tests MUST NOT pass on an operating system by silently doing nothing.

#### Scenario: Linux-only test on Windows
- **WHEN** the unit tests run on Windows and a test depends on a Linux facility
- **THEN** the test is reported as skipped, and its skip reason names that facility

#### Scenario: Linux-only test on Linux
- **WHEN** the same test runs on Linux
- **THEN** it runs and its result counts toward the check
