# project-registry Specification

## Purpose

Defines how users register local project folders and configure the commands Veydr can run for them, including execution mode, working directory, environment overrides, and opening a project in the file manager or a configured editor.

## Requirements

### Requirement: Register a project folder
Users SHALL be able to register an existing local directory as a project with a display name. The same directory SHALL NOT be registered twice.

#### Scenario: Register valid folder
- **WHEN** the user selects an existing directory and confirms a project name
- **THEN** the project appears in the project list and is persisted

#### Scenario: Reject non-directory
- **WHEN** the user attempts to register a path that does not exist or is not a directory
- **THEN** registration is rejected with an explanation

#### Scenario: Reject duplicate
- **WHEN** the user registers a directory that resolves to the same location as an existing project
- **THEN** registration is rejected and the existing project is identified

### Requirement: Remove a project
Users SHALL be able to remove a project from Veydr after confirming. Removal SHALL NOT delete or modify any files on disk. A project with running commands SHALL NOT be removed until they are stopped.

#### Scenario: Remove idle project
- **WHEN** the user removes a project with no running commands and confirms
- **THEN** the project and its command configuration are removed from Veydr
- **AND** the project directory and its contents are unchanged

#### Scenario: Remove project with running commands
- **WHEN** the user attempts to remove a project that has running commands
- **THEN** Veydr requires the commands to be stopped first

### Requirement: Missing or moved project directories
Veydr SHALL detect when a registered project's directory no longer exists and SHALL show the project as missing, disable starting its commands, and allow the user to relocate it to a new directory.

#### Scenario: Directory missing
- **WHEN** a registered project's directory does not exist
- **THEN** the project is shown as missing and its commands cannot be started

#### Scenario: Relocate project
- **WHEN** the user relocates a missing project to an existing directory
- **THEN** the project's path is updated and its commands become startable again

### Requirement: Configure commands
Each project SHALL support zero or more named commands. Each command SHALL have an execution mode, a working directory relative to the project root (default: the root), environment overrides, and a stop timeout.

#### Scenario: Multiple commands
- **WHEN** the user adds an API server, a frontend dev server, and a worker command to one project
- **THEN** all three are listed and can be started and stopped independently

#### Scenario: Working directory outside project rejected
- **WHEN** the user sets a working directory that resolves outside the project directory
- **THEN** the command is rejected with an explanation

### Requirement: Direct execution mode
Direct mode SHALL run a named executable with an explicit argument list, without any shell interpretation, and SHALL be the default mode.

#### Scenario: Arguments passed literally
- **WHEN** a direct-mode command has arguments containing spaces, quotes, `$`, `;`, `&`, `|`, or `*`
- **THEN** the executable receives exactly those arguments with no expansion, splitting, or substitution

#### Scenario: Executable not found
- **WHEN** a direct-mode executable cannot be found on the effective `PATH` or at the given path
- **THEN** the start fails with an error naming the executable

### Requirement: Explicit shell mode
Shell mode SHALL run a script string through an explicitly identified shell. The user interface SHALL visibly label shell-mode commands and SHALL show which shell will interpret them.

#### Scenario: Shell mode labelled
- **WHEN** a command is configured in shell mode
- **THEN** the command list and editor show it as a shell command along with the shell used

### Requirement: Effective environment
A started command SHALL receive the user's login environment, with Veydr's own runtime variables removed and the command's overrides applied. The resolved environment SHALL be viewable with secret values masked.

#### Scenario: Desktop launch resolves login PATH
- **WHEN** Veydr was started from the desktop launcher and the user's login shell configuration adds directories to `PATH`
- **THEN** started commands receive the `PATH` from the login shell

#### Scenario: Login shell resolution fails
- **WHEN** resolving the login environment fails or exceeds its timeout
- **THEN** Veydr uses its own inherited environment minus runtime variables and shows a warning

#### Scenario: Runtime variables not leaked
- **WHEN** a command is started
- **THEN** its environment contains no Electron- or packaging-runtime variables injected by Veydr itself

#### Scenario: Override applied
- **WHEN** a command defines an environment override for a variable that also exists in the login environment
- **THEN** the started process receives the override value

### Requirement: Secret environment values masked
Environment values marked secret SHALL be masked wherever displayed in the user interface unless the user explicitly reveals them for that field.

#### Scenario: Secret masked by default
- **WHEN** a command with a secret environment value is viewed
- **THEN** the value is masked until the user chooses to reveal it

### Requirement: Open project folder
Users SHALL be able to open a project's directory in the system file manager. Only paths verified to be directories SHALL be opened.

#### Scenario: Open existing folder
- **WHEN** the user chooses to open an existing project's folder
- **THEN** the system file manager opens that directory

#### Scenario: Path is not a directory
- **WHEN** the stored project path is missing or not a directory at the moment of opening
- **THEN** nothing is opened and the user is told why

### Requirement: Open in configured editor
Users SHALL be able to configure an editor as an executable with an argument template containing the project path placeholder. Launching the editor SHALL NOT use a shell, and the editor SHALL NOT be supervised or stopped by Veydr.

#### Scenario: Launch editor
- **WHEN** an editor is configured and the user chooses to open a project in it
- **THEN** the editor executable is started with the template arguments and the project path substituted as a single argument

#### Scenario: Editor survives Veydr quit
- **WHEN** Veydr quits after launching an editor
- **THEN** the editor process is not terminated by Veydr
