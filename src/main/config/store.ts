import { basename, join } from 'node:path'
import { CURRENT_SCHEMA_VERSION, emptyConfig, validateConfig, type Config, type ConfigIssue } from '../../shared/config'
import type { DiagnosticLog } from '../app/diagnostics'
import { DIRECTORY_MODE, DirectorySyncError, FILE_MODE, writeFileAtomic } from './atomic'
import { isChmodUnsupported, isErrno, nodeConfigFs, type ConfigFs } from './fs'
import { checkVersion, migrate, migrations as defaultMigrations, type Migrations } from './migrations'
import { configPaths, corruptBackupName, corruptConfigName, fileTimestamp, preMigrationName } from './paths'

export type ReadOnlyReason = 'newer-schema' | 'preservation-failed'

export type ConfigStatus = { readonly writable: true } | { readonly writable: false; readonly reason: ReadOnlyReason }

export type ConfigNoticeKind = 'recovered-from-backup' | 'reset-to-empty' | 'newer-schema' | 'preservation-failed' | 'save-failed'

/** Something the user must be told about after loading (shown through `app.onNotice`). */
export interface ConfigNotice {
  readonly kind: ConfigNoticeKind
  readonly message: string
  /** Files involved, e.g. where a damaged file was kept. */
  readonly files: readonly string[]
}

export interface LoadResult {
  readonly config: Config
  readonly status: ConfigStatus
  readonly notices: readonly ConfigNotice[]
}

export class ConfigValidationError extends Error {
  override readonly name = 'ConfigValidationError'
  constructor(readonly issues: readonly ConfigIssue[]) {
    super(`Invalid configuration: ${issues.map((i) => (i.path === '' ? i.message : `${i.path}: ${i.message}`)).join('; ')}`)
  }
}

/**
 * A configuration file exists but could not be read for a reason that says
 * nothing about its content (EIO, EACCES, EMFILE, …). Loading stops instead of
 * treating the file as damaged and replacing it.
 */
