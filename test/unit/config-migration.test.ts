import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyConfig, type Config } from '../../src/shared/config'
import { nodeConfigFs, type ConfigFs } from '../../src/main/config/fs'
import { CURRENT_SCHEMA_VERSION } from '../../src/shared/config'
import { checkVersion, migrate, migrations, type Migrations } from '../../src/main/config/migrations'
import { ConfigReadOnlyError, createConfigStore, serializeConfig } from '../../src/main/config/store'
import { config, fixturesDir, project, quietLog, tempDir } from './support/config'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function setupDir(files: Record<string, Uint8Array | string>): string {
  const { dir: root, cleanup } = tempDir()
  cleanups.push(cleanup)
  const dir = join(root, 'Veydr')
  mkdirSync(dir, { mode: 0o700 })
  for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data, { mode: 0o600 })
  return dir
}

const fixture = (name: string): Buffer => readFileSync(join(fixturesDir, name))
const fixedNow = () => new Date('2026-10-23T09:15:02.123Z')
const STAMP = '2026-10-23T09-15-02-123Z'
const files = (dir: string): string[] => readdirSync(dir).sort()

/** Synthetic v0 → v1: `title`/`root` became `name`/`path`; commands and settings were added. */
const synthetic: Migrations = {
  0: (doc) => ({
    schemaVersion: 1,
    projects: (doc['projects'] as { id: string; title: string; root: string }[]).map((p) => ({
      id: p.id,
      name: p.title,
      path: p.root,
      commands: [],
    })),
    settings: { editor: null },
  }),
}

const migratedV0: Config = {
  schemaVersion: 1,
  projects: [
    { id: '3f1c2a4e-8b7d-4c6e-9a1f-2b3c4d5e6f70', name: 'Shop', path: '/home/dev/shop', commands: [] },
    { id: '7a2b9c1d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', name: 'Blog', path: '/home/dev/blog', commands: [] },
  ],
  settings: { editor: null },
}

/** Records renames so the order of file replacements can be asserted. */
function renameRecorder(): { fs: ConfigFs; renames: string[] } {
  const renames: string[] = []
  return {
    renames,
    fs: {
      ...nodeConfigFs,
      async rename(from, to) {
        await nodeConfigFs.rename(from, to)
        renames.push(to.slice(to.lastIndexOf('/') + 1))
      },
    },
  }
}

