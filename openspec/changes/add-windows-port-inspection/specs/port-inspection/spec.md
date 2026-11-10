# Spec Delta

## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Read-only inspection
Port inspection SHALL NOT terminate, signal, or otherwise modify any process other than Veydr's own helper, and SHALL NOT open network connections. On Windows, port inspection SHALL start only that helper, which SHALL open other processes for querying information only; Veydr MAY end the helper, and only when it exceeds its time or output limit.

#### Scenario: No actions on unrelated processes
- **WHEN** the user views ports owned by unmanaged processes
- **THEN** no action to stop or signal those processes is offered

#### Scenario: Windows inspection queries only
- **WHEN** Veydr lists ports on Windows
- **THEN** the only process it starts is its own helper, which opens other processes for querying information only and starts, signals, or ends none of them

## REMOVED Requirements

### Requirement: Windows port inspection not yet supported
**Reason**: Port inspection is now implemented on Windows and verified on the native Windows runner, which is the condition this requirement set for lifting it.
**Migration**: Replaced by "Windows port inspection in preview". The "Ports on Windows" scenario no longer applies: the Ports view on Windows lists ports. The "not yet available" message remains only for platforms without an implementation.
