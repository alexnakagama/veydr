# project-registry Specification

## Purpose

Defines how users register local project folders and configure the commands Veydr can run for them, including execution mode, working directory, environment overrides, and opening a project in the file manager or a configured editor.

## Requirements

### Requirement: Register a project folder
Users SHALL be able to register an existing local directory as a project with a display name. The same directory SHALL NOT be registered twice. Windows paths (with a drive letter or a UNC prefix) SHALL be compared without regard to letter case when deciding whether a directory is already registered; other paths SHALL be compared exactly.

#### Scenario: Register valid folder
- **WHEN** the user selects an existing directory and confirms a project name
- **THEN** the project appears in the project list and is persisted

#### Scenario: Reject non-directory
- **WHEN** the user attempts to register a path that does not exist or is not a directory
- **THEN** registration is rejected with an explanation

#### Scenario: Reject duplicate
- **WHEN** the user registers a directory that resolves to the same location as an existing project
- **THEN** registration is rejected and the existing project is identified

#### Scenario: Windows path differing only in case
- **WHEN** a project is registered at `C:\Work\Shop` and the user registers `c:\work\shop`
- **THEN** registration is rejected as a duplicate

#### Scenario: POSIX path differing only in case
- **WHEN** a project is registered at `/home/dev/Shop` and the user registers the existing, distinct directory `/home/dev/shop`
- **THEN** both are registered as separate projects

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
Direct mode SHALL run a named executable with an explicit argument list, without any shell interpretation, and SHALL be the default mode. On Windows, a batch file can only run under `cmd.exe`, so a direct-mode batch file SHALL be started through `cmd.exe` by the Windows batch-file argument rules; that is the one case in which direct mode involves a shell.

#### Scenario: Arguments passed literally
- **WHEN** a direct-mode command has arguments containing spaces, quotes, `$`, `;`, `&`, `|`, or `*`
- **THEN** the executable (or, for a Windows batch file, the program it forwards its arguments to with `%*`) receives exactly those arguments with no expansion, splitting, or substitution

#### Scenario: Executable not found
- **WHEN** a direct-mode executable cannot be found on the effective `PATH` or at the given path
- **THEN** the start fails with an error naming the executable

### Requirement: Explicit shell mode
Shell mode SHALL run a script string through an explicitly identified shell. The user interface SHALL visibly label shell-mode commands and SHALL show which shell will interpret them.

#### Scenario: Shell mode labelled
- **WHEN** a command is configured in shell mode
- **THEN** the command list and editor show it as a shell command along with the shell used

### Requirement: Effective environment
A started command SHALL receive the user's login environment, with Veydr's own runtime variables removed and the command's overrides applied. On Windows the login environment SHALL be the environment Veydr itself was started with, and variables whose names differ only in letter case SHALL be merged into one before the command starts. The resolved environment SHALL be viewable with secret values masked. Variable names SHALL be matched according to the operating system's rule: exactly on Linux, and without regard to letter case on Windows.

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

#### Scenario: Override differing in case on Windows
- **WHEN** on Windows the base environment contains `Path` and a command defines an override `PATH`
- **THEN** the effective environment and its preview contain one entry for that variable, with the override's value and name

#### Scenario: Override differing in case on Linux
- **WHEN** on Linux the base environment contains `Path` and a command defines an override `PATH`
- **THEN** the effective environment and its preview contain both variables

#### Scenario: Overrides differing only in case rejected on Windows
- **WHEN** on Windows the user saves a command with overrides `NODE_ENV` and `node_env`
- **THEN** the command is rejected with an error naming the duplicate variable and nothing is saved

#### Scenario: Windows base environment
- **WHEN** on Windows a command is started or its environment is previewed
- **THEN** the base environment is Veydr's own environment without runtime variables, with exactly one entry for each variable regardless of letter case, and a started command sees exactly one `PATH`

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
Users SHALL be able to configure an editor as an executable with an argument template containing the project path placeholder. Launching the editor SHALL NOT use a shell, except that on Windows an editor that is a batch file SHALL be started through `cmd.exe` by the Windows batch-file argument rules. The editor SHALL NOT be supervised or stopped by Veydr. On Windows, launching it SHALL NOT create a new console window.

