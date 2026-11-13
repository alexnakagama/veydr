# Spec Delta

## MODIFIED Requirements

### Requirement: Hardened packaged runtime
Packaged builds SHALL disable the ability to run the application binary as a plain Node.js runtime, SHALL ignore Node.js option environment variables and inspector command-line arguments, and SHALL only load application code from the packaged archive with integrity validation enabled. On Linux, Electron does not validate the archive's integrity: the setting is enabled, but the archive's integrity is not checked there, which SHALL be documented as a known limitation. On Windows, the archive SHALL be validated against the hash embedded in the application binary: a packaged application whose archive index was modified MUST NOT run. What that validation covers and does not cover, as measured on the packaged build, and that the application binary is unsigned, SHALL be documented.

#### Scenario: Run-as-node disabled
- **WHEN** the packaged application binary is started with the environment variable that would normally make it behave as Node.js
- **THEN** it does not execute arbitrary JavaScript as a Node.js runtime

#### Scenario: Modified archive refused on Windows
- **WHEN** on Windows a file is replaced in the application archive of a packaged build, so that the archive's index changes, and the application is started
- **THEN** the application does not start and the replaced code does not run

#### Scenario: Archive validation limits documented
- **WHEN** the user reads the security documentation
- **THEN** it states what the validation on Windows covers, what it does not cover, and that the application binary is unsigned

## ADDED Requirements

### Requirement: Per-user Windows installation
The Windows installer SHALL install Veydr for the current user only, without administrator rights and without an elevation prompt. It SHALL support a silent installation, add a Start menu entry and an uninstaller, and install over an existing installation. A silent installation MUST NOT start the application. The package MUST NOT contain update metadata, and installing MUST NOT make Veydr start when the user logs in.

#### Scenario: Silent installation as a standard user
- **WHEN** a user without administrator rights runs the installer silently
- **THEN** Veydr is installed below that user's own program directory, with a Start menu entry and an uninstaller, and no Veydr process is left running
- **AND** the installed helper answers that user and lists the listening ports

#### Scenario: No start at logon
- **WHEN** Veydr has been installed
- **THEN** no logon entry or startup shortcut for Veydr exists

#### Scenario: Installed application passes its self-check
- **WHEN** the installed application is started with its smoke-test option
- **THEN** every check passes, including the platform check, which reads the listening ports

#### Scenario: Installing over an existing installation
- **WHEN** the installer is run silently while a previous installation of Veydr exists and Veydr is not running
- **THEN** the installation succeeds and the installed application passes its self-check

#### Scenario: No update metadata
- **WHEN** the Windows package is built
- **THEN** neither the build output nor the installed application contains update metadata

### Requirement: Windows uninstallation keeps user data
Uninstalling Veydr on Windows SHALL remove the installed program files, the Start menu entry and the uninstall entry. It MUST NOT remove the user's configuration.

#### Scenario: Silent uninstallation
- **WHEN** the user runs the uninstaller silently
- **THEN** the installation directory, the Start menu entry and the uninstall entry are gone
- **AND** files in Veydr's configuration directory are still there

### Requirement: Packaged Windows helper
The Windows package SHALL contain the Windows helper as a file outside the application archive, and the packaged application SHALL start commands and read ports through that file. No executable SHALL be inside the application archive. The installed helper and its directory MUST NOT be writable by accounts other than the installing user, the system, and administrators.

#### Scenario: Command started through the installed helper
- **WHEN** a command is started and then stopped through the helper of an installed Veydr
- **THEN** the command runs in its own containment, and stopping it ends its process tree

#### Scenario: Helper outside the archive
- **WHEN** the Windows package is built
- **THEN** the helper is a file beside the application archive, and the archive contains no executable

#### Scenario: Install directory not writable by others
- **WHEN** Veydr is installed for a user
- **THEN** no account other than that user, the system, and administrators may write to the installation directory, the application binary, or the helper
