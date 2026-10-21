# Spec Delta

## Purpose

Defines read-only reporting of listening network ports, attributing them to Veydr-managed commands where possible and clearly representing information the operating system does not make available.

## ADDED Requirements

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
Port inspection SHALL NOT terminate, signal, or otherwise modify any process, and SHALL NOT open network connections.

#### Scenario: No actions on unrelated processes
- **WHEN** the user views ports owned by unmanaged processes
- **THEN** no action to stop or signal those processes is offered

### Requirement: On-demand refresh
Port information SHALL be refreshed when the user opens or refreshes the ports view and periodically while the view is visible, and SHALL show when it was last refreshed.

#### Scenario: Refresh
- **WHEN** the user refreshes the ports view
- **THEN** the list reflects current listening sockets and shows the refresh time

### Requirement: Windows port inspection not yet supported
Until a Windows implementation is verified on native Windows, port inspection on Windows SHALL report an unsupported-platform error.

#### Scenario: Ports on Windows
- **WHEN** the ports view is opened on Windows in this release
- **THEN** it shows that port inspection is not yet available on this platform
