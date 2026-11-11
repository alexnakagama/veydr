# Spec Delta

## MODIFIED Requirements

### Requirement: Windows supervision in preview
On Windows, commands SHALL start, stop and be recovered from the app through the Windows process tree, and the platform SHALL report itself as supported. Windows SHALL be described as a preview: installed from an unsigned installer or run from source, and verified on the native Windows CI runner. The process-tree behavior required for Windows SHALL be verified on native Windows for every pull request and push to `master`.

#### Scenario: Command started on Windows
- **WHEN** on Windows the user starts a configured direct-mode or shell-mode command
- **THEN** the command runs in its own containment, its output appears in its log, and stopping it ends its process tree

#### Scenario: Windows process trees verified natively
- **WHEN** the checks run for a pull request or a push to `master`
- **THEN** the Windows process-tree scenarios run on a native Windows runner, not only on Linux

#### Scenario: Windows preview documented
- **WHEN** the user reads the README or the process-management documentation
- **THEN** Windows is described as a preview that is installed from an unsigned installer and is verified in CI on Windows Server 2025, and the conditions not verified on Windows are listed

#### Scenario: Unsigned installer documented
- **WHEN** the user reads the Windows installation documentation
- **THEN** it states that the installer, the application and the helper are unsigned, that Windows may warn before running them, and how to verify a downloaded installer against the release's checksums and build provenance
