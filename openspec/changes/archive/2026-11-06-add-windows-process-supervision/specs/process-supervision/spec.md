# Spec Delta

## ADDED Requirements

### Requirement: Windows process-tree termination
On Windows, each command SHALL run in its own containment that includes every process it starts, from its first instruction on. Stopping SHALL end every process in that containment. A process the command started SHALL NOT be able to leave the containment.

#### Scenario: Children and grandchildren stopped on Windows
- **WHEN** a command that started children and grandchildren is stopped on Windows
- **THEN** no process from that tree remains after the stop completes

#### Scenario: Orphaned descendant stopped on Windows
- **WHEN** a command's child has exited while its own child (the command's grandchild) keeps running
- **THEN** stopping the command also ends that grandchild

#### Scenario: Descendant started immediately
- **WHEN** a command starts a child as its very first action on Windows
- **THEN** the child is part of the command's containment and ends when the command is stopped

### Requirement: Windows graceful stop
On Windows, the graceful termination request SHALL be a Ctrl+Break console event delivered to the command's processes, and SHALL be sent without showing a console window and without affecting Veydr's own process. Commands, including batch files, SHALL be started with a hidden console so that the request can reach them.

#### Scenario: Cooperative process on Windows
- **WHEN** a command whose processes exit on Ctrl+Break is stopped on Windows
- **THEN** all its processes end within the stop timeout, the result is reported as graceful, and no console window is shown

#### Scenario: Batch-file command stopped gracefully
- **WHEN** a command started through a batch file (such as `npm.cmd`) is stopped on Windows
- **THEN** the request reaches the program the batch file started, and the stop does not wait for a "Terminate batch job" answer

#### Scenario: Uncooperative process on Windows
- **WHEN** a command whose processes ignore Ctrl+Break is stopped on Windows
- **THEN** every process in its containment is forcibly ended after the stop timeout and the result is reported as forced

### Requirement: Windows process identity
On Windows, a process SHALL be identified by its PID together with its creation time. Before ending a process that is not inside a running command's containment, Veydr SHALL verify that both still match the recorded process.

#### Scenario: Reused PID on Windows
- **WHEN** a recorded PID on Windows now belongs to a process with a different creation time
- **THEN** that process is not shown as a survivor and is never ended

### Requirement: Windows command trees end on abnormal exit
On Windows, when Veydr or its process-tree helper ends abnormally, every process still in a command's containment SHALL be ended by the operating system. The run ledger SHALL still be written, so that any process found alive at the next launch is shown through crash recovery.

#### Scenario: Veydr ends abnormally on Windows
- **WHEN** Veydr's process is forcibly terminated on Windows while a command tree is running
- **THEN** no process of that tree remains, and the next launch shows no survivors for that run

#### Scenario: Helper ends abnormally on Windows
- **WHEN** the process-tree helper of a running command is forcibly terminated on Windows while Veydr keeps running
- **THEN** no process of that command's tree remains, and the run ends as an unverified stop

## MODIFIED Requirements

### Requirement: Documented crash limitation
Veydr SHALL document that on Linux, processes it started can continue running after an abnormal exit until Veydr is started again, and that descendants that leave the process group before Veydr observes them may not be tracked. It SHALL also document the Windows behavior: an abnormal exit ends the command trees, and what the CI runner could not verify (a desktop session, logoff and shutdown, a parent outside any Job Object).

#### Scenario: Limitation documented
- **WHEN** the user reads the process-management documentation
- **THEN** the crash and escaped-descendant limitations are stated

#### Scenario: Windows limitations documented
- **WHEN** the user reads the process-management documentation
- **THEN** the Windows crash behavior and the conditions not verified on Windows are stated, labelled as not yet reachable from the app

### Requirement: Windows supervision not yet supported
Until commands and their environment are implemented and verified on native Windows, starting a command on Windows SHALL fail with an unsupported-platform error and SHALL NOT create any process. The process-tree behavior required for Windows SHALL be verified on native Windows before that requirement is lifted.

#### Scenario: Start on Windows
- **WHEN** a command is started on Windows in this release
- **THEN** the start fails with an unsupported-platform error and no process is created

#### Scenario: Windows process trees verified natively
- **WHEN** the checks run for a pull request or a push to `master`
- **THEN** the Windows process-tree scenarios run on a native Windows runner, not only on Linux
