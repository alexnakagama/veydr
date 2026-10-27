## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Operating-system limits of tests are declared
A test that cannot run on an operating system SHALL be skipped there with a stated reason that names the missing facility, such as `/proc` or POSIX signals. Tests MUST NOT pass on an operating system by silently doing nothing.

#### Scenario: Linux-only test on Windows
- **WHEN** the unit tests run on Windows and a test depends on a Linux facility
- **THEN** the test is reported as skipped, and its skip reason names that facility

#### Scenario: Linux-only test on Linux
- **WHEN** the same test runs on Linux
- **THEN** it runs and its result counts toward the check
