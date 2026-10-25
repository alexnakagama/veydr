# Ports (listening network ports)

The **Ports** view lists the TCP ports on which processes listen, and which of them belong to your commands. It only reads information; it never stops, signals, or connects to anything. Veydr is Linux-only for now; on Windows the view says that port inspection is not yet available on this platform.

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

The view offers no action on any process: no stop, no signal, no link to a process. Port inspection only reads files below `/proc`; it starts no program, sends no signal, and opens no network connection. A unit test checks that the port-inspection code cannot reach any signalling or process-starting code and imports no network module (`test/unit/port-service.test.ts`). To stop a command, use the command's own Stop button in **Projects**.

## How it works

Veydr first reads the listening rows of `/proc/net/tcp` and `/proc/net/tcp6`, then the `socket:[inode]` links in `/proc/<pid>/fd` of every process, to find which process holds each socket; the name of a holder comes from its command line. In this order a socket in the tables was already open when the links were read, so a port a command has just opened is never shown without its holder. Whether an unreadable process could be your own is read from its `/proc/<pid>/status`, and only when one of your sockets has no holder. No external tool (such as `ss`, `lsof`, or `netstat`) is used.

A listing with 1,000 listening sockets of one process took a median of 58 ms on the development machine when run alone, and 69–71 ms while the other integration tests ran in parallel (Debian 13, 12 CPU threads, about 5,000 open files in total; threshold 100 ms, `test/integration/linux-ports.test.ts`). The whole request, which also reads the processes of running commands, took a median of 73 ms alone and 99–109 ms under that load.

## Limitations

- **Escaped descendants.** A descendant that starts its own session and whose parent exits before Veydr observed it is not attributed to the command (see [Escaped descendants](processes.md#escaped-descendants)); its port is listed as not managed.
- **Restricted owners** cannot be resolved without privileges (see above).
- **Snapshot.** The list shows the state at the refresh time; a port opened or closed since appears at the next refresh.
- **Windows** port inspection is not available in this release.