describe('migrating an older schema (synthetic v0 → v1 fixture)', () => {
  it('[spec:config-storage/older-schema-migrated] migrates, keeping the pre-migration file before the migrated file is written', async () => {
    const original = fixture('v0.json')
    const dir = setupDir({ 'config.json': original })
    const { fs, renames } = renameRecorder()

    const store = createConfigStore({ dir, log: quietLog(), fs, migrations: synthetic, now: fixedNow })
    const result = await store.load()

    expect(result).toEqual({ config: migratedV0, status: { writable: true }, notices: [] })
    const preMigration = `config.pre-migration-v0-${STAMP}.json`
    expect(files(dir)).toEqual(['config.json', 'config.json.bak', preMigration])
    // The original is kept byte for byte, with mode 0600, and was in place before config.json was replaced.
    expect(readFileSync(join(dir, preMigration))).toEqual(original)
    expect(statSync(join(dir, preMigration)).mode & 0o777).toBe(0o600)
    expect(renames).toEqual([preMigration, 'config.json.bak', 'config.json'])
    // config.json now holds the migrated document; the backup is the previous (v0) file.
    expect(readFileSync(join(dir, 'config.json'))).toEqual(Buffer.from(serializeConfig(migratedV0)))
    expect(readFileSync(join(dir, 'config.json.bak'))).toEqual(original)

    // A second launch finds a current file and does nothing.
    const again = await createConfigStore({ dir, log: quietLog(), migrations: synthetic, now: fixedNow }).load()
    expect(again).toEqual({ config: migratedV0, status: { writable: true }, notices: [] })
    expect(files(dir)).toEqual(['config.json', 'config.json.bak', preMigration])
  })

  it('migrates a v0 backup during recovery and keeps a pre-migration copy of it', async () => {
    const original = fixture('v0.json')
    const dir = setupDir({ 'config.json': 'damaged', 'config.json.bak': original })
    const result = await createConfigStore({ dir, log: quietLog(), migrations: synthetic, now: fixedNow }).load()
    expect(result.config).toEqual(migratedV0)
    expect(result.notices.map((n) => n.kind)).toEqual(['recovered-from-backup'])
    expect(readFileSync(join(dir, `config.pre-migration-v0-${STAMP}.json`))).toEqual(original)
    expect(readFileSync(join(dir, 'config.json.bak'))).toEqual(original)
    expect(readFileSync(join(dir, `config.corrupt-${STAMP}.json`), 'utf8')).toBe('damaged')
  })

  it('writes nothing migrated and disables changes if the pre-migration copy cannot be kept', async () => {
    const original = fixture('v0.json')
    const dir = setupDir({ 'config.json': original })
    const failing: ConfigFs = {
      ...nodeConfigFs,
      createExclusive: () => Promise.reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })),
    }
    const store = createConfigStore({ dir, log: quietLog(), fs: failing, migrations: synthetic, now: fixedNow })
    const result = await store.load()
    expect(result.config).toEqual(migratedV0)
    expect(result.status).toEqual({ writable: false, reason: 'preservation-failed' })
    expect(result.notices.map((n) => n.kind)).toEqual(['preservation-failed'])
    expect(readFileSync(join(dir, 'config.json'))).toEqual(original)
    expect(files(dir)).toEqual(['config.json'])
    await expect(store.update((c) => c)).rejects.toBeInstanceOf(ConfigReadOnlyError)
  })

  it('still reports the recovery when the backup needs migrating and its pre-migration copy fails', async () => {
    const dir = setupDir({ 'config.json': 'damaged', 'config.json.bak': fixture('v0.json') })
    const failing: ConfigFs = {
      ...nodeConfigFs,
      createExclusive: () => Promise.reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })),
    }
    const result = await createConfigStore({ dir, log: quietLog(), fs: failing, migrations: synthetic, now: fixedNow }).load()
    expect(result.notices.map((n) => n.kind)).toEqual(['recovered-from-backup', 'preservation-failed'])
    expect(result.notices[0]?.message).toContain(`config.corrupt-${STAMP}.json`)
    expect(result.status).toEqual({ writable: false, reason: 'preservation-failed' })
    expect(readFileSync(join(dir, 'config.json.bak'))).toEqual(fixture('v0.json'))
  })

  it('treats a failed directory flush after the pre-migration copy as kept', async () => {
    const original = fixture('v0.json')
    const dir = setupDir({ 'config.json': original })
    let dirSyncs = 0
    const flakyDirSync: ConfigFs = {
      ...nodeConfigFs,
      async openDirectory(path) {
        const handle = await nodeConfigFs.openDirectory(path)
        dirSyncs += 1
        if (dirSyncs > 1) return handle
        return { sync: () => Promise.reject(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })), close: () => handle.close() }
      },
    }
    const log = quietLog()
    const result = await createConfigStore({ dir, log, fs: flakyDirSync, migrations: synthetic, now: fixedNow }).load()
    expect(result).toEqual({ config: migratedV0, status: { writable: true }, notices: [] })
    expect(readFileSync(join(dir, `config.pre-migration-v0-${STAMP}.json`))).toEqual(original)
    expect(log.entries().map((e) => e.event)).toContain('config.directory-sync-failed')
  })

  it('has a migration for every version between the oldest supported one and the current one', () => {
    // Guards against a forgotten step: a gap would send older files down the damage path.
    const versions = Object.keys(migrations).map(Number).sort((a, b) => a - b)
    if (versions.length === 0) return
    const oldest = versions[0] ?? CURRENT_SCHEMA_VERSION
    expect(versions).toEqual(Array.from({ length: CURRENT_SCHEMA_VERSION - oldest }, (_, i) => oldest + i))
  })

  it('treats a version without a migration path as damaged (this build ships no migrations)', async () => {
    expect(migrations).toEqual({})
    const dir = setupDir({ 'config.json': fixture('v0.json'), 'config.json.bak': serializeConfig(config()) })
    const result = await createConfigStore({ dir, log: quietLog(), now: fixedNow }).load()
    expect(result.notices.map((n) => n.kind)).toEqual(['recovered-from-backup'])
    expect(result.notices[0]?.message).toContain('No migration from schema version 0')
    expect(readFileSync(join(dir, `config.corrupt-${STAMP}.json`))).toEqual(fixture('v0.json'))
  })
})

