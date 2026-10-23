# Processes (Linux)

This page describes how Veydr starts, tracks, and stops the commands you configure, and what it cannot guarantee. Veydr is Linux-only for now; Windows is not yet supported.

## Starting

Veydr starts a command only when you press **Start** or **Restart** for it. Nothing is started automatically, and a command that exits on its own is never restarted.

- **Direct mode** runs the executable with its arguments exactly as configured; no shell interprets them. A name without `/` is looked up on `PATH`; a path containing `/` is relative to the working directory.
- **Shell mode** runs `<shell> -c <script>` with the shell you selected.
- Standard input is not connected (`/dev/null`). Standard output and error are always read, even when nobody looks at them, so a command never blocks on writing output.
- Each command runs in its own session and process group (its first process, the *leader*, has PID = process group ID = session ID). This keeps signals for the command away from Veydr and from everything else you run.

If a command cannot be started, it shows **Failed** with the reason, and no process is left behind:

| Reason shown | Cause |
|---|---|
| `Executable not found: <name> (searched PATH)` / `Executable not found: <path>` | No such executable. |
| `Permission denied: <path> is not executable` | The file exists but is not executable. |
| `Working directory does not exist: <path>` | The working directory is missing. |
| `Working directory is not a directory: <path>` | The working directory is a file. |
| `Working directory is not accessible: <path>` | No permission to enter the working directory. |

## States

| State | Meaning |
|---|---|
| Idle | Not started in this session. |
| Starting | Being started. |
| Running | Running; the leader's PID and the uptime are shown. |
| Stopping | Being stopped. |
| Exited | Ended. Shows the exit code, or the signal that terminated it, and whether Veydr had to force the stop. |
| Failed | Could not be started; the reason is shown. |

Start, stop, and restart requests for one command are handled one at a time, in order. Starting a command that is starting or running does not start a second copy. A stop requested while a stop is in progress finishes with it.

## Which processes belong to a command

A command's *processes* are:

1. every live process in the command's session, which includes every descendant that changed only its process group, and
2. every descendant Veydr has **observed**: Veydr reads `/proc` right after the start, every 2 seconds while the command runs, and when a stop begins, and remembers each descendant by PID and start time. A remembered descendant still belongs to the command after it starts its own session.

## Stopping

When you stop a command:

1. Veydr reads `/proc` once more, then sends `SIGTERM` to the command's process group, to the leader, and to every other process of the command.
2. It checks every 100 ms whether any process of the command is still alive. Processes that appear in the meantime also receive `SIGTERM`.
3. If processes are still alive after the command's **stop timeout** (5 seconds by default, configurable per command from 0 to 300 seconds), it sends `SIGKILL` to the same targets. The result is then reported as forced.
4. It waits up to 1 second more. Any process of the command still alive then is listed as **still running after the stop**, with its PID and name. Veydr never claims a clean stop it could not verify.

Before signalling any process other than the leader, Veydr re-reads that process's start time and skips it if the PID now belongs to a different process. The leader is signalled by PID alone only until Veydr has collected its exit status; until then its PID cannot be reused.

**Restart** stops the command completely and then starts it again. If processes survived the stop, the restart does not start a new run; the survivors are shown instead. **Start** is always available after a run has ended, also when survivors are listed: starting is your explicit decision, and the survivors stay listed until the next run replaces the state.

If Veydr cannot read `/proc` while stopping (for example because it ran out of file descriptors), it keeps signalling the processes it already knew, and the command ends as **Exited** with a message that the stop could not be verified, listing the processes last known to be alive.

**When the leader exits on its own**, anything it left running (for example a background server started by a script) is stopped the same way (the command shows **Stopping remaining processes…**, without a PID because the leader is gone), and the command then shows **Exited** with the leader's exit code. Nothing of a command keeps running after the command has ended.

Output of a run is read until every process holding its output pipes has closed them, also after the run has ended; it always stays attributed to the run that produced it.

## Limitations

### Escaped descendants

A descendant that starts its own session (`setsid`, double-forking daemons) **and** whose parent exits before Veydr has observed it is not linked to the command anymore. Veydr cannot stop it, and it keeps running after the command was stopped. With the 2-second observation interval, such a process escapes whenever this happens within a fraction of a second after it starts.

Measured on the development machine (2026-10-23, Debian 13, kernel 6.12): 50 of 50 descendants that started a new session and whose parent exited 0–50 ms later escaped. A descendant that was observed before its parent exited is stopped.

Evidence: `test/measure/containment.measure.ts` › "measures the unobserved-escape rate of the process-group strategy"; `test/integration/linux-process-tree.test.ts` › "stops an observed descendant that started a new session, after its parent exited".

### PID reuse between check and signal

Linux lets a process ID be reused once the process has ended. Veydr re-reads a process's start time immediately before signalling it, but a small window remains between that check and the signal (Node.js offers no `pidfd` interface). In that window, a process could end and its PID could be given to an unrelated process. Linux hands out PIDs in increasing order and reuses one only after the counter wraps at `kernel.pid_max` (4,194,304 on the development machine; 32,768 where the kernel default applies), so this requires that many processes to be created within that window.

Evidence: `test/integration/signal-safety.test.ts` › "never signals a recorded PID whose start time no longer matches"; `test/unit/linux-process-tree.test.ts` › "re-verifies the start time immediately before each signal".

### Processes Veydr may not signal

A process of the command that runs as another user (for example through `sudo` or a setuid program), or that is stuck in the kernel and ignores even `SIGKILL`, cannot be stopped by Veydr. It is listed as still running after the stop.

Evidence: `test/unit/linux-process-tree.test.ts` › "reports a process it is not permitted to signal as a survivor"; `test/unit/linux-process-tree.test.ts` › "lists processes alive after the forced stop with PID and command name".

## Not implemented yet

These parts of process management are scheduled for later steps of the Linux MVP and do not exist in this build:

- **Quitting with running commands and crash recovery.** Veydr does not stop running commands when it quits, and it does not yet record running commands to find them after a crash. Commands keep running after Veydr exits until you stop them yourself.
- **Command resolution and environment.** Commands get Veydr's own environment (without Electron's variables) plus your overrides, not your login shell's environment, and the working directory is checked only lexically (`..` cannot leave the project folder; symbolic links are not resolved yet). Variables an AppImage runtime adds to existing ones (for example `LD_LIBRARY_PATH`, `PYTHONPATH`, `XDG_DATA_DIRS`) are not cleaned yet.
- **Logs.** Output is read and discarded; it is not shown yet.
