## MODIFIED Requirements

### Requirement: Atomic persistence
Each save SHALL replace the configuration file atomically, so that after an interruption at any point the file on disk is either the complete previous version or the complete new version. When replacing the file fails because another program briefly holds it, the save SHALL be retried a bounded number of times before it is reported as failed.

#### Scenario: Interrupted save
- **WHEN** a save is interrupted at any step before completion
- **THEN** the configuration file on disk is a complete, valid previous version

#### Scenario: File briefly held by another program
- **WHEN** replacing the configuration file fails because the file is temporarily locked or busy, and a later attempt within the retry bound succeeds
- **THEN** the save succeeds and no error is shown to the user

#### Scenario: File held beyond the retry bound
- **WHEN** replacing the configuration file keeps failing because it is locked or busy until the retry bound is exhausted
- **THEN** the save is reported as failed
- **AND** the configuration file on disk is the complete previous version
