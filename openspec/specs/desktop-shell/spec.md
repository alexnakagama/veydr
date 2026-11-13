# desktop-shell Specification

## Purpose

Defines the Veydr desktop application shell: how it starts, how its privileged and unprivileged layers are isolated, which operations the user interface may request, and how unsupported platforms are reported.

## Requirements

### Requirement: Isolated renderer
The user interface SHALL run without access to Node.js, the filesystem, or process execution. It SHALL only reach privileged functionality through the explicitly exposed application API.

#### Scenario: Renderer has no Node.js access
- **WHEN** code running in the user interface inspects its global environment
- **THEN** no Node.js globals, module loader, or process object are available

#### Scenario: Renderer cannot load arbitrary modules
- **WHEN** code running in the user interface attempts to load a Node.js or Electron module
- **THEN** the attempt fails and no privileged module is loaded

### Requirement: Narrow application API
The application API exposed to the user interface SHALL consist only of named, purpose-specific operations. It SHALL NOT expose generic message sending, arbitrary filesystem access, or arbitrary command execution.

#### Scenario: Only declared operations are available
- **WHEN** the exposed application API is enumerated
- **THEN** it contains only the documented operation groups (application, projects, commands, processes, logs, ports)
- **AND** it contains no operation that accepts an arbitrary channel name, file path to read or write, or command line to run

### Requirement: Validation of privileged requests
Every request from the user interface to a privileged operation SHALL be validated against a declared schema and SHALL be accepted only from the application's own top-level window content. Invalid or unauthorized requests SHALL be rejected without side effects.

#### Scenario: Malformed request rejected
- **WHEN** a privileged operation receives a request whose payload does not match its schema
- **THEN** the request is rejected with a validation error
- **AND** no configuration, process, or filesystem state changes

#### Scenario: Request from unexpected origin rejected
- **WHEN** a privileged operation receives a request from a frame or origin other than the application's own bundled content
- **THEN** the request is rejected and the event is recorded in the application diagnostic log

### Requirement: No remote content
The application SHALL load only its bundled content. It SHALL block navigation away from that content and SHALL deny creation of new windows from the user interface.

#### Scenario: Navigation blocked
- **WHEN** the user interface attempts to navigate to any URL outside the bundled application content
- **THEN** the navigation is prevented

#### Scenario: New window denied
- **WHEN** the user interface attempts to open a new window
- **THEN** no window is created

### Requirement: Restrictive content security policy
The user interface SHALL be served with a content security policy that forbids remote scripts, inline scripts, `eval`, plugins, and remote network connections.

#### Scenario: Inline script blocked
- **WHEN** content containing an inline script is inserted into the user interface
- **THEN** the script does not execute

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

### Requirement: Single instance
Only one Veydr instance per user session SHALL supervise processes. A second launch SHALL focus the existing window and exit.

#### Scenario: Second launch focuses existing instance
- **WHEN** Veydr is already running and the user launches it again
- **THEN** the existing window is shown and focused
- **AND** the second process exits without reading or writing configuration

### Requirement: No automatic command execution
The application SHALL NOT start any configured command except in direct response to an explicit user action for that command.

#### Scenario: Startup does not start commands
- **WHEN** Veydr starts, including after a crash or with previously running commands recorded
- **THEN** no configured command is started

### Requirement: Explicit unsupported-platform behavior
On an operating system whose platform implementation is not available, every platform-dependent operation SHALL fail with an explicit "unsupported on this platform" error instead of attempting partial behavior.

#### Scenario: Unsupported platform operation
- **WHEN** a platform-dependent operation is requested on an operating system without an implementation
- **THEN** the operation returns an unsupported-platform error
- **AND** the user interface displays that the feature is not available on this platform

### Requirement: Local-only operation
The application SHALL function fully without network access and SHALL NOT send telemetry, analytics, crash reports, or any other data to remote services.

#### Scenario: Offline operation
- **WHEN** Veydr runs with no network connectivity
- **THEN** all features operate normally

#### Scenario: No outbound connections
- **WHEN** Veydr is used through a full session of registering a project, starting and stopping a command, and viewing logs and ports
- **THEN** the Veydr application itself opens no outbound network connections

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
