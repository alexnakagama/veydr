# Spec Delta

## MODIFIED Requirements

### Requirement: Windows helper built from source
The Windows helper, which runs process trees and reads the listening ports, SHALL be built from source committed to the repository each time it is needed. No helper binary SHALL be committed. A check that needs the helper SHALL fail, not skip, when the helper cannot be built.

#### Scenario: No committed helper binary
- **WHEN** the repository contains an executable or library file under the helper's source or build directories
- **THEN** the workflow policy test fails

#### Scenario: Helper build failure fails the Windows check
- **WHEN** the helper does not compile on the Windows runner
- **THEN** the Windows job fails, and the Windows integration test step does not run, so no Windows integration test is reported as passed or skipped
