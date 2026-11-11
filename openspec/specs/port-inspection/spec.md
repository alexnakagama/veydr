# port-inspection Specification

## Purpose

Defines read-only reporting of listening network ports, attributing them to Veydr-managed commands where possible and clearly representing information the operating system does not make available.

## Requirements

### Requirement: Ports of managed commands
Veydr SHALL show the TCP ports on which processes belonging to a running command are listening, together with the listening address and the owning PID.

#### Scenario: Dev server port shown
- **WHEN** a running command's process listens on a TCP port
- **THEN** that port is displayed with the command it belongs to

#### Scenario: Port opened by a child process
- **WHEN** a descendant of a command's process listens on a TCP port
- **THEN** the port is attributed to that command

### Requirement: All listening ports view
Veydr SHALL list all TCP listening ports visible to the current user, including those not owned by managed commands, identifying the owning process where the operating system permits.

#### Scenario: Unmanaged listener owned by user
- **WHEN** a process not started by Veydr but owned by the current user listens on a port
- **THEN** the port is listed with that process's PID and name and marked as not managed

### Requirement: Restricted information represented explicitly
When the owner of a listening port cannot be determined because of permissions, Veydr SHALL list the port with its owner shown as restricted, distinct from an error or an absent owner.

#### Scenario: Port owned by another user
- **WHEN** a port is held by a process belonging to another user or the system
- **THEN** the port is listed with its owner marked as restricted

### Requirement: Read-only inspection
Port inspection SHALL NOT terminate, signal, or otherwise modify any process other than Veydr's own helper, and SHALL NOT open network connections. On Windows, port inspection SHALL start only that helper, which SHALL open other processes for querying information only; Veydr MAY end the helper, and only when it exceeds its time or output limit.

#### Scenario: No actions on unrelated processes
- **WHEN** the user views ports owned by unmanaged processes
- **THEN** no action to stop or signal those processes is offered

#### Scenario: Windows inspection queries only
- **WHEN** Veydr lists ports on Windows
- **THEN** the only process it starts is its own helper, which opens other processes for querying information only and starts, signals, or ends none of them

### Requirement: On-demand refresh
Port information SHALL be refreshed when the user opens or refreshes the ports view and periodically while the view is visible, and SHALL show when it was last refreshed.

#### Scenario: Refresh
- **WHEN** the user refreshes the ports view
- **THEN** the list reflects current listening sockets and shows the refresh time

### Requirement: Windows port inspection in preview
On Windows, Veydr SHALL list the listening TCP sockets, IPv4 and IPv6, with their owning process, and SHALL attribute a port to a command by the owner's PID and creation time, as part of the Windows preview. A holder whose PID was reused after the sockets were read SHALL NOT be shown as the port's owner. This behavior SHALL be verified on native Windows for every pull request and push to `master`.

#### Scenario: Command port shown on Windows
- **WHEN** on Windows a running command, or a descendant of it, listens on a TCP port
- **THEN** the Ports view shows that port with its address, the owning PID and process name, and the command it belongs to

#### Scenario: Unmanaged listener on Windows
- **WHEN** on Windows a process that Veydr did not start, and that Veydr can query, listens on a TCP port
- **THEN** the port is listed with that process's PID and name and marked as not managed

#### Scenario: Reused PID not shown as owner
- **WHEN** the process that held a listening socket exits after the sockets were read, and a new process gets its PID before the owner is read
- **THEN** the port's owner is shown as unknown, never as the new process

#### Scenario: Owner hidden from a standard user on Windows
- **WHEN** Veydr runs as a standard user on Windows and a port is held by a process the user cannot query, such as a system service
- **THEN** the port is listed with its owner marked as restricted

#### Scenario: Windows port inspection verified natively
- **WHEN** the checks run for a pull request or a push to `master`
- **THEN** the Windows port-inspection scenarios run on a native Windows runner, including the restricted owner as a standard user
