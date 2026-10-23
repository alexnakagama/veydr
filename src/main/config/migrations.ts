import { CURRENT_SCHEMA_VERSION } from '../../shared/config'

/** Converts a document of version `from` into a document of version `from + 1`. Must be pure. */
export type Migration = (document: Readonly<Record<string, unknown>>) => Record<string, unknown>

/** Migrations keyed by the version they migrate from. */
export type Migrations = Readonly<Record<number, Migration>>

/**
 * Forward-only migrations of this build. Version 1 is the first released
 * schema, so there is nothing to migrate yet; a v1 → v2 change adds `1: …`
 * here together with a fixture test.
 */
export const migrations: Migrations = {}

export type VersionCheck =
  | { readonly kind: 'current' }
  | { readonly kind: 'older'; readonly version: number }
  | { readonly kind: 'newer'; readonly version: number }
  | { readonly kind: 'invalid'; readonly reason: string }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads `schemaVersion` from a parsed document without validating anything else. */
export function checkVersion(document: unknown, current: number = CURRENT_SCHEMA_VERSION): VersionCheck {
  if (!isRecord(document)) return { kind: 'invalid', reason: 'The document is not a JSON object' }
  const version = document['schemaVersion']
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    return { kind: 'invalid', reason: 'schemaVersion is missing or not a non-negative integer' }
  }
  if (version === current) return { kind: 'current' }
  return version < current ? { kind: 'older', version } : { kind: 'newer', version }
}

export type MigrationResult =
  | { readonly ok: true; readonly document: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string }

/**
 * Applies `from → from+1 → … → current`. Fails if a step is missing, throws,
 * or does not produce the next version. The result still has to be validated
 * against the current schema.
 */
export function migrate(
  document: Readonly<Record<string, unknown>>,
  from: number,
  available: Migrations,
  current: number = CURRENT_SCHEMA_VERSION,
): MigrationResult {
  let migrated: Record<string, unknown> = structuredClone(document)
  for (let version = from; version < current; version += 1) {
    const step = available[version]
    if (step === undefined) return { ok: false, reason: `No migration from schema version ${version}` }
    try {
      migrated = step(migrated)
    } catch (error) {
      return {
        ok: false,
        reason: `Migration from schema version ${version} failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (!isRecord(migrated) || migrated['schemaVersion'] !== version + 1) {
      return { ok: false, reason: `Migration from schema version ${version} did not produce version ${version + 1}` }
    }
  }
  return { ok: true, document: migrated }
}
