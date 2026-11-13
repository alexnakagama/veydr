# Spec Delta

## MODIFIED Requirements

### Requirement: Pull request and main-branch checks
Every pull request targeting `master`, and every push to `master`, SHALL run typecheck, lint, spec coverage, unit tests, integration tests, end-to-end tests against the built application, Linux packaging with the packaging tests, and workflow linting. The same events SHALL also run typecheck, lint, unit tests, the Windows integration tests, and the Windows end-to-end tests against the built application on Windows, and SHALL build the Windows installer and run the Windows packaging tests on Windows.

#### Scenario: Pull request runs the full check set
- **WHEN** a pull request targeting `master` is opened or updated
- **THEN** typecheck, lint, spec coverage, unit, integration, end-to-end, packaging, and workflow-lint checks run against the pull request's merge commit
- **AND** typecheck, lint, unit tests, the Windows integration tests, and the Windows end-to-end tests also run on a Windows runner against the same commit
- **AND** the Windows installer is built and the Windows packaging tests run on a Windows runner against the same commit

#### Scenario: Push to master runs the same checks
- **WHEN** a commit is pushed to `master`
- **THEN** the same set of checks runs against that commit

#### Scenario: Superseded pull request runs are cancelled
- **WHEN** a pull request is updated while checks for its previous commit are still running
- **THEN** the run for the previous commit is cancelled

#### Scenario: Windows installer tested as a standard user
- **WHEN** the Windows packaging tests run in CI
- **THEN** the installer is also installed, its helper is exercised, and it is uninstalled by an account without administrator rights
- **AND** the tests fail, not skip, when that account cannot be set up

### Requirement: Windows helper built from source
The Windows helper, which runs process trees and reads the listening ports, SHALL be built from source committed to the repository each time it is needed. No helper binary SHALL be committed. A check that needs the helper SHALL fail, not skip, when the helper cannot be built. The helper inside a Windows package SHALL be built from that source in the run that builds the package.

#### Scenario: No committed helper binary
- **WHEN** the repository contains an executable or library file under the helper's source or build directories
- **THEN** the workflow policy test fails

#### Scenario: Helper build failure fails the Windows check
- **WHEN** the helper does not compile on the Windows runner
- **THEN** the Windows job fails, and the Windows integration test step does not run, so no Windows integration test is reported as passed or skipped

#### Scenario: Helper build failure fails Windows packaging
- **WHEN** the helper does not compile while the Windows package is being built
- **THEN** no installer is built and the packaging check fails