#### Scenario: Launch editor
- **WHEN** an editor is configured and the user chooses to open a project in it
- **THEN** the editor executable is started with the template arguments and the project path substituted as a single argument

#### Scenario: Editor survives Veydr quit
- **WHEN** Veydr quits after launching an editor
- **THEN** the editor process is not terminated by Veydr

#### Scenario: Batch-file editor on Windows
- **WHEN** on Windows the configured editor is a batch file such as `code.cmd` and the project path contains spaces, `&` or `^`
- **THEN** the program the batch file starts receives the project path as a single unchanged argument, no other command runs, and no new console window appears

### Requirement: Windows program lookup
On Windows, a program given by name SHALL be found in the effective `PATH` directories, in order, with the effective `PATHEXT` extensions, and never in the working directory. A relative path SHALL be resolved against the working directory; a drive-relative or root-relative path SHALL be refused. Only `.exe`, `.com`, `.bat` and `.cmd` files SHALL be started; a first match of another type SHALL be refused, not skipped.

#### Scenario: Program found through PATHEXT
- **WHEN** on Windows a direct-mode command names `npm` and the effective `PATH` holds a directory with `npm.cmd`
- **THEN** the command starts `npm.cmd` from that directory

#### Scenario: Working directory not searched
- **WHEN** on Windows a direct-mode command names a program that exists in the working directory but in no directory of the effective `PATH`
- **THEN** the start fails with an error naming the program, and nothing from the working directory is started

#### Scenario: Unsupported program type refused
- **WHEN** on Windows a direct-mode command resolves to a file of another type, such as `.js`, `.vbs` or `.ps1`
- **THEN** the start fails with an error naming the file and the accepted types, and no process is created

#### Scenario: Drive-relative program path refused
- **WHEN** on Windows a direct-mode command names a program as `C:tool.exe` or `\tools\tool.exe`
- **THEN** the start fails with an error asking for a full path or a path relative to the working directory, and no process is created

### Requirement: Windows batch-file arguments
On Windows, a batch file SHALL be started through `cmd.exe` with AutoRun and delayed expansion off, and no part of its arguments SHALL run as a command. An argument of only ASCII letters, digits and `_ + - . : / \ @` SHALL reach the batch file as written; any other SHALL be quoted so that a program the batch file forwards it to with `%*` receives it unchanged. A line break, NUL, or a line too long for `cmd.exe` SHALL be refused before anything starts.

#### Scenario: Simple batch arguments reach the batch file as written
- **WHEN** on Windows a direct-mode command runs `build.bat release C:\out\` and the batch file tests `if "%1"=="release"` and uses `%~2`
- **THEN** the test is true, and `%~2` is `C:\out\`

#### Scenario: Shim arguments arrive unchanged
- **WHEN** on Windows a direct-mode command runs an `npm.cmd`-style shim with arguments containing spaces, quotes, `&`, `|`, `<`, `>`, `^`, `%`, `!`, or a trailing backslash
- **THEN** the program behind the shim receives exactly those arguments, and no injected command runs

#### Scenario: Unrepresentable argument refused
- **WHEN** on Windows a batch-file command has an argument containing a line break or NUL, or arguments longer than one `cmd.exe` command line can carry
- **THEN** the start fails with an error explaining the limit, and no process is created

### Requirement: Windows shell mode
On Windows, shell mode SHALL support `cmd.exe` only, given by its absolute path; the default shell SHALL be `cmd.exe` in the Windows system directory. The script SHALL be passed to `cmd.exe` unchanged, with AutoRun commands turned off. Another shell, an empty or blank script, a script containing a line break or NUL, or a command line longer than `cmd.exe` accepts SHALL be refused before anything starts.

#### Scenario: cmd.exe script runs
- **WHEN** on Windows a shell-mode command with the default shell runs a script using `&&` and `%VARIABLE%`
- **THEN** `cmd.exe` interprets the script, and the command's output shows its result

#### Scenario: Other shell refused on Windows
- **WHEN** on Windows a shell-mode command names a shell other than `cmd.exe`, such as `powershell.exe` or `bash.exe`
- **THEN** the start fails with an error naming the supported shell, and no process is created

#### Scenario: Multi-line script refused on Windows
- **WHEN** on Windows a shell-mode script contains a line break
- **THEN** the start fails with an error saying that `cmd.exe` runs one line, and no process is created
