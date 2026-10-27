## MODIFIED Requirements

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

### Requirement: Effective environment
A started command SHALL receive the user's login environment, with Veydr's own runtime variables removed and the command's overrides applied. The resolved environment SHALL be viewable with secret values masked. Variable names SHALL be matched according to the operating system's rule: exactly on Linux, and without regard to letter case on Windows.

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
