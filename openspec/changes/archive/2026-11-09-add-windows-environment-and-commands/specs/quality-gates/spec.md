# Spec Delta

## MODIFIED Requirements

### Requirement: Pull request and main-branch checks
Every pull request targeting `master`, and every push to `master`, SHALL run typecheck, lint, spec coverage, unit tests, integration tests, end-to-end tests against the built application, Linux packaging with the packaging tests, and workflow linting. The same events SHALL also run typecheck, lint, unit tests, the Windows integration tests, and the Windows end-to-end tests against the built application on Windows.

#### Scenario: Pull request runs the full check set
- **WHEN** a pull request targeting `master` is opened or updated
- **THEN** typecheck, lint, spec coverage, unit, integration, end-to-end, packaging, and workflow-lint checks run against the pull request's merge commit
- **AND** typecheck, lint, unit tests, the Windows integration tests, and the Windows end-to-end tests also run on a Windows runner against the same commit

#### Scenario: Push to master runs the same checks
- **WHEN** a commit is pushed to `master`
- **THEN** the same set of checks runs against that commit

#### Scenario: Superseded pull request runs are cancelled
- **WHEN** a pull request is updated while checks for its previous commit are still running
- **THEN** the run for the previous commit is cancelled

### Requirement: End-to-end tests keep the OS sandbox
End-to-end tests in the pipeline SHALL run the application with Chromium's sandbox enabled and with the offline network-namespace test active. The pipeline MUST NOT pass `--no-sandbox` or set `VEYDR_ALLOW_SKIP_OFFLINE`. On Windows, where network namespaces do not exist, the end-to-end tests SHALL also run with the sandbox enabled, and the offline test SHALL remain required in the Linux end-to-end job.

#### Scenario: Sandbox and offline test are not weakened
- **WHEN** the end-to-end job runs
- **THEN** its configuration contains neither `--no-sandbox` nor `VEYDR_ALLOW_SKIP_OFFLINE`, and the job enables unprivileged user namespaces before launching the application

#### Scenario: Windows end-to-end tests keep the sandbox
- **WHEN** the Windows end-to-end tests run in the `windows` job
- **THEN** the job's configuration contains neither `--no-sandbox` nor `VEYDR_ALLOW_SKIP_OFFLINE`, and the tests check that the renderer runs sandboxed

### Requirement: Operating-system limits of tests are declared
A test that cannot run on an operating system SHALL be skipped there with a stated reason that names the missing facility, such as `/proc` or POSIX signals. Tests MUST NOT pass on an operating system by silently doing nothing.

#### Scenario: Linux-only test on Windows
- **WHEN** the unit tests run on Windows and a test depends on a Linux facility
- **THEN** the test is reported as skipped, and its skip reason names that facility

#### Scenario: Linux-only test on Linux
- **WHEN** the same test runs on Linux
- **THEN** it runs and its result counts toward the check

#### Scenario: Linux-only end-to-end test on Windows
- **WHEN** the Windows end-to-end tests run and a test depends on a Linux facility, such as network namespaces or a login shell
- **THEN** the test is reported as skipped, and its skip reason names that facility
