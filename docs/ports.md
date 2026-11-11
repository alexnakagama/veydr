# Ports (listening network ports)

The **Ports** view lists the TCP ports on which processes listen, and which of them belong to your commands. It only reads information; it never stops, signals, or connects to anything. On Windows, which is a preview, the view works the same way, through Veydr's own helper; the differences are in [Windows (preview)](#windows-preview).

## What is shown

- **TCP sockets in the listening state**, IPv4 and IPv6 (including dual-stack `::` and IPv4-mapped addresses such as `::ffff:127.0.0.1`), each with its port, local address, and the process holding it.
- Only sockets of the network namespace Veydr runs in. Ports published by containers (Docker, Podman) appear only as far as a process in this namespace listens on them, typically a proxy owned by root (shown as restricted, see below).
- Not shown: UDP sockets, outgoing or accepted connections, Unix domain sockets.

The view has two lists:

| List | Contents |
|---|---|
| **Commands** | Ports held by a process of a running command, with the command (`project › command`), address, process name, and PID. |
| **All listening ports** | Every listening port visible to you, including those of processes Veydr did not start. A port of a running command is listed here too; any other port is marked **Not managed**. |

## Which command a port belongs to

A port belongs to a command if a process holding the socket belongs to the command's current run, by the same rule Veydr uses to stop it (see [Which processes belong to a command](processes.md#which-processes-belong-to-a-command)): the processes in the command's session plus descendants Veydr has observed, including children and grandchildren that started their own process group or session while their parent was still running. Processes are matched by PID and start time, so a PID reused by an unrelated process never makes a port look managed. The run's processes are read again each time the list is refreshed, so a port opened by a just-started descendant is attributed at once.

When several processes hold the same socket (for example a server that passed it to its workers), the view shows the holder that belongs to a command; otherwise the oldest holder.

## Owners: known, restricted, unknown

| Shown as | Meaning |
|---|---|
| Process name and PID | Veydr could see which process holds the socket. |
| **Restricted** | The port belongs to another user or to the system, and Linux does not show you which process holds it. |
| **Unknown** | The holder could not be determined for another reason, for example because it exited between the reads, or the open files of a process could not be read because of an error. |

**Restricted** is not an error and not an absent owner: Linux only shows a process's open files to its own user (and to root). A port is shown as restricted when

- the socket was created by another user (for example a system service such as the print service on port 631, or a container proxy running as root), or
- it is a socket of your own user whose holder was not found, and the open files of one of your own processes could not be read for lack of permission (a process that is not dumpable, such as some agents, or a setuid program you started): the holder may be that process. Other users' processes, which can never be read, do not count here.

When Veydr runs as root, it can read every process, so a socket without holder is shown as unknown whoever created it. Veydr does not ask for higher privileges to find out more.

## Refreshing

The list is read when you open the view, when you press **Refresh**, and every 3 seconds while the view is open and the window is visible (not minimized or hidden). Nothing is read while another view is shown. Requests never overlap: a refresh requested during a read follows right after it. The view shows the time of the last refresh; if a refresh fails, the previous list stays visible with the error above it.

## Read-only

The view offers no action on any process: no stop, no signal, no link to a process. On Linux, port inspection only reads files below `/proc`; it starts no program, sends no signal, and opens no network connection. On Windows it starts one program, Veydr's own helper (see [Windows (preview)](#windows-preview)), which opens other processes for querying information only; Veydr ends that helper only when it exceeds its time or output limit (10 seconds, 16 MiB). A unit test checks that the port-inspection code cannot reach any signalling or process-starting code and imports no network module, that the Windows inspector is given nothing but a reader that runs the helper's `ports` subcommand, and, in the helper's C# source, that `ports` asks for no access right other than querying limited information and calls nothing that starts, signals or ends a process (`test/unit/port-service.test.ts`). To stop a command, use the command's own Stop button in **Projects**.

## How it works

Veydr first reads the listening rows of `/proc/net/tcp` and `/proc/net/tcp6`, then the `socket:[inode]` links in `/proc/<pid>/fd` of every process, to find which process holds each socket; the name of a holder comes from its command line. In this order a socket in the tables was already open when the links were read, so a port a command has just opened is never shown without its holder. Whether an unreadable process could be your own is read from its `/proc/<pid>/status`, and only when one of your sockets has no holder. No external tool (such as `ss`, `lsof`, or `netstat`) is used.

A listing with 1,000 listening sockets of one process took a median of 58 ms on the development machine when run alone, and 69–71 ms while the other integration tests ran in parallel (Debian 13, 12 CPU threads, about 5,000 open files in total; threshold 100 ms, `test/integration/linux-ports.test.ts`). The whole request, which also reads the processes of running commands, took a median of 73 ms alone and 99–109 ms under that load.