describe('a newer schema (synthetic v2 fixture)', () => {
  it('leaves the file byte-identical and disables changes', async () => {
    const original = fixture('v2.json')
    const dir = setupDir({ 'config.json': original })
    const before = statSync(join(dir, 'config.json'))

    const store = createConfigStore({ dir, log: quietLog(), now: fixedNow })
    const result = await store.load()

    expect(result.status).toEqual({ writable: false, reason: 'newer-schema' })
    expect(result.notices).toHaveLength(1)
    expect(result.notices[0]).toMatchObject({ kind: 'newer-schema', files: [join(dir, 'config.json')] })
    expect(result.notices[0]?.message).toContain('created by a newer version of Veydr (schema version 2')
    expect(result.notices[0]?.message).toContain('changes are disabled')
    // Extra v2 fields do not fit the v1 schema, so nothing is shown rather than a partial guess.
    expect(result.config).toEqual(emptyConfig())

    await expect(store.update((c) => ({ ...c, projects: [project()] }))).rejects.toBeInstanceOf(ConfigReadOnlyError)

    expect(readFileSync(join(dir, 'config.json'))).toEqual(original)
    const after = statSync(join(dir, 'config.json'))
    expect({ mtime: after.mtimeMs, ctime: after.ctimeMs, mode: after.mode }).toEqual({
      mtime: before.mtimeMs,
      ctime: before.ctimeMs,
      mode: before.mode,
    })
    expect(files(dir)).toEqual(['config.json'])
  })

  it('shows a newer document read-only when it also fits the current schema', async () => {
    const doc = { ...config(), schemaVersion: 7 }
    const dir = setupDir({ 'config.json': JSON.stringify(doc) })
    const result = await createConfigStore({ dir, log: quietLog() }).load()
    expect(result.status).toEqual({ writable: false, reason: 'newer-schema' })
    expect(result.config).toEqual({ ...doc, schemaVersion: 1 })
  })

  it('modifies nothing when config.json is damaged and the backup is from a newer version', async () => {
    const original = fixture('v2.json')
    const dir = setupDir({ 'config.json': 'damaged', 'config.json.bak': original })
    const result = await createConfigStore({ dir, log: quietLog(), now: fixedNow }).load()
    expect(result.status).toEqual({ writable: false, reason: 'newer-schema' })
    expect(result.notices.map((n) => n.kind)).toEqual(['newer-schema'])
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe('damaged')
    expect(readFileSync(join(dir, 'config.json.bak'))).toEqual(original)
    expect(files(dir)).toEqual(['config.json', 'config.json.bak'])
  })
})

describe('migration framework', () => {
  it('reads schemaVersion without validating the rest', () => {
    expect(checkVersion({ schemaVersion: 1 })).toEqual({ kind: 'current' })
    expect(checkVersion({ schemaVersion: 0 })).toEqual({ kind: 'older', version: 0 })
    expect(checkVersion({ schemaVersion: 2 })).toEqual({ kind: 'newer', version: 2 })
    for (const doc of [null, [], 'x', {}, { schemaVersion: '1' }, { schemaVersion: 1.5 }, { schemaVersion: -1 }]) {
      expect(checkVersion(doc).kind, JSON.stringify(doc)).toBe('invalid')
    }
  })

  it('chains steps in order up to the current version', () => {
    const chain: Migrations = {
      0: (d) => ({ ...d, schemaVersion: 1, trail: ['0→1'] }),
      1: (d) => ({ ...d, schemaVersion: 2, trail: [...(d['trail'] as string[]), '1→2'] }),
      2: (d) => ({ ...d, schemaVersion: 3, trail: [...(d['trail'] as string[]), '2→3'] }),
    }
    expect(migrate({ schemaVersion: 1, trail: ['start'] }, 1, chain, 3)).toEqual({
      ok: true,
      document: { schemaVersion: 3, trail: ['start', '1→2', '2→3'] },
    })
    expect(migrate({ schemaVersion: 0 }, 0, chain, 3)).toEqual({
      ok: true,
      document: { schemaVersion: 3, trail: ['0→1', '1→2', '2→3'] },
    })
  })

  it('does not modify its input', () => {
    const input = { schemaVersion: 0, nested: { a: 1 } }
    migrate(input, 0, { 0: (d) => Object.assign(d, { schemaVersion: 1 }) }, 1)
    expect(input).toEqual({ schemaVersion: 0, nested: { a: 1 } })
  })

  it('fails on a missing step, a throwing step, or a step that produces the wrong version', () => {
    expect(migrate({ schemaVersion: 0 }, 0, {}, 1)).toEqual({ ok: false, reason: 'No migration from schema version 0' })
    expect(
      migrate({ schemaVersion: 0 }, 0, { 0: () => { throw new Error('boom') } }, 1),
    ).toEqual({ ok: false, reason: 'Migration from schema version 0 failed: boom' })
    expect(migrate({ schemaVersion: 0 }, 0, { 0: (d) => ({ ...d, schemaVersion: 5 }) }, 1)).toEqual({
      ok: false,
      reason: 'Migration from schema version 0 did not produce version 1',
    })
  })

  it('rejects a migrated document that fails the current schema', async () => {
    const dir = setupDir({ 'config.json': fixture('v0.json') })
    const broken: Migrations = { 0: () => ({ schemaVersion: 1, projects: 'nope', settings: { editor: null } }) }
    const result = await createConfigStore({ dir, log: quietLog(), migrations: broken, now: fixedNow }).load()
    expect(result.notices.map((n) => n.kind)).toEqual(['reset-to-empty'])
    expect(result.notices[0]?.message).toContain('fails validation (projects')
    expect(readFileSync(join(dir, `config.corrupt-${STAMP}.json`))).toEqual(fixture('v0.json'))
  })
})
