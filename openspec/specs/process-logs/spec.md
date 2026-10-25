# process-logs Specification

## Purpose

Defines how Veydr captures, retains, streams, and displays process output, including bounded memory use, safe rendering of terminal escape sequences, user controls, and best-effort redaction of secret values.

## Requirements

### Requirement: Capture both output streams
Veydr SHALL capture standard output and standard error of each run as lines, each tagged with its stream, a capture timestamp, and a sequence number unique within the run.

#### Scenario: Stream distinguished
- **WHEN** a process writes to standard output and standard error
- **THEN** each displayed line indicates which stream it came from and when it was captured

#### Scenario: Interleaving is approximate
- **WHEN** a process writes alternately to both streams
- **THEN** lines are ordered by capture time, and the documentation states that cross-stream order is best-effort

### Requirement: Line handling
Output SHALL be split into lines on `\n` and `\r\n`. A partial line SHALL be shown after a short delay if no newline arrives. Lines longer than 16 KiB SHALL be truncated with a visible marker. Invalid UTF-8 SHALL be replaced, not dropped.

#### Scenario: CRLF output
- **WHEN** a process writes lines terminated by `\r\n`
- **THEN** each line is displayed once without a trailing carriage return

#### Scenario: Progress output without newline
- **WHEN** a process writes text without a newline and pauses
- **THEN** the partial text is displayed

#### Scenario: Oversized line
- **WHEN** a process writes a single line larger than 16 KiB
- **THEN** the first 16 KiB are retained and a truncation marker is shown

#### Scenario: Invalid UTF-8
- **WHEN** a process writes byte sequences that are not valid UTF-8
- **THEN** the invalid bytes are shown as replacement characters and capture continues

### Requirement: Bounded retention
Each run SHALL retain at most 10,000 lines or 8 MiB of output, whichever limit is reached first, discarding the oldest lines. Veydr SHALL keep output for at most the current and the most recent previous run of each command, and at most 64 MiB in total, evicting previous runs first. Limits SHALL be documented.

#### Scenario: Retention limit reached
- **WHEN** a run produces more output than the retention limit
- **THEN** only the newest lines within the limit are kept and the view indicates that older lines were discarded

#### Scenario: Memory stays bounded under flood
- **WHEN** a process writes output continuously at high volume for a sustained period
- **THEN** Veydr's memory use stays within a documented bound and does not grow over time

### Requirement: Live streaming with loss accounting
Live output SHALL be delivered to the user interface in batches. If the user interface cannot keep up, Veydr SHALL skip lines in the live view, mark how many were skipped, and allow retrieving retained lines.

#### Scenario: Slow view
- **WHEN** the user interface is temporarily unable to process output
- **THEN** the live view shows a marker with the number of skipped lines and remains responsive afterwards

#### Scenario: User interface reloaded
- **WHEN** the user interface reloads while a command is producing output
- **THEN** retained output is shown again without duplicated or reordered lines

### Requirement: Responsive interface under load
The user interface SHALL remain responsive to input while managed processes produce high-volume output, within thresholds documented in the design and verified by automated tests.

#### Scenario: Interaction during flood
- **WHEN** a command produces sustained high-volume output
- **THEN** user input such as switching commands or typing in the filter is reflected within the documented latency threshold

### Requirement: Safe rendering of output
Process output SHALL be displayed only as text. Color and style escape sequences SHALL be rendered as styling; all other terminal escape and control sequences SHALL be removed and never interpreted.

#### Scenario: Markup in output
- **WHEN** a process prints HTML or script markup
- **THEN** it is displayed literally as text and nothing is executed or rendered as markup

#### Scenario: Color codes
- **WHEN** a process prints color escape sequences
- **THEN** the text is shown with the corresponding styling and without the raw escape codes

#### Scenario: Dangerous escape sequences
- **WHEN** a process prints sequences for clipboard access, hyperlinks, window titles, or cursor movement
- **THEN** they are removed and have no effect

### Requirement: Log view controls
Users SHALL be able to filter displayed lines by text and by stream, pause and resume following new output, copy selected or all visible lines as plain text, and clear the retained output of a run.

#### Scenario: Filter by text
- **WHEN** the user enters filter text
- **THEN** only retained lines containing that text are displayed

#### Scenario: Pause following
- **WHEN** the user pauses following or scrolls up
- **THEN** the view stops auto-scrolling while capture continues, and new output is indicated

#### Scenario: Copy
- **WHEN** the user copies lines
- **THEN** the clipboard receives plain text without escape sequences

#### Scenario: Clear
- **WHEN** the user clears a run's output
- **THEN** retained lines for that run are discarded and capture continues

### Requirement: Best-effort secret redaction
Exact occurrences of environment values marked secret SHALL be replaced in displayed and copied output. The user interface and documentation SHALL state that redaction cannot detect transformed, split, or partial values.

#### Scenario: Secret printed by process
- **WHEN** a process prints the exact value of one of its secret environment variables
- **THEN** the displayed and copied line shows a redaction marker instead of the value

#### Scenario: Secret too short to redact
- **WHEN** the user marks a value shorter than 4 characters as secret
- **THEN** the user interface warns that the value will not be redacted from output

### Requirement: No persistent log files
Veydr SHALL keep process output in memory only and SHALL NOT write it to disk.

#### Scenario: Output not persisted
- **WHEN** Veydr is closed and reopened
- **THEN** no output from previous sessions is available and no output was written to disk
