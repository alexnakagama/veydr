# Spec Delta

## Purpose

Defines how Veydr starts, tracks, stops, and restarts configured commands as process trees, how it behaves when the application quits or crashes, and the limits of its termination guarantees per platform.

## ADDED Requirements

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

### Requirement: Documented crash limitation
Veydr SHALL document that on Linux, processes it started can continue running after an abnormal exit until Veydr is started again, and that descendants that leave the process group before Veydr observes them may not be tracked.

#### Scenario: Limitation documented
- **WHEN** the user reads the process-management documentation
- **THEN** the crash and escaped-descendant limitations are stated

### Requirement: Windows supervision not yet supported
Until a Windows implementation is verified on native Windows, process lifecycle operations on Windows SHALL fail with an unsupported-platform error.

#### Scenario: Start on Windows
- **WHEN** a command is started on Windows in this release
- **THEN** the start fails with an unsupported-platform error and no process is created
