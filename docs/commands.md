# Projects and commands (Linux)

This page describes how you register projects, how Veydr runs the commands you configure for them, which environment those commands get, and how secret values are handled. Veydr is Linux-only for now; Windows is not yet supported. How commands are started, stopped, and tracked is described in [processes.md](processes.md).

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
- **Overrides** are applied last: a variable you set for a command replaces the login environment's value.
- **Env** shows the environment a start would use, with each variable's source (login environment or override). Values from the login environment are shown unmasked, including tokens you export in your shell configuration; only overrides marked secret are masked.

## Secrets

An override can be marked **Secret**.

- Its value is masked wherever Veydr shows it (the editor and the **Env** view) until you choose **Reveal** for that field. The interface never receives a secret value except when you reveal it.
- Saving a command without retyping a secret keeps its stored value.
- Secret values are **stored unencrypted** in Veydr's configuration file, protected only by its file permissions (`0600`); see [configuration.md](configuration.md). The editor says so next to the variables.
- The command itself receives the real value.

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
