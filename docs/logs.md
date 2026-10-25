# Logs (output of commands)

This page describes how Veydr captures, keeps, and shows what your commands print, and what it does not guarantee. Veydr is Linux-only for now; Windows is not yet supported.

## What is captured

Veydr reads standard output and standard error of every command it starts, all the time, whether or not the output is on screen. A command therefore never waits for Veydr to read its output. Standard input is not connected.

Output becomes **lines**. Every line records which stream it came from (`out` or `err` in the view) and when Veydr captured it (local time with milliseconds). Lines of one run are numbered in the order they were captured.

- Lines end at a newline (`\n`). A carriage return right before it (`\r\n`) is removed, so Windows-style line endings show each line once.
- A carriage return inside a line (`\r`, used by progress bars) means the text before it was overwritten: the line keeps only what follows the last one.
- Text without a newline is shown as a line of its own once the stream has been quiet for 100 ms (for example a prompt or a progress indicator). What the command prints after that starts a new line; a newline that follows right away only ends the shown text. If the text ends with what could be the start of a secret value (see [Secret values in output](#secret-values-in-output)), that part is held back until the line continues or ends; if neither happens, it stays hidden until the command closes its output (for example when it exits).
- **Progress output** that redraws one line with `\r` behaves as follows: updates arriving less than 100 ms apart are not shown until the line ends or pauses (only the last state is shown); updates arriving further apart are each shown and kept as a separate line, so a long-running progress bar can take up much of a run's 10,000 lines and push out older output.
- A line longer than 16 KiB (16,384 bytes) keeps its first 16 KiB and is marked **truncated at 16 KiB**; the rest of it, up to the next newline, is dropped.
- Bytes that are not valid UTF-8 are shown as the replacement character `�`; capturing continues.

**Order across the two streams is best effort.** Standard output and standard error are separate pipes. Lines are ordered by the time Veydr read them, which can differ from the order the command wrote them when it writes to both streams quickly. A line shown after the 100 ms pause is numbered when it is shown, after lines of the other stream completed meanwhile.

## How much is kept

Output is kept **in memory only** (see [No log files](#no-log-files)), within these limits:

| Limit | Value |
|---|---|
| Lines per run | 10,000 |
| Text per run | 8 MiB |
| Runs per command | the current run and the one before it |
| Text of all runs together | 64 MiB |

When a run reaches its limits, its oldest lines are discarded first. Starting a command a third time discards the output of its oldest run. Over the total limit, Veydr first discards the oldest lines of earlier runs (largest first), then the oldest lines of the largest current run. When older lines of the shown run were discarded, the view says **Older output was discarded**.

Text is counted in bytes of UTF-8. Each kept line also needs some memory for its record; the line limits bound that as well. The output view in the window keeps at most the same number of lines and characters for the run it shows. In the performance scenarios below, the main process heap stayed at 52 MB (one command printing 50,000 lines per second for a minute) and 120 MB (ten commands), without growing over time.

Veydr shows the output of a command's **current run** (the last one started). Restarting a command starts with an empty view; the previous run's output is kept within the limits above (and counts towards the 64 MiB total) but is not shown in this release.

## Live output and slow windows

Output reaches the window in batches: at the latest 50 ms after a line is captured, or at once when 1,000 lines or 256 KiB of text are waiting. The window confirms each batch. When 4 batches wait for confirmation, for example because the window is busy, Veydr holds at most one more batch per run and then **skips** lines in the live view instead of queueing them. The view then shows a marker with the number of skipped lines; **Show** fetches those still kept. Capturing is never paused, and every line is either shown, covered by such a marker, or discarded by the limits above (or by **Clear**).

When the window is reloaded, it loads the kept output of the shown run again and continues with live output, without showing a line twice or out of order.

## What is shown

Output is shown **as text only**. Markup such as `<script>` or HTML tags is shown literally and never interpreted.

Terminal styling sequences (SGR, `ESC [ … m`) are shown as styling: the 16 standard colors, 256 colors, and true colors for text and background, bold, dim, italic, underline, and inverse. Each line is styled on its own: a color set on one line does not carry over to the next.

Every other terminal sequence is removed and has no effect: cursor movement and screen erasing, window titles, clipboard access (OSC 52), hyperlinks (OSC 8), device control strings, and all other control characters except tab, including their 8-bit forms.

## Controls

- **Filter output** shows only lines that contain the text, ignoring upper and lower case and terminal sequences. **Streams shown** limits the view to standard output or standard error. Markers of skipped or discarded lines stay visible, because the lines they stand for may match.
- The view **follows** new output. Scrolling up (or **Pause**) stops following; capturing continues, and a button shows how many new lines arrived. Scrolling back to the end, the button, or **Follow** resumes following.
- **Copy visible** copies every line the view shows (after filtering) as plain text, one line per line, without times, stream labels, markers, or terminal sequences. Lines behind a skipped or discarded marker are not included; the confirmation says how many. Copying a selection with Ctrl+C copies the selected text within one line, or the whole selected lines when the selection spans several (also lines scrolled out of view between its ends). A selection that reaches beyond the output, such as Ctrl+A, copies every shown line from where it starts to where it ends.
- **Clear** asks for confirmation, then discards the kept output of the shown run. The command keeps running and new output is captured and shown.

## Secret values in output

When a command prints the **exact value** of one of its environment variables marked secret, Veydr replaces it with `[redacted]` before the line is kept, so the value never reaches the window or the clipboard through the output. The values in effect when the run started are used.

This is best effort. Veydr does **not** detect:

- transformed values (encoded, escaped, quoted differently, changed in case);
- split values, for example printed in pieces by different writes that end up on different lines (a value printed in two parts on one line with a pause between is still redacted: the start of a secret is held back at the pause, as long as that start is at least 4 characters long);
- partial values (a part of a secret printed on its own);
- secrets that are not marked secret in the command, such as tokens from your login environment.

A secret value that spans several lines (for example a key in PEM format, entered in the configuration file) is redacted line by line: each of its lines of at least 4 characters is replaced wherever it appears; its shorter lines are not redacted, and the editor cannot warn about them.

Values shorter than 4 characters are not redacted at all (they would match ordinary text too often); the command editor warns when you enter such a value and mark it as secret. It cannot warn about a short secret saved earlier while its value is hidden, because the window never receives hidden values; reveal it to check. When a line is cut at 16 KiB in the middle of a secret value, the cut-off start of the value is replaced if it is at least 4 characters long, so at most 3 characters of a secret can remain visible there.

## No log files

Veydr never writes output to disk. Closing Veydr discards all output; after a restart, no output of earlier sessions is available. Veydr's own diagnostic messages (standard error) do not contain output.

## Performance

The performance scenarios of design D14 run inside the real application (`npm run test:perf`, `test/perf/logs.perf.ts`). Their thresholds are fixed in the code and were not changed after measuring.

| Scenario | Thresholds |
|---|---|
| P1: one command printing 50,000 lines/s of 100 bytes for 60 s | main event-loop delay p99 ≤ 50 ms; window → main round trip p95 ≤ 50 ms; main heap ≤ 150 MB, growing < 1 MB per 10 s over the last 30 s; no window task longer than 200 ms; the command gets ≥ 80 % of the output through that it gets into `cat > /dev/null` |
| P2: ten commands printing 5,000 lines/s each for 60 s | as P1, with main heap ≤ 200 MB |
| P3: window blocked for 2 s during P1-like output | lines delivered + lines reported skipped = lines printed, exactly |
| P4: typing in the output filter during P1-like output | keystroke to updated view p95 ≤ 100 ms |

Measured on the development machine (2026-10-25, Debian 13, kernel 6.12, Electron 44.9.3), all within the thresholds:

| Scenario | Result |
|---|---|
| P1 | event-loop delay p99 11.7 ms (max 15.8 ms); round trip p95 1.6 ms; main heap max 52 MB, growth −0.6 MB per 10 s (an earlier run: +0.7 MB); no long task; throughput 100 % of baseline (2,999,973 vs 2,999,982 lines) |
| P2 | event-loop delay p99 12.5 ms; round trip p95 2.5 ms; main heap max 120 MB, growth −7.1 MB per 10 s; no long task; each command ≥ 99.99 % of baseline |
| P3 | 999,949 lines printed = 902,852 delivered + 97,097 reported skipped (one range); none missing or repeated |
| P4 | 18 keystrokes, p95 70 ms (an earlier run: 54 ms) |

The long-task observer is checked before each measurement: it must report a deliberate 80 ms task.

**Throughput tolerance.** A command printing up to the rates of P1 and P2 is not slowed by more than 20 % by Veydr's output handling (spec: high-volume output). Veydr processes output on its main thread; a command printing faster than Veydr can process is slowed to that rate, because it waits for the pipe to be read. On the development machine that rate was about 124 MB/s of 100-byte lines (about 1.2 million lines per second, with the window not keeping up), against 3.1 GB/s into `cat > /dev/null` (`npm run measure`, `test/measure/log-pipeline.measure.ts`).