export class ConfigReadError extends Error {
  override readonly name = 'ConfigReadError'
  constructor(
    readonly path: string,
    override readonly cause: unknown,
  ) {
    super(`Cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

export class ConfigReadOnlyError extends Error {
  override readonly name = 'ConfigReadOnlyError'
  constructor(readonly reason: ReadOnlyReason) {
    super(
      reason === 'newer-schema'
        ? 'Configuration changes are disabled: it was created by a newer version of Veydr.'
        : 'Configuration changes are disabled: a damaged configuration file could not be kept for inspection.',
    )
  }
}

export interface ConfigStore {
  /** Loads (and if needed recovers or migrates) the configuration. Call once, before anything else. */
  load(): Promise<LoadResult>
  /** The committed configuration (deeply frozen). */
  current(): Config
  status(): ConfigStatus
  /**
   * Applies `change` to a copy of the current configuration, validates the
   * result, and saves it atomically. Updates run one at a time in call order;
   * on any failure the stored and in-memory configuration are unchanged.
   */
  update(change: (config: Config) => Config): Promise<Config>
}

export interface ConfigStoreOptions {
  /** The configuration directory (`app.getPath('userData')`). */
  readonly dir: string
  readonly log: Pick<DiagnosticLog, 'record'>
  readonly fs?: ConfigFs
  readonly migrations?: Migrations
  readonly now?: () => Date
  /**
   * Whether the platform can flush a directory (`platform.conventions.directorySync`, default
   * true). When false, saves and the pre-migration copy skip the directory flush, so no
   * `config.directory-sync-failed` is logged.
   */
  readonly directorySync?: boolean
}

type Candidate =
  | { readonly state: 'missing' }
  | { readonly state: 'damaged'; readonly reason: string }
  | { readonly state: 'newer'; readonly version: number; readonly document: Record<string, unknown> }
  | { readonly state: 'valid'; readonly config: Config; readonly bytes: Uint8Array; readonly migratedFrom: number | null }

const encoder = new TextEncoder()

export function serializeConfig(config: Config): Uint8Array {
  return encoder.encode(`${JSON.stringify(config, null, 2)}\n`)
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createConfigStore(options: ConfigStoreOptions): ConfigStore {
  const fs = options.fs ?? nodeConfigFs
  const available = options.migrations ?? defaultMigrations
  const now = options.now ?? (() => new Date())
  const syncDirectory = options.directorySync ?? true
  const { log } = options
  const paths = configPaths(options.dir)

  let state: Config | null = null
  let status: ConfigStatus = { writable: true }
  /** Exact bytes of `config.json` when it is known to be valid; becomes `.bak` on the next save. */
  let knownGood: Uint8Array | null = null
  let loadStarted = false
  let queue: Promise<unknown> = Promise.resolve()

  async function readCandidate(path: string): Promise<Candidate> {
    let bytes: Uint8Array
    try {
      bytes = await fs.readFile(path)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return { state: 'missing' }
      // A directory in place of the file is damage; any other read error may be transient.
      if (isErrno(error, 'EISDIR')) return { state: 'damaged', reason: 'it is a directory' }
      throw new ConfigReadError(path, error)
    }
    let document: unknown
    try {
      document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      return { state: 'damaged', reason: 'it is not valid JSON' }
    }
    const version = checkVersion(document)
    if (version.kind === 'invalid') return { state: 'damaged', reason: version.reason }
    if (version.kind === 'newer') {
      return { state: 'newer', version: version.version, document: document as Record<string, unknown> }
    }
    let migratedFrom: number | null = null
    if (version.kind === 'older') {
      const migrated = migrate(document as Record<string, unknown>, version.version, available)
      if (!migrated.ok) return { state: 'damaged', reason: migrated.reason }
      document = migrated.document
      migratedFrom = version.version
    }
    const validation = validateConfig(document)
    if (!validation.ok) {
      const first = validation.issues[0]
      return { state: 'damaged', reason: `it fails validation (${first === undefined ? 'unknown' : `${first.path}: ${first.message}`})` }
    }
    return { state: 'valid', config: validation.config, bytes, migratedFrom }
  }

  /** Best-effort read-only view of a newer document: shown only if it also satisfies the current schema. */
  function viewOfNewer(document: Record<string, unknown>): Config {
    const validation = validateConfig({ ...document, schemaVersion: CURRENT_SCHEMA_VERSION })
    return validation.ok ? validation.config : emptyConfig()
  }

  async function uniqueTarget(name: (stamp: string) => string): Promise<string> {
    const stamp = fileTimestamp(now())
    for (let i = 0; i < 100; i += 1) {
      const target = join(paths.dir, name(i === 0 ? stamp : `${stamp}-${i}`))
      if (!(await fs.exists(target))) return target
    }
    throw new Error('No free file name for a preserved configuration file')
  }

  /** Sets `mode` on `path`; a missing path is skipped and an unsupported chmod is logged, not fatal. */
  async function restrict(path: string, mode: number): Promise<void> {
    try {
      await fs.chmod(path, mode)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return
      if (!isChmodUnsupported(error)) throw error
      log.record('warn', 'config.chmod-failed', { path, message: describe(error) })
    }
  }

  const tighten = (path: string): Promise<void> => restrict(path, FILE_MODE)

  /** Moves a damaged file aside under a distinct name; it is never deleted. */
  async function preserveDamaged(path: string, name: (stamp: string) => string): Promise<string> {
    const target = await uniqueTarget(name)
    await fs.rename(path, target)
    try {
      await fs.chmod(target, FILE_MODE)
    } catch (error) {
      log.record('warn', 'config.chmod-failed', { path: target, message: describe(error) })
    }
    return target
  }

  /** Writes `bytes` as `config.json.bak` (previous version) and `config` as `config.json`, then commits. */
  async function persist(config: Config): Promise<void> {
    const bytes = serializeConfig(config)
    // One directory fsync after the primary rename also persists the backup rename.
    if (knownGood !== null) await writeFileAtomic(fs, paths.backup, knownGood, { syncDirectory: false })
    try {
      await writeFileAtomic(fs, paths.config, bytes, { syncDirectory })
    } catch (error) {
      if (!(error instanceof DirectorySyncError)) throw error
      log.record('warn', 'config.directory-sync-failed', { message: describe(error.cause) })
    }
    state = deepFreeze(config)
    knownGood = bytes
  }

  /** Saves during load. A failure is reported, and the configuration stays usable in memory. */
  async function persistDuringLoad(config: Config, notices: ConfigNotice[]): Promise<void> {
    try {
      await persist(config)
    } catch (error) {
      log.record('error', 'config.save-failed', { message: describe(error) })
      state = deepFreeze(config)
      notices.push({
        kind: 'save-failed',
        message: `Veydr could not save its configuration (${describe(error)}). Changes may be lost when Veydr exits.`,
        files: [paths.config],
      })
    }
  }

  function readOnly(reason: ReadOnlyReason, config: Config): void {
    status = { writable: false, reason }
    state = deepFreeze(config)
  }

  async function loadInto(notices: ConfigNotice[]): Promise<void> {
    await fs.mkdir(paths.dir, DIRECTORY_MODE)
    // mkdir does not change an existing directory, and its mode is filtered by the umask.
    await restrict(paths.dir, DIRECTORY_MODE)

    const primary = await readCandidate(paths.config)

    if (primary.state === 'newer') {
      readOnly('newer-schema', viewOfNewer(primary.document))
      notices.push({
        kind: 'newer-schema',
        message: `The configuration was created by a newer version of Veydr (schema version ${primary.version}; this version supports ${CURRENT_SCHEMA_VERSION}). It is shown read-only and changes are disabled.`,
        files: [paths.config],
      })
      return
    }

    if (primary.state === 'valid') {
      await tighten(paths.config)
      await tighten(paths.backup)
      knownGood = primary.bytes
      if (primary.migratedFrom === null) {
        state = deepFreeze(primary.config)
        return
      }
      if (await keepPreMigrationCopy(primary, paths.config, notices)) {
        await persistDuringLoad(primary.config, notices)
      }
      return
    }

    const backup = await readCandidate(paths.backup)

    if (primary.state === 'missing' && backup.state === 'missing') {
      // First launch: create the configuration file.
      await persistDuringLoad(emptyConfig(), notices)
      return
    }

    if (backup.state === 'newer') {
      readOnly('newer-schema', viewOfNewer(backup.document))
      notices.push({
        kind: 'newer-schema',
        message: `The configuration file ${primary.state === 'missing' ? 'is missing' : `cannot be used because ${primary.reason}`}, and its backup was created by a newer version of Veydr (schema version ${backup.version}). Nothing was changed; configuration changes are disabled.`,
        files: [paths.config, paths.backup],
      })
      return
    }

    const fallback = backup.state === 'valid' ? backup.config : emptyConfig()
    const preserved: string[] = []
    try {
      if (primary.state === 'damaged') preserved.push(await preserveDamaged(paths.config, corruptConfigName))
      if (backup.state === 'damaged') preserved.push(await preserveDamaged(paths.backup, corruptBackupName))
    } catch (error) {
      log.record('error', 'config.preserve-failed', { message: describe(error) })
      readOnly('preservation-failed', fallback)
      notices.push({
        kind: 'preservation-failed',
        message: `The configuration is damaged and could not be kept for inspection (${describe(error)}). Configuration changes are disabled so that it is not overwritten.`,
        files: [paths.config, paths.backup, ...preserved],
      })
      return
    }

    const why = primary.state === 'missing' ? 'it is missing' : primary.reason
    const kept = preserved.map((p) => basename(p)).join(', ')
    if (backup.state === 'valid') {
      // The backup stays as the known-good copy (content untouched) until the next regular save.
      await tighten(paths.backup)
      knownGood = null
      // Reported first: the damaged file has already been moved, whatever happens next.
      notices.push({
        kind: 'recovered-from-backup',
        message: `The configuration file could not be used because ${why}. Veydr loaded the backup instead.${kept === '' ? '' : ` The damaged file was kept as ${kept}.`}`,
        files: preserved,
      })
      if (backup.migratedFrom !== null && !(await keepPreMigrationCopy(backup, paths.backup, notices))) {
        return
      }
      await persistDuringLoad(backup.config, notices)
      return
    }

    knownGood = null
    notices.push({
      kind: 'reset-to-empty',
      message: `Neither the configuration file nor its backup could be used (configuration: ${why}; backup: ${backup.state === 'missing' ? 'it is missing' : backup.reason}). Veydr started with an empty configuration.${kept === '' ? '' : ` The damaged files were kept as ${kept}.`}`,
      files: preserved,
    })
    await persistDuringLoad(emptyConfig(), notices)
  }

  /**
   * Keeps the pre-migration bytes under a distinct name before anything
   * migrated is written. If that fails, nothing is written and changes are
   * disabled. Returns whether writing may proceed.
   */
  async function keepPreMigrationCopy(
    candidate: Extract<Candidate, { state: 'valid' }>,
    source: string,
    notices: ConfigNotice[],
  ): Promise<boolean> {
    const fromVersion = candidate.migratedFrom ?? CURRENT_SCHEMA_VERSION
    try {
      const target = await uniqueTarget((stamp) => preMigrationName(fromVersion, stamp))
      try {
        await writeFileAtomic(fs, target, candidate.bytes, { syncDirectory })
      } catch (error) {
        // The copy is in place; only its directory flush failed (as for a regular save).
        if (!(error instanceof DirectorySyncError)) throw error
        log.record('warn', 'config.directory-sync-failed', { message: describe(error.cause) })
      }
      log.record('info', 'config.migrated', { from: fromVersion, to: CURRENT_SCHEMA_VERSION, source, backup: target })
      return true
    } catch (error) {
      log.record('error', 'config.preserve-failed', { message: describe(error) })
      readOnly('preservation-failed', candidate.config)
      notices.push({
        kind: 'preservation-failed',
        message: `The configuration needs to be upgraded from schema version ${fromVersion}, but a copy of the original could not be kept (${describe(error)}). Configuration changes are disabled so that it is not overwritten.`,
        files: [source],
      })
      return false
    }
  }

  function current(): Config {
    if (state === null) throw new Error('Configuration is not loaded')
    return state
  }

  return {
    async load() {
      if (loadStarted) throw new Error('Configuration is already loaded')
      loadStarted = true
      const notices: ConfigNotice[] = []
      await loadInto(notices)
      for (const notice of notices) log.record('warn', 'config.notice', { kind: notice.kind, message: notice.message })
      return { config: current(), status, notices }
    },

    current,

    status: () => status,

    update(change) {
      const run = queue.then(async () => {
        if (state === null) throw new Error('Configuration is not loaded')
        if (!status.writable) throw new ConfigReadOnlyError(status.reason)
        const validation = validateConfig(change(structuredClone(state)))
        if (!validation.ok) throw new ConfigValidationError(validation.issues)
        await persist(validation.config)
        return current()
      })
      queue = run.catch(() => undefined)
      return run
    },
  }
}
