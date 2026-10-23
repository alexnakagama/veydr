# Configuration

Veydr keeps all of its configuration (projects, commands, environment overrides, and settings) in one JSON file per user. It never writes into your project directories, and it has no accounts, cloud sync, or telemetry.

## Location (Linux)

| Situation | Configuration directory | Configuration file |
|---|---|---|
| `XDG_CONFIG_HOME` unset (the usual case) | `~/.config/Veydr/` | `~/.config/Veydr/config.json` |
| `XDG_CONFIG_HOME` set | `$XDG_CONFIG_HOME/Veydr/` | `$XDG_CONFIG_HOME/Veydr/config.json` |

The directory is Electron's per-user application data directory (`app.getPath('userData')`). Chromium, which Veydr is built on, also keeps its own runtime data there (for example `Local State`, `Preferences`, and cache folders); those are not Veydr configuration.

The integration test `test/integration/config-location.test.ts` launches the built app with a temporary `HOME` and checks both rows of this table.

## Files

| File | Purpose |
|---|---|
| `config.json` | The current configuration. Created with an empty configuration on first launch. |
| `config.json.bak` | The previous version of `config.json` (the last known-good configuration). Replaced on every save. |
| `config.corrupt-<timestamp>.json` | A damaged `config.json`, moved aside during recovery. Never deleted by Veydr. |
| `config.bak.corrupt-<timestamp>.json` | A damaged `config.json.bak`, moved aside when neither file was usable. Never deleted by Veydr. |
| `config.pre-migration-v<version>-<timestamp>.json` | A copy of a configuration file from an older schema version, taken before the upgraded file is written. Never deleted by Veydr. |
| `config.json.tmp`, `config.json.bak.tmp` | Temporary files that exist only while a save is in progress. A leftover one (after a crash) is ignored and replaced by the next save. |

`<timestamp>` is the UTC time in the form `2026-10-23T09-15-02-123Z`; if a file with that name already exists, `-1`, `-2`, … is appended to the timestamp. You can delete the corrupt and pre-migration copies yourself once you no longer need them.

## Permissions

The configuration directory has mode `0700` and every configuration file Veydr writes has mode `0600`: only your user account can read or change them. Veydr sets these modes explicitly (independent of your `umask`) when it creates or saves files, and on startup it tightens an existing directory, `config.json`, and `config.json.bak` that are more permissive. The one exception is a configuration written by a newer Veydr version, which is left completely untouched (see below); only the directory mode is tightened then.

On a filesystem where modes cannot be changed (for example FAT or some network mounts), or for a directory owned by another user, Veydr logs a `config.chmod-failed` warning and keeps working; files it creates still get mode `0600` minus your `umask`, and are never looser than that.

## How saving works

Every change is validated against the configuration schema first; a change that would produce an invalid configuration is rejected with a message naming the field, and nothing is written.

A valid change is saved atomically:

1. The previous configuration (as Veydr last loaded or saved it) is written to `config.json.bak` (through a temporary file and a rename).
2. The new content is written to `config.json.tmp` with mode `0600` and flushed to disk (`fsync`).
3. `config.json.tmp` is renamed over `config.json`.
4. The directory is flushed (`fsync`) so the renames survive a power loss.

If `config.json` is a symbolic link (for example, managed by a dotfile tool), the first save replaces the link with a regular file in the Veydr directory; the file the link pointed to is left as it was.

If Veydr, the system, or the power fails at any point, `config.json` is either the complete previous version or the complete new version, never a mix. Saves run one at a time, in order. Only one Veydr instance runs per user session (a second launch just focuses the existing window), so there is only ever one writer.

## Backup and recovery

On startup Veydr checks `config.json`:

- **Valid:** it is used as is.
- **Damaged** (not valid JSON or UTF-8, not matching the schema, a directory in its place, or from an older schema version that cannot be upgraded) or **missing while `config.json.bak` exists**, and the backup is valid: Veydr moves the damaged file aside as `config.corrupt-<timestamp>.json`, loads the backup, writes it back as `config.json`, and tells you that it recovered.
- **Neither file usable:** Veydr moves both damaged files aside (`config.corrupt-<timestamp>.json` and `config.bak.corrupt-<timestamp>.json`), starts with an empty configuration, and tells you.
- If `config.json` or its backup exists but cannot be read for a reason unrelated to its content (for example a permission or input/output error), Veydr does not treat it as damaged: it changes nothing and stops with an error naming the file, so a temporary failure never replaces your configuration.
- If a damaged file cannot be moved aside (for example, the directory is not writable), Veydr changes nothing and disables configuration changes for that session, so the damaged file is not overwritten.

These messages appear as notices at the top of the window (problems that left you with an empty or unchangeable configuration as alerts, the others as status messages), together with the files involved, and are also written to Veydr's diagnostic log (standard error, lines starting with `[veydr:warn] config.notice`). Dismissing a notice hides it in the current window only: Veydr keeps the notices of the running session and shows them again after the window is reloaded.

## Schema versions

`config.json` carries an integer `schemaVersion` (currently `1`).

- **Older version:** Veydr upgrades it on load. Before writing the upgraded file it keeps the original as `config.pre-migration-v<version>-<timestamp>.json`; if that copy cannot be written, nothing is upgraded on disk and changes are disabled. (Version 1 is the first schema, so no upgrade exists yet.)
- **Newer version** (written by a later Veydr): the file is opened read-only. Veydr tells you, disables configuration changes, and does not modify the file in any way. It shows the configuration only if it also fits the current schema; otherwise it shows none.

## Secrets are stored in plaintext

Environment values that you mark as **secret** are stored **unencrypted** in `config.json` (and in its backups and preserved copies). Their only protection on disk is the `0600` file mode, so anyone who can act as your user account — or read your disk or backups — can read them. Marking a value as secret masks it in the interface and redacts it from captured logs on a best-effort basis; it does not encrypt it. Keychain-backed storage is not part of this release.
