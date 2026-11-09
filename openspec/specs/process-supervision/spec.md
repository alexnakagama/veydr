# process-supervision Specification

## Purpose

Defines how Veydr starts, tracks, stops, and restarts configured commands as process trees, how it behaves when the application quits or crashes, and the limits of its termination guarantees per platform.

## Requirements

### Requirement: Explicit lifecycle actions
Users SHALL be able to start, stop, and restart each configured command individually. Each action SHALL apply only to the command it was requested for.

#### Scenario: Start a command
- **WHEN** the user starts an idle command whose project directory exists
- **THEN** the command's process is started in its working directory with its effective environment

#### Scenario: Restart a running command
- **WHEN** the user restarts a running command
- **THEN** the current run is stopped completely before a new run is started

### Requirement: Observable process state
Each command SHALL expose a state of `idle`, `starting`, `running`, `stopping`, `exited`, or `failed`, plus the PID and start time while running and the exit code or terminating signal after it ends.

#### Scenario: Running state details
- **WHEN** a command is running
- **THEN** its state, PID, and uptime are displayed

#### Scenario: Exit details
- **WHEN** a command's process ends
- **THEN** its state becomes `exited` with the exit code or signal and whether Veydr forced termination

### Requirement: Start failures reported
If a command cannot be started, its state SHALL become `failed` with a human-readable reason, and no partial process SHALL remain.

#### Scenario: Spawn error
- **WHEN** the executable does not exist, is not executable, or the working directory is missing
- **THEN** the command enters `failed` with the specific reason

### Requirement: No automatic restart
A command that exits on its own SHALL remain in `exited` and SHALL NOT be restarted automatically.

#### Scenario: Unexpected exit
- **WHEN** a running command's process exits without a user stop request
- **THEN** the command shows `exited` with its exit details and is not restarted

### Requirement: Safe handling of repeated actions
Lifecycle actions on the same command SHALL be processed one at a time. Repeated or overlapping actions SHALL NOT create duplicate runs or leave the command in an inconsistent state.

#### Scenario: Duplicate start
- **WHEN** start is requested for a command that is `starting` or `running`
- **THEN** no second process is created and the current run is reported

#### Scenario: Stop during stop
- **WHEN** stop is requested for a command that is already `stopping`
- **THEN** the request completes when the in-progress stop completes

#### Scenario: Late events ignored
- **WHEN** output or exit events from a previous run arrive after a new run has started
- **THEN** they are not attributed to the new run

### Requirement: Graceful then forced stop
Stopping a command SHALL first request graceful termination of its process tree and SHALL force termination if any attributed process remains after the command's stop timeout. The default stop timeout SHALL be 5 seconds and SHALL be configurable per command.

#### Scenario: Cooperative process
- **WHEN** a command whose processes exit on a termination request is stopped
- **THEN** all its processes end within the stop timeout and the result is reported as graceful

#### Scenario: Uncooperative process
- **WHEN** a command whose processes ignore the termination request is stopped
- **THEN** remaining processes are forcibly terminated after the stop timeout and the result is reported as forced

### Requirement: Linux process-tree termination
On Linux, each command SHALL run in its own process group. Stopping SHALL signal the whole group and every descendant Veydr has observed outside it, after verifying each is still the same process.

#### Scenario: Children and grandchildren stopped
- **WHEN** a command that spawned children and grandchildren in its process group is stopped on Linux
- **THEN** no process from that tree remains after the stop completes

#### Scenario: Observed escaped descendant stopped
- **WHEN** a descendant of the command observed by Veydr has moved to another process group or session
- **THEN** stopping the command also terminates that descendant after verifying its identity

### Requirement: Survivors reported
When a stop completes and Veydr knows of any attributed process still running, it SHALL report those processes to the user. Veydr SHALL NOT claim a clean stop when it cannot verify one.

#### Scenario: Process could not be terminated
- **WHEN** an attributed process is still alive after forced termination
- **THEN** the stop result lists the surviving PID and command name to the user

### Requirement: Never terminate unrelated processes
Veydr SHALL only send termination signals to processes it started or observed as descendants of them, and SHALL verify process identity (not only PID) before signalling any process other than an unreaped direct child.

#### Scenario: PID reused by unrelated process
- **WHEN** a recorded PID now belongs to a different process
- **THEN** Veydr does not signal it

#### Scenario: Unrelated process untouched
- **WHEN** commands are started and stopped while unrelated user processes run
- **THEN** no unrelated process receives a signal from Veydr

### Requirement: Output does not block processes
Veydr SHALL continuously consume each process's output so that a slow or hidden user interface never causes a managed process to block on writing output. Standard input SHALL NOT be connected.

#### Scenario: High-volume output
- **WHEN** a process writes output faster than the user interface displays it
- **THEN** the process is not slowed by Veydr's output handling beyond a documented throughput tolerance

### Requirement: Stop all on quit
When the user quits Veydr, it SHALL stop all running commands, show progress while doing so, and report any command it could not stop. Managed processes SHALL NOT intentionally outlive Veydr.

#### Scenario: Quit with running commands
- **WHEN** the user quits while commands are running
- **THEN** Veydr stops every command using its stop behavior before exiting

#### Scenario: Stop failures on quit
- **WHEN** one or more commands cannot be verified as stopped during quit
- **THEN** Veydr lists them and lets the user retry or quit anyway

### Requirement: Crash recovery
Veydr SHALL record each running process tree durably. On launch after an abnormal exit, it SHALL detect recorded processes that are still running, verify their identity, show them to the user, and offer to terminate them. It SHALL NOT restart them.

#### Scenario: Survivors after crash
- **WHEN** Veydr starts after a crash while processes it started are still running
- **THEN** the user is shown those processes and can terminate them

#### Scenario: Stale record ignored
- **WHEN** a recorded PID now belongs to a different process
- **THEN** it is not shown as a survivor and is never signalled

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

### Requirement: Documented crash limitation
Veydr SHALL document that on Linux, processes it started can continue running after an abnormal exit until Veydr is started again, and that descendants that leave the process group before Veydr observes them may not be tracked. It SHALL also document the Windows behavior: an abnormal exit ends the command trees, and what the CI runner could not verify (a desktop session, logoff and shutdown, a parent outside any Job Object).

#### Scenario: Limitation documented
- **WHEN** the user reads the process-management documentation
- **THEN** the crash and escaped-descendant limitations are stated

#### Scenario: Windows limitations documented
- **WHEN** the user reads the process-management documentation
- **THEN** the Windows crash behavior and the conditions not verified on Windows are stated, labelled as part of the Windows preview

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
