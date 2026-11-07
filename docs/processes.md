# Processes

This page describes how Veydr starts, tracks, and stops the commands you configure, and what it cannot guarantee. Veydr is Linux-only for now; Windows is not yet supported. Everything below describes Linux, except the [Windows (not yet available)](#windows-not-yet-available) section, which describes groundwork you cannot use from the app yet.

## Starting

Veydr starts a command only when you press **Start** or **Restart** for it. Nothing is started automatically, and a command that exits on its own is never restarted.

- **Direct mode** runs the executable with its arguments exactly as configured; no shell interprets them. A name without `/` is looked up on the command's `PATH` (your login environment with your overrides) before anything is started; a path containing `/` is relative to the working directory.
- **Shell mode** runs `<shell> -c <script>` with the shell you selected.
- The command gets your login shell's environment, without Veydr's own runtime variables, with your overrides applied last. See [commands.md](commands.md) for modes, the environment, and secrets.
- The project folder must exist, and the working directory must stay inside it, also after resolving symbolic links.
- The command receives only standard input, output, and error (descriptors 0–2); descriptors Veydr itself holds open are closed before the command runs.
- Standard input is not connected (`/dev/null`). Standard output and error are always read, even when nobody looks at them, so a command never blocks on writing output. How output is kept and shown is described in [logs.md](logs.md).
- Each command runs in its own session and process group (its first process, the *leader*, has PID = process group ID = session ID). This keeps signals for the command away from Veydr and from everything else you run.

If a command cannot be started, it shows **Failed** with the reason, and no process is left behind:

| Reason shown | Cause |
|---|---|
| `The project folder is missing: <path>` | The project's folder was deleted or moved; relocate the project. |
| `The working directory "<dir>" is outside the project folder <path>` | The working directory leaves the project folder (directly, or through a symbolic link). |
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

The same rule decides which listening ports belong to a command ([ports.md](ports.md)); `/proc` is then also read at every refresh of the ports view.

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

## Quitting

When you quit Veydr (or close its window) while commands are running, Veydr stops all of them before it exits:

1. The window shows **Stopping running commands before quitting…** with the commands still being stopped, and accepts no other input. Starting or restarting a command is refused from now on.
2. Every running command is stopped at the same time, each the usual way with its own stop timeout (see [Stopping](#stopping)).
3. Veydr waits at most the longest stop timeout of those commands plus 2 seconds, then checks which processes of this session's commands are still alive.
4. If none are, Veydr exits. Otherwise a dialog lists them (name, PID, and command line) with **Retry** and **Quit anyway**. **Retry** sends `SIGTERM` to the listed processes, then `SIGKILL` after 5 seconds, and checks again. **Quit anyway** exits and leaves them running; the next launch lists them again (see [Crash recovery](#crash-recovery)). Closing the dialog with Esc counts as **Retry**: quitting without stopping is never the default.

The same applies to processes that survived an earlier stop in this session: they are listed when you quit.

### Signals

When Veydr itself receives `SIGTERM`, `SIGINT`, or `SIGHUP` (for example when you log out, or press Ctrl+C in the terminal that started it), it stops every running command the same way, without asking, and exits within 10 seconds. Whatever it could not verify as stopped by then stays recorded, and the next launch lists it. A second signal makes Veydr exit at once, without waiting. The exit status is 128 plus the signal number (143 for `SIGTERM`), as for a process ended by that signal.

## Crash recovery

Veydr records every command it starts in `runtime/ledger.json` in its [configuration directory](configuration.md): the command, the run, and the leader, session, and observed descendants of the run, each identified by PID, start time, and boot. A run is recorded right after it starts; changes to its observed descendants are written at most once per second. A run is removed from the record once none of its processes is alive. After a clean quit, the record holds no runs.

If Veydr ends abnormally (a crash, or `SIGKILL`), the processes of its running commands keep running, with one exception: their output pipes now have no reader, so a process that writes output after that usually ends itself (the write fails with `SIGPIPE`/`EPIPE`, which ends most programs). Processes that write nothing, or ignore the failed write, keep running. On the next launch, Veydr checks the record:

- A recorded process counts only if it is still the same process: same boot, same PID, same start time. A PID that now belongs to another process is ignored and never signalled; so is everything recorded before the last reboot. Besides the recorded processes, every live process in a recorded command's session that started no earlier than its leader counts, unless the leader's PID now belongs to another process.
- Processes that still run are listed (name, PID, and command line) in a notice. **Veydr does not start, restart, or signal anything on its own.** You choose **Terminate** (`SIGTERM`, then `SIGKILL` after 5 seconds; processes that still survive are listed again) or **Leave running**. Leave running takes effect at once, without a further question: Veydr stops tracking those processes, does not list them again, and will not stop them when it quits; ending them is then up to you.
- Runs of which nothing is alive any more are removed from the record.

If the record cannot be read, written, or checked, a notice says so (a record that cannot be read is kept as `runtime/ledger.damaged-<timestamp>.json`); processes from the earlier session may then still be running unnoticed.

## Limitations

### Escaped descendants

A descendant that starts its own session (`setsid`, double-forking daemons) **and** whose parent exits before Veydr has observed it is not linked to the command anymore. Veydr cannot stop it, and it keeps running after the command was stopped. With the 2-second observation interval, such a process escapes whenever this happens within a fraction of a second after it starts.

Measured on the development machine (2026-10-23, Debian 13, kernel 6.12): 50 of 50 descendants that started a new session and whose parent exited 0–50 ms later escaped. A descendant that was observed before its parent exited is stopped.

Evidence: `test/measure/containment.measure.ts` › "measures the unobserved-escape rate of the process-group strategy"; `test/integration/linux-process-tree.test.ts` › "stops an observed descendant that started a new session, after its parent exited".

### PID reuse between check and signal

Linux lets a process ID be reused once the process has ended. Veydr re-reads a process's start time immediately before signalling it, but a small window remains between that check and the signal (Node.js offers no `pidfd` interface). In that window, a process could end and its PID could be given to an unrelated process. Linux hands out PIDs in increasing order and reuses one only after the counter wraps at `kernel.pid_max` (4,194,304 on the development machine; 32,768 where the kernel default applies), so this requires that many processes to be created within that window.

Evidence: `test/integration/signal-safety.test.ts` › "never signals a recorded PID whose start time no longer matches"; `test/unit/linux-process-tree.test.ts` › "re-verifies the start time immediately before each signal".

### After an abnormal exit

When Veydr ends abnormally, the processes of its running commands keep running **until Veydr is started again** (and you terminate them), unless they end themselves by writing output that no longer has a reader (see [Crash recovery](#crash-recovery)). Linux offers Node.js no way to have them ended together with Veydr. Only what Veydr recorded can be found then:

- a descendant that appeared in the last few seconds before the crash may not be recorded yet (Veydr observes descendants every 2 seconds and writes the record at most once per second); it is still found if it stayed in the command's session;
- a descendant that left the command's session before Veydr observed it (see [Escaped descendants](#escaped-descendants)) is not found;
- a command that was being started at the moment of the crash may not be recorded at all (a run is reported as running only once its record is written, which normally takes a few milliseconds after the start; if the disk stops responding, the command stays in **Starting** until the write completes or fails).

Evidence: `test/integration/crash-recovery.test.ts` › "finds every surviving process after the supervisor host is SIGKILLed"; `test/e2e/recovery.spec.ts` › "after a crash, survivors are listed and terminated only on confirmation".

Observed in the packaged acceptance pass (2026-10-25, `scripts/acceptance-linux.sh`, task 10.2): after `SIGKILL` of Veydr, a listening command that writes nothing kept running and was listed and terminated on the next launch; a shell loop printing a line every 0.2 s ended by itself within a second.

### Processes Veydr may not signal

A process of the command that runs as another user (for example through `sudo` or a setuid program), or that is stuck in the kernel and ignores even `SIGKILL`, cannot be stopped by Veydr. It is listed as still running after the stop.

Evidence: `test/unit/linux-process-tree.test.ts` › "reports a process it is not permitted to signal as a survivor"; `test/unit/linux-process-tree.test.ts` › "lists processes alive after the forced stop with PID and command name".

## Windows (not yet available)

**Not yet reachable from the app.** Windows is not yet supported: starting a command on Windows fails with "not supported on this platform", and no process is created, because finding executables and reading the environment on Windows are not implemented yet. The process-tree layer below is implemented and tested on a native Windows runner in CI, so that the remaining work can build on it. Everything in this section describes that layer, not something you can use today.

### Containment

- Each command runs through its own helper process, `veydr-helper.exe`, built from source in the repository (see [dependencies.md](dependencies.md)). That is one extra, mostly idle process per running command.
- The helper creates a Windows **Job Object** for the command and starts the command **suspended**, assigns it to the job, and only then lets it run. Every process the command starts, from its very first instruction, is in the job, and no process can leave it. A process belongs to a command exactly when it is in the command's job; orphaned descendants included.
- The command gets a hidden console of its own (no window appears) and starts a new process group, so Ctrl+C is turned off for it and only Ctrl+Break reaches it (see [Stopping](#stopping-1)). Standard input is not connected (`NUL`), and its standard output and error go straight to Veydr, not through the helper.
- The program must be given by its full path, which must not contain `"` or NUL characters; nothing is looked up in the working directory.
- A batch file (`.cmd`, `.bat`) is never started as the program itself, which would let Windows run it through `cmd.exe` with its own unsafe quoting: it runs only as part of a `cmd.exe /d /v:off /s /c` command line that Veydr builds, as described in [commands.md](commands.md#batch-files).

### Stopping

1. Veydr asks the helper to stop the command. The helper sends **Ctrl+Break** to the command's console, but only when every process on that console, apart from the helper itself, belongs to the command. Veydr and other commands never receive it.
2. If processes of the command are still alive after the command's **stop timeout** (5 seconds by default), the helper ends the whole job at once (`TerminateJobObject`), and the result is reported as forced.
3. It waits up to 1 second more. Any process of the command still alive then is listed as **still running after the stop**.

If no process of the command is left on its console (for example, every process detached from it), no Ctrl+Break can be sent: the job is ended at once, without waiting for the stop timeout, and the stop is reported as forced. A process that a command starts with a console of its own (for example a hidden child process) does not receive the Ctrl+Break; it is ended by the forced step.

### After an abnormal exit on Windows

Unlike on Linux, the processes of a command do **not** keep running after an abnormal exit:

- If Veydr ends abnormally, the helper sees its connection to Veydr close, ends the command's job, and exits.
- If the helper itself ends abnormally, Windows closes the job, which ends every process in it. Veydr can then no longer check the command's processes, so the command ends as **Exited** with a message that the stop could not be verified.

Runs are still recorded in `runtime/ledger.json`, as a fallback only. On Windows a process is identified by its PID and its creation time; a PID that now belongs to another process is never reported or ended. On the next launch, recorded processes that are still alive and still the same process are listed, and **Terminate** re-verifies each one and sends it Ctrl+Break only if its console holds nothing but listed processes. It waits up to the default stop timeout (5 seconds) for those that received the event, and then ends each one that is still the same process (at once when none received it). Processes that such a survivor started after Veydr ended are not in any job of Veydr and are not ended.

### Differences from Linux

- Where Linux shows a process's command line (the quit dialog, the crash-recovery notice, the survivors of a stop), Windows shows the full path of its executable image instead: reading another process's command line would need its memory or WMI, which is too slow during a stop.
- Each running command has one extra process, its helper.

### Not verified on the CI runner

These tests run on GitHub's `windows-2025` runner, which cannot show the following. They stay unverified until a test on a real Windows installation:

- a desktop session on Windows 10 or 11, including Windows Terminal as the default console;
- logging off or shutting down Windows while commands run;
- Veydr started with no Job Object around it, as when it is started from Explorer (the runner runs every step inside a job);
- a standard user account: the CI job runs as the runner's administrator only.

The helper is not signed yet, so antivirus software or SmartScreen may flag it (see [deferred-checks.md](deferred-checks.md#windows-process-supervision-2026-11-06)).

Evidence: `test/integration/windows-process-tree.test.ts` › "[spec:process-supervision/veydr-ends-abnormally-on-windows]"; `test/integration/windows-process-tree.test.ts` › "[spec:process-supervision/helper-ends-abnormally-on-windows]"; `test/integration/windows-process-tree.test.ts` › "[spec:process-supervision/cooperative-process-on-windows]"; `test/unit/supervisor.test.ts` › "ends a run as unverified when its leader exits and the run can no longer be checked"; `test/unit/supervisor.test.ts` › "[spec:process-supervision/start-on-windows]".
