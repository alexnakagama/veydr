import { join } from 'node:path'

export const CONFIG_FILE = 'config.json'
export const BACKUP_FILE = 'config.json.bak'

/** Files in the configuration directory. The directory itself is `app.getPath('userData')`. */
export interface ConfigPaths {
  readonly dir: string
  /** The configuration document. */
  readonly config: string
  /** The last known-good configuration (the previous `config.json`). */
  readonly backup: string
}

export function configPaths(dir: string): ConfigPaths {
  return { dir, config: join(dir, CONFIG_FILE), backup: join(dir, BACKUP_FILE) }
}

/** Filesystem-safe UTC timestamp, e.g. `2026-10-23T09-15-02-123Z`. */
export function fileTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

/** Damaged `config.json`, kept for inspection. */
export function corruptConfigName(stamp: string): string {
  return `config.corrupt-${stamp}.json`
}

/** Damaged `config.json.bak`, kept for inspection. */
export function corruptBackupName(stamp: string): string {
  return `config.bak.corrupt-${stamp}.json`
}

/** Copy of a configuration file taken before migrating it from `fromVersion`. */
export function preMigrationName(fromVersion: number, stamp: string): string {
  return `config.pre-migration-v${fromVersion}-${stamp}.json`
}
