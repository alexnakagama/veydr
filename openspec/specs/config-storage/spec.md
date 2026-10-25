# config-storage Specification

## Purpose

Defines how Veydr stores projects, commands, and preferences locally: where configuration lives, how it is versioned, validated, persisted safely, recovered after corruption, and what protection is and is not provided for secret values.

## Requirements

### Requirement: Central per-user configuration location
Configuration SHALL be stored in the per-user application data directory provided by the operating system, honoring `XDG_CONFIG_HOME` on Linux. Veydr SHALL NOT write into registered project directories.

#### Scenario: Default Linux location
- **WHEN** Veydr runs on Linux with `XDG_CONFIG_HOME` unset
- **THEN** configuration is stored under `~/.config/` in a Veydr-specific directory

#### Scenario: XDG override honored
- **WHEN** Veydr runs on Linux with `XDG_CONFIG_HOME` set to a directory
- **THEN** configuration is stored under that directory

#### Scenario: Project directories untouched
- **WHEN** a project is registered, edited, and its commands are run
- **THEN** no file is created or modified by Veydr inside the project directory

### Requirement: Versioned configuration schema
The configuration file SHALL carry an integer schema version. Older versions SHALL be migrated forward on load; a file with a newer version than the application supports SHALL be opened read-only and SHALL NOT be overwritten.

#### Scenario: Older schema migrated
- **WHEN** Veydr loads a configuration file with an older supported schema version
- **THEN** it is migrated to the current version
- **AND** the pre-migration file is preserved as a backup before the migrated file is written

#### Scenario: Newer schema protected
- **WHEN** Veydr loads a configuration file whose schema version is newer than it supports
- **THEN** the user is informed that the configuration was created by a newer version
- **AND** configuration changes are disabled and the file is not modified

### Requirement: Validation on load and save
Configuration SHALL be validated against the schema when loaded and before every save. Invalid data SHALL never be persisted.

#### Scenario: Invalid change rejected
- **WHEN** a configuration change would produce data that violates the schema
- **THEN** the change is rejected with a validation error describing the field
- **AND** the stored configuration is unchanged

### Requirement: Atomic persistence
Each save SHALL replace the configuration file atomically, so that after an interruption at any point the file on disk is either the complete previous version or the complete new version.

#### Scenario: Interrupted save
- **WHEN** a save is interrupted at any step before completion
- **THEN** the configuration file on disk is a complete, valid previous version

### Requirement: Backup and recovery
Veydr SHALL keep the last known-good configuration as a backup. If the primary file is unreadable or invalid, Veydr SHALL load the backup, inform the user, and preserve the damaged file for inspection.

#### Scenario: Corrupt primary file
- **WHEN** the configuration file cannot be parsed or fails validation and a valid backup exists
- **THEN** Veydr loads the backup and tells the user that recovery occurred
- **AND** the damaged file is kept under a distinct name and not deleted

#### Scenario: No usable configuration
- **WHEN** neither the configuration file nor the backup is usable
- **THEN** Veydr starts with an empty configuration, tells the user, and keeps the damaged files

### Requirement: Restrictive file permissions
On Linux, configuration files and their directory SHALL be readable and writable only by the owning user.

#### Scenario: Linux permissions
- **WHEN** Veydr creates or saves configuration on Linux
- **THEN** configuration files have mode `0600` and the configuration directory has mode `0700`

### Requirement: Documented secret-handling limits
Environment values marked secret SHALL be stored in plaintext in the configuration file, protected only by file permissions. The application SHALL state this limitation in the user interface where secret values are edited.

#### Scenario: Limitation disclosed
- **WHEN** the user marks an environment variable as secret
- **THEN** the user interface states that the value is stored unencrypted on disk and that masking and log redaction are best-effort

### Requirement: Single configuration writer
Only one running Veydr instance SHALL write configuration at a time.

#### Scenario: Concurrent instance prevented
- **WHEN** a second Veydr instance starts while one is running
- **THEN** the second instance does not write configuration