## Limitations

- **Escaped descendants.** A descendant that starts its own session and whose parent exits before Veydr observed it is not attributed to the command (see [Escaped descendants](processes.md#escaped-descendants)); its port is listed as not managed.
- **Restricted owners** cannot be resolved without privileges (see above).
- **Snapshot.** The list shows the state at the refresh time; a port opened or closed since appears at the next refresh.
- **Windows** is a preview, with the limits in [Windows (preview)](#windows-preview).

## Windows (preview)

**Windows: preview. Run from source; verified in CI on Windows Server 2025. No Windows package yet.** The Ports view lists the same sockets as on Linux, IPv4 and IPv6, with the same two lists, owners, refresh, and attribution: a port belongs to a command when its holder is one of the command's processes, which on Windows are the processes in the command's Job Object (see [processes.md](processes.md#containment)). Processes are matched by PID and creation time.

### How Windows ports are read

Each listing runs `veydr-helper.exe ports`, the helper that also runs commands (see [dependencies.md](dependencies.md)), once, and reads the one line it prints. The helper:

1. notes the time, then reads the listening TCP tables, IPv4 and IPv6 (`GetExtendedTcpTable`), each with the PID of the process that holds the socket;
2. opens each holder for querying limited information only (`PROCESS_QUERY_LIMITED_INFORMATION`), and reads whether it is still running, its creation time, and its executable's path, whose file name the view shows;
3. exits. It reads nothing on its standard input, starts no process, and signals or ends none.

**The time fence.** A holder could exit after the tables were read, and its PID be given to a new process before the helper opens it. A holder that was created after the tables were read, or less than 20 milliseconds before, is therefore never shown as the port's owner: the port's owner is **Unknown** for that refresh. The 20 milliseconds cover the coarser clock Windows may use for a process's creation time (one timer tick, about 15.6 ms). So a listener started less than 20 milliseconds before a refresh is shown as unknown once, and correctly at the next refresh. A change of the system clock backwards by more than 20 milliseconds within the few milliseconds of one listing, together with a PID reused in that same moment, could still show the new process as the holder for one refresh.

**Restricted.** On Windows a port's owner is **Restricted** when Windows denies Veydr's user access to its holder, which is what the restricted owner means on Linux too. For a standard user, this is the case for system services and other processes whose security settings admit only the system or administrators. Unlike on Linux, a standard user can usually query the processes of another ordinary account whose processes keep Windows' default security settings, and then sees their name and PID. An administrator, which is how CI runs Veydr, can query almost every process and sees few restricted owners.

**Unknown.** A holder that exited before the helper opened it, one created inside the time fence, PID 0 (a socket Windows reports without a holder), and a holder that could not be queried for another reason are shown as **Unknown**. Other failures are counted in the diagnostic log (`ports.owner-errors`), once per listing.

**Failures.** If the helper is missing, speaks another protocol version, exits with an error, takes longer than 10 seconds, or prints a line that does not follow the protocol, the listing fails as a whole: the view keeps the previous list, with the error above it, as on Linux when the tables cannot be read. A machine without an IPv6 stack also fails the listing.

**IPv6 scope.** As on Linux, the scope of a link-local IPv6 address (`fe80::1%3`) is not shown, so two such sockets on the same port, one per network interface, look alike.

**Speed.** The helper is started anew for each listing, every 3 seconds while the view is open. With 1,045 listening sockets on the runner (1,000 of one process), a listing, the helper's start included, took a median of 64–67 ms in the CI checks of 2026-11-10 (Windows Server 2025, threshold 500 ms, `test/integration/windows-ports.test.ts`). The helper is not signed yet, so antivirus software may scan it at each start and slow the listing down (see [deferred-checks.md](deferred-checks.md#windows-process-supervision-2026-11-06)).

### Verified on the CI runner, and what is not

The integration tests run on GitHub's `windows-2025` runner for every pull request and push to `master`, and have passed there (2026-11-10): the listing of a command's port and of a grandchild's port, of an unmanaged listener on `127.0.0.1` and on `::1`, the 1,000-socket timing, and the helper's `ports` run as a standard user created for the test, where a holder that denies that user access is shown as restricted (`test/integration/windows-ports.test.ts`). The end-to-end tests of the Ports view (`test/e2e/ports.spec.ts`) are portable since W3 and are part of the same job's end-to-end step.

The runner cannot show:

- **a real PID reuse** between the table read and the owner read, which cannot be forced. The time fence is checked by reading the helper's source and by the tests' holders, which are shown as known only when they are older than the fence;
- Veydr itself running as a standard user on a desktop: only the helper's `ports` is run as a standard user in CI;
- the conditions listed in [processes.md](processes.md#not-verified-on-the-ci-runner), such as a localized Windows or third-party antivirus.
