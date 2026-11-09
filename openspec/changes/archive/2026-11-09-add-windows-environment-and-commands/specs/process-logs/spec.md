# Spec Delta

## MODIFIED Requirements

### Requirement: Line handling
Output SHALL be split into lines on `\n` and `\r\n`. A partial line SHALL be shown after a short delay if no newline arrives. Lines longer than 16 KiB SHALL be truncated with a visible marker. Invalid UTF-8 SHALL be replaced, not dropped. On Windows, a command's console SHALL be set to the UTF-8 output code page where possible, a failure to set it SHALL be logged, and a line that is not valid UTF-8 SHALL be decoded with the system's ANSI code page instead, where that code page is known.

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
- **WHEN** a process writes byte sequences that are not valid UTF-8, and no ANSI fallback applies (on Linux, or on Windows when the ANSI code page is not known)
- **THEN** the invalid bytes are shown as replacement characters and capture continues

#### Scenario: Console output on Windows
- **WHEN** on Windows a `cmd.exe` command echoes non-ASCII text
- **THEN** the log shows that text unchanged

#### Scenario: ANSI output on Windows
- **WHEN** on Windows a program writes a line in the system's ANSI code page that is not valid UTF-8
- **THEN** the log shows that line decoded with the ANSI code page, and the lines before and after it are decoded as UTF-8
