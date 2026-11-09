# Spec Delta

## ADDED Requirements

### Requirement: Windows supervision in preview
On Windows, commands SHALL start, stop and be recovered from the app through the Windows process tree, and the platform SHALL report itself as supported. Windows SHALL be described as a preview: run from source and verified on the native Windows CI runner, with no Windows package. The process-tree behavior required for Windows SHALL be verified on native Windows for every pull request and push to `master`.

#### Scenario: Command started on Windows
- **WHEN** on Windows the user starts a configured direct-mode or shell-mode command
- **THEN** the command runs in its own containment, its output appears in its log, and stopping it ends its process tree

#### Scenario: Windows process trees verified natively
- **WHEN** the checks run for a pull request or a push to `master`
- **THEN** the Windows process-tree scenarios run on a native Windows runner, not only on Linux

#### Scenario: Windows preview documented
- **WHEN** the user reads the README or the process-management documentation
- **THEN** Windows is described as a preview that runs from source and is verified in CI on Windows Server 2025, with no Windows package, and the conditions not verified on Windows are listed

## MODIFIED Requirements

### Requirement: Documented crash limitation
Veydr SHALL document that on Linux, processes it started can continue running after an abnormal exit until Veydr is started again, and that descendants that leave the process group before Veydr observes them may not be tracked. It SHALL also document the Windows behavior: an abnormal exit ends the command trees, and what the CI runner could not verify (a desktop session, logoff and shutdown, a parent outside any Job Object).

#### Scenario: Limitation documented
- **WHEN** the user reads the process-management documentation
- **THEN** the crash and escaped-descendant limitations are stated

#### Scenario: Windows limitations documented
- **WHEN** the user reads the process-management documentation
- **THEN** the Windows crash behavior and the conditions not verified on Windows are stated, labelled as part of the Windows preview

## REMOVED Requirements

### Requirement: Windows supervision not yet supported
**Reason**: Commands and their environment are now implemented on Windows and verified on the native Windows runner, which is the condition this requirement set for lifting it.
**Migration**: Replaced by "Windows supervision in preview". The "Start on Windows" scenario no longer applies: a command started on Windows now runs. "Windows process trees verified natively" moves to the new requirement unchanged.
