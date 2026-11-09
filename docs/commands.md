# Projects and commands

This page describes how you register projects, how Veydr runs the commands you configure for them, which environment those commands get, and how secret values are handled. Everything below describes Linux, except the [Windows (preview)](#windows-preview) section, which gives the rules commands follow on Windows. **Windows: preview. Run from source; verified in CI on Windows Server 2025. No Windows package yet.** How commands are started, stopped, and tracked is described in [processes.md](processes.md).

## Projects

A project is a folder on your computer with a name. **Add project** opens the system folder picker; the folder's name is suggested as the project name.

- The folder must exist and be a folder. It is stored by its real path (symbolic links resolved), so the same folder cannot be registered twice, whichever path leads to it; the existing project is named when you try.
- **Remove** asks first, and removes the project and its commands from Veydr only. Nothing in the folder is changed or deleted. A project with running commands cannot be removed: stop them first.
- If the folder is deleted or moved, the project is shown as **Folder missing** (checked whenever the project list is loaded, when the window regains focus, after a start, and again by Veydr before every start) and its commands cannot start. **Relocate…** points the project at the folder's new place.
- **Open folder** opens the folder in your file manager, after checking that it still is a folder. **Open in editor** starts the editor configured in **Settings** (see below).

## Command modes

Every command belongs to one project and has a name, a mode, a working directory, environment overrides, and a stop timeout.

**Executable with arguments** (direct mode, the default) runs one program with a list of arguments. Each argument is passed exactly as you typed it, one per field: spaces, quotes, `$`, `;`, `&`, `|`, `*`, and `~` are not interpreted, because no shell is involved. A name without `/` (such as `npm`) is looked up on the command's `PATH`; a path with `/` (such as `./bin/server`) is relative to the working directory. If the executable cannot be found, the start fails with `Executable not found: <name> (searched PATH)`.

**Shell script** (shell mode) runs a script through a shell you choose, as `<shell> -c <script>`. The shell defaults to `/bin/sh`; any absolute shell path can be set. Use it when you need pipes, `&&`, variable expansion, or globbing. Shell commands are labelled with their shell in the command list (`Shell: /bin/bash`) and in the editor (`Shell command — runs through /bin/bash`), because the script is interpreted by that shell exactly as in a terminal.

**Working directory** is relative to the project folder (`.` by default). It must stay inside the project folder: `..` that leaves it, or a symbolic link that points outside it, is rejected when you save and checked again when the command starts.

**Stop timeout** is how long Veydr waits after asking a command to stop before forcing it (see [processes.md](processes.md)).

Changes to a running command take effect the next time it starts. A running command cannot be removed, and a project with running commands cannot be relocated (stricter than removal alone requires, because a running command is tied to its folder): stop them first.

## Environment

A command starts with your **login environment**, the variables your login shell sets up (for example `PATH` entries added in `~/.profile`, `~/.bash_profile`, or `~/.zprofile`). This matters when Veydr is started from the desktop launcher, whose environment usually lacks them.

- Veydr reads it by running your login shell (`$SHELL`, otherwise your account's shell, otherwise `/bin/sh`) as `<shell> -l -i -c`, which prints the environment between two unique markers. Anything else your shell configuration prints is ignored. The shell's standard input is not connected, so a configuration that waits for input does not hang it.
- It is read once per session, the first time a command starts or its environment is shown. **Refresh environment** (in a command's **Env** view) reads it again for every command, for example after you changed your shell configuration.
- If the login shell fails or takes longer than 5 seconds, it is stopped, and commands get Veydr's own environment instead; a warning says so. A later successful refresh removes the warning. That environment may lack `PATH` entries from your shell configuration.
- Veydr's own runtime variables never reach a command: every `ELECTRON_*` variable, `NO_AT_BRIDGE` (set by Electron), `CHROME_DESKTOP`, and the AppImage variables `APPDIR`, `APPIMAGE`, `ARGV0`, and `OWD`. They are removed before the login shell runs and from the fallback. The shell's own `PWD`, `OLDPWD`, `_`, and `SHLVL` are removed as well.
- When Veydr runs as an AppImage, its launcher also puts the image's own directories in front of `PATH`, `LD_LIBRARY_PATH`, `XDG_DATA_DIRS`, and `GSETTINGS_SCHEMA_DIR` (and appends defaults to `XDG_DATA_DIRS`). Veydr removes every entry inside the image (`APPDIR`) from every variable, drops a variable left empty, and removes those `XDG_DATA_DIRS` defaults, so commands, the login shell, and the editor see the variables as they were before the launcher ran. See [install-linux.md](install-linux.md).
- **Overrides** are applied last: a variable you set for a command replaces the login environment's value.
- **Env** shows the environment a start would use, with each variable's source (login environment or override). Values from the login environment are shown unmasked, including tokens you export in your shell configuration; only overrides marked secret are masked.

## Secrets

An override can be marked **Secret**.

- Its value is masked wherever Veydr shows it (the editor and the **Env** view) until you choose **Reveal** for that field. The interface never receives a secret value except when you reveal it.
- Saving a command without retyping a secret keeps its stored value.
- Secret values are **stored unencrypted** in Veydr's configuration file, protected only by its file permissions (`0600`); see [configuration.md](configuration.md). The editor says so next to the variables.
- The command itself receives the real value.
- When the command prints the exact value, its output shows `[redacted]` instead (best effort; values shorter than 4 characters are not redacted, and the editor warns about them). See [logs.md](logs.md#secret-values-in-output).

## Editor

**Settings › Editor** configures the editor as an executable and a list of arguments, one of which must contain `{path}`. **Open in editor** replaces `{path}` with the project folder, keeping each argument one argument even if the folder contains spaces or quotes, and starts the editor directly, without a shell, with your login environment. Veydr does not track, stop, or wait for the editor: it keeps running when Veydr quits.

## Examples

These examples are the ones the end-to-end tests use (`test/e2e/commands.spec.ts`, `test/e2e/projects.spec.ts`).

| What | Configured as | Result |
|---|---|---|
| Direct mode | executable `sleep`, argument `60` | runs `sleep` found on the login `PATH` |
| Shell mode | shell `/bin/bash`, script `echo "$HOME" \| cat` | listed as `Shell: /bin/bash` |
| Working directory outside the project | `../elsewhere` | `The working directory "../elsewhere" is outside the project folder` |
| Secret override | `API_TOKEN`, marked secret | shown as `••••••••` until revealed |
| Editor | arguments `--goto={path}` and `{path}` | the project folder substituted in both, each one argument |
| Missing project folder | start a command of a deleted folder | `The project folder is missing: <path>` |

## Limitations

- **Plaintext secrets.** See above; there is no keychain storage in this release.
- **Login shells that need a terminal.** A shell configuration that only works with a terminal may fail or print errors; Veydr then uses its own environment and warns.
- **Environment changes need a refresh.** Changes to your shell configuration reach commands only after **Refresh environment** or a restart of Veydr.
- **Required tools.** Veydr starts programs through `bash` and `env` so that they do not inherit files and connections Veydr holds open (see [security-baseline.md](security-baseline.md)). Both are installed on every supported distribution; without them Veydr starts nothing and says why. A program whose path contains `=` additionally needs `nice`.
- **Failures after the start.** Veydr checks the working directory, the executable, and a script's `#!` interpreter before starting. Problems that only show when the program is executed — the executable removed in the meantime, an argument list and environment too large for the system (`E2BIG`) — appear as a command that exits with status 126 or 127 right after starting, not as a failed start. Without a mounted `/proc`, programs are not started (status 125).
- **Non-UTF-8 values.** Login environment values that are not valid UTF-8 are changed (invalid bytes replaced); a warning names them.
- **Scripts without `#!`.** An executable text file without a `#!` line is run by `/bin/sh`, as a terminal would.

## Windows (preview)

**Windows: preview. Run from source; verified in CI on Windows Server 2025. No Windows package yet.** Commands start on Windows by the rules below, which are tested on a native Windows runner in CI. What that runner cannot verify is listed in [processes.md](processes.md#not-verified-on-the-ci-runner). To run Veydr on Windows, see [Running from source on Windows](../README.md#running-from-source-on-windows).

### Finding the program

- **A name** without `\` or `/` (such as `npm`) is looked up in the directories of the command's `Path`, in order, regardless of letter case. As in `cmd.exe`, double quotes are removed from each entry, and a `;` between quotes belongs to the entry, so a quote left unclosed joins the rest of `Path` into one entry and the directories after it are not searched; entries left empty and entries that are not full paths (such as `.` or `bin`) are skipped.
- **The working directory is never searched**, unlike in a `cmd.exe` prompt: an `npm.cmd` in the project folder runs only if its directory is on `Path`.
- **Extensions:** in each directory, a name that has an extension is tried as given, then with each extension of `PATHEXT` in order (`.COM;.EXE;.BAT;.CMD` when `PATHEXT` is unset or lists no usable extension). A file without an extension, such as the `npm` shell script that Node.js installs beside `npm.cmd`, never matches `npm`. Anything after the last dot counts as an extension, so `python3.11` is tried as given first, and an extensionless `python3.11` file is refused (see below) before `python3.11.exe` is tried. The extension is tried as `PATHEXT` spells it (`npm.CMD`), so in a folder set to be case-sensitive a lower-case `npm.cmd` is not found, as in `cmd.exe`.
- **Accepted types:** the first match must be an `.exe`, `.com`, `.bat` or `.cmd` file. Any other type, such as `.js`, `.vbs` or `.ps1`, is refused with `<file> is not a program Veydr can start on Windows: only .exe, .com, .bat and .cmd files are started`. Veydr does not go on to a later match, so it never starts a program you did not expect.
- **Slow directories:** each `Path` directory has 2 seconds to answer, so an unreachable network share delays a start but cannot block it. A directory that does not answer, or cannot be read, is skipped, and the error names it if nothing is found. After 2 directories that do not answer, the search stops and the start fails: each unanswered check keeps one of the few threads Veydr reads files with busy until Windows gives up on the share. A directory or path whose check from an earlier start is still waiting counts as not answering at once, without a new check, until Windows gives up on it; for a network path (`\\server\…`) that holds for every path on the same server. The project folder, the working directory, and a program or shell given by path have the same 2-second limit.
- **A path:** a full path (`C:\tools\tool.exe`, `\\server\share\tool.exe`) is used as given, and any other path (`node_modules\.bin\vite.cmd`) is relative to the working directory. `PATHEXT` does not apply to a path, so give its extension. A path that depends on the current drive (`C:tool.exe`) or on the root of the current drive (`\tools\tool.exe`) is refused: give a full path or a path relative to the working directory.
- **Names Windows would read as another file** are refused, in a name and in every folder of a path (including the shell's): a name ending in a dot or a space, containing `:`, `*`, `?`, `<`, `>`, `|`, `"` or a control character, or a device name such as `CON`, `NUL`, `AUX`, `COM1` or `LPT1`, with or without an extension.
- **Links:** a symbolic link or junction that leads to a folder, or to nothing, is not a program.

### Batch files

A `.bat` or `.cmd` file can only run under `cmd.exe`, so a direct-mode batch file is the one case in which direct mode involves a shell. Veydr starts it through `cmd.exe` in the Windows system directory (`%SystemRoot%\System32\cmd.exe`), as `cmd.exe /d /v:off /s /c`: AutoRun commands and delayed `!` expansion are off. Your shell setting does not apply to direct mode.

- **Simple arguments** of only ASCII letters, digits and `_ + - . : / \ @` are passed as written, so a batch file reads them unchanged through `%1` and `%~1`. For example, `build.bat` with the arguments `release` and `C:\out\` sees `"%1"=="release"`, and `%~2` is `C:\out\`.
- **Every other argument** is quoted and escaped so that a program the batch file forwards its arguments to with `%*`, as `npm.cmd` and other shims do, receives it unchanged, and nothing in it runs as a command: spaces, quotes, `&`, `|`, `<`, `>`, `^`, `%`, `!` and a trailing backslash included.
- **A batch file that reads such an argument through `%1` itself** sees it with `cmd.exe`'s escape characters (`^`) still in it. Such a batch file has to handle quoted arguments itself, or be given simple arguments only.
- **Refused before anything starts:** an argument containing a line break or a NUL character, a batch-file path containing `%`, and arguments longer than one `cmd.exe` line can carry: 8191 characters for the whole line, of which 1024 are kept free for the batch file's own text around `%*`.

### Shell mode

- **`cmd.exe` only.** The shell must be a file named `cmd.exe`, given by its full path; it defaults to `cmd.exe` in the Windows system directory (`C:\Windows\System32\cmd.exe` on most systems, read from `SystemRoot`, not from `ComSpec`). PowerShell, `bash.exe` or any other shell is refused with `On Windows, shell mode supports cmd.exe only`.
- **The script is passed unchanged**, as `cmd.exe /d /v:off /s /c "<script>"`, so `&&`, `||`, `|`, redirection and `%VARIABLE%` work as at a `cmd.exe` prompt. `!VARIABLE!` is not expanded.
- **One line.** `cmd.exe` runs only the first line of a script, so a script with a line break is refused: join the commands with `&&` or `&`. An empty script is refused too.
- **8191 characters.** The whole `cmd.exe` line, the `"<cmd.exe>" /d /v:off /s /c "` before the script and the closing quote included, may have at most 8191 characters; a longer one is refused before anything starts.

### Environment

- **Inherited.** A command starts with the environment Veydr itself was started with, not one read from a login shell or from the registry. Veydr's runtime variables are removed in any letter case (`electron_run_as_node` is the same variable as `ELECTRON_RUN_AS_NODE` on Windows), and so are the per-drive entries Windows keeps for itself (`=C:`) and any variable that cannot be passed on (a name that is empty or contains `=`, or a name or value containing a NUL character).
- **Names merged.** Windows compares variable names without regard to letter case, but an environment can still hold both `Path` and `PATH`. Veydr keeps one entry for each name: the first one, which is the one Windows' own lookup finds, with its spelling and value. A merge is recorded in the diagnostic log as `environment.names-merged`, with the names but not the values. An override replaces the variable whatever its letter case, so a command sees exactly one `PATH`.
- **A restart is needed after a `PATH` change.** A program you install, or a variable you change in the system settings, after Veydr started reaches commands only once Veydr is started again (from the Start menu or Explorer, which pass on the updated environment; a terminal opened before the change passes on the old one). **Refresh environment** reads nothing new on Windows: it shows the environment Veydr was started with.

### Editor

- **Found as a command is.** The editor is looked up as a direct-mode program, so `code` finds `code.cmd` on `Path`. A batch-file editor such as `code.cmd` is started through `cmd.exe` by the batch-file rules above: the project folder stays one argument, quoted if it is not a simple one, and nothing in it runs as a command, even with spaces, `&` or `^` in it.
- **Detached.** The editor is started without a console and outside Veydr's tracking, so it keeps running when Veydr quits. Should Veydr itself run inside a Job Object that ends its processes when it closes (as some service managers and CI runners do), the editor may end with it.
- **No new console window** appears for an editor that is a GUI program, or a batch file that starts one (`code.cmd`, which starts `Code.exe`). **A batch-file editor that starts a console program shows that program's console**, because the batch file has no console to share with it.

### `cmd.exe` as a direct-mode program

You can name `cmd.exe` itself as a direct-mode program, for example with the arguments `/c` and `echo hi`. Its arguments are then quoted as for any other program, but `cmd.exe` reads its command line again by its own rules, so quotes, `&`, `|` and `%` in them are interpreted by `cmd.exe`. That is your choice of program; use shell mode to run a script.
