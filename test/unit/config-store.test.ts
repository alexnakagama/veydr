import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyConfig, type Config } from '../../src/shared/config'
import { nodeConfigFs, type ConfigFs } from '../../src/main/config/fs'
import {
  ConfigReadError,
  ConfigReadOnlyError,
  ConfigValidationError,
  createConfigStore,
  serializeConfig,
} from '../../src/main/config/store'
import { config, project, quietLog, tempDir } from './support/config'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** A config directory inside a fresh temporary directory (created by the store). */
function setupDir(): string {
  const { dir, cleanup } = tempDir()
  cleanups.push(cleanup)
  return join(dir, 'Veydr')
}

const fixedNow = () => new Date('2026-10-23T09:15:02.123Z')
const STAMP = '2026-10-23T09-15-02-123Z'

function seed(dir: string, files: Record<string, string | Uint8Array | Config>): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === 'string' || content instanceof Uint8Array ? content : serializeConfig(content)
    writeFileSync(join(dir, name), data, { mode: 0o600 })
  }
}

const read = (dir: string, name: string): string => readFileSync(join(dir, name), 'utf8')
const json = (dir: string, name: string): unknown => JSON.parse(read(dir, name))
const mode = (path: string): number => statSync(path).mode & 0o777
const files = (dir: string): string[] => readdirSync(dir).sort()

const good = config([project({ name: 'good' })])
const older = config([project({ name: 'older' })])
/** A valid document except for one byte that is not UTF-8 (a lenient decoder would accept it). */
const notUtf8 = (() => {
  const bytes = serializeConfig(good)
  bytes[Buffer.from(bytes).indexOf('"good"') + 1] = 0xff
  return bytes
})()
const invalidSchema = JSON.stringify({ schemaVersion: 1, projects: [{ id: 'x' }], settings: { editor: null } })

describe('first launch', () => {
  it('creates the directory (0700) and an empty config.json (0600) without notices', async () => {
    const dir = setupDir()
    const result = await createConfigStore({ dir, log: quietLog() }).load()
    expect(result).toEqual({ config: emptyConfig(), status: { writable: true }, notices: [] })
    expect(files(dir)).toEqual(['config.json'])
    expect(json(dir, 'config.json')).toEqual(emptyConfig())
    expect(mode(dir)).toBe(0o700)
    expect(mode(join(dir, 'config.json'))).toBe(0o600)
  })
})

describe('loading a valid configuration', () => {
  it('loads it without writing, and tightens loose modes', async () => {
    const dir = setupDir()
    seed(dir, { 'config.json': good, 'config.json.bak': older })
    chmodSync(dir, 0o755)
    chmodSync(join(dir, 'config.json'), 0o644)
    chmodSync(join(dir, 'config.json.bak'), 0o644)
    const before = read(dir, 'config.json')

    const result = await createConfigStore({ dir, log: quietLog() }).load()
    expect(result).toEqual({ config: good, status: { writable: true }, notices: [] })
    expect(read(dir, 'config.json')).toBe(before)
    expect(mode(dir)).toBe(0o700)
    expect(mode(join(dir, 'config.json'))).toBe(0o600)
    expect(mode(join(dir, 'config.json.bak'))).toBe(0o600)
  })
})

describe('saving', () => {
  it('keeps the previous version as config.json.bak and writes both with mode 0600', async () => {
    const dir = setupDir()
    const store = createConfigStore({ dir, log: quietLog() })
    await store.load()
    await store.update(() => older)
    await store.update(() => good)
    expect(json(dir, 'config.json')).toEqual(good)
    expect(json(dir, 'config.json.bak')).toEqual(older)
    expect(files(dir)).toEqual(['config.json', 'config.json.bak'])
    expect(mode(join(dir, 'config.json'))).toBe(0o600)
    expect(mode(join(dir, 'config.json.bak'))).toBe(0o600)
    expect(mode(dir)).toBe(0o700)
  })

  it('[spec:config-storage/invalid-change-rejected] rejects an invalid change with the field and leaves storage unchanged', async () => {
    const dir = setupDir()
    seed(dir, { 'config.json': good, 'config.json.bak': older })
    const store = createConfigStore({ dir, log: quietLog() })
    await store.load()
    const before = { primary: read(dir, 'config.json'), backup: read(dir, 'config.json.bak') }

    const error: unknown = await store
      .update((c) => ({ ...c, projects: [{ ...good.projects[0]!, name: '' }] }))
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConfigValidationError)
    expect((error as ConfigValidationError).issues).toEqual([{ path: 'projects[0].name', message: 'Must not be empty' }])
    expect((error as Error).message).toContain('projects[0].name: Must not be empty')
    expect({ primary: read(dir, 'config.json'), backup: read(dir, 'config.json.bak') }).toEqual(before)
    expect(files(dir)).toEqual(['config.json', 'config.json.bak'])
    expect(store.current()).toEqual(good)
  })

  it('does not let a change function mutate the committed configuration', async () => {
    const dir = setupDir()
    seed(dir, { 'config.json': good })
    const store = createConfigStore({ dir, log: quietLog() })
    await store.load()
    await expect(
      store.update((c) => {
        c.projects[0]!.name = ''
        return c
      }),
    ).rejects.toBeInstanceOf(ConfigValidationError)
    expect(store.current()).toEqual(good)
    expect(Object.isFrozen(store.current().projects[0])).toBe(true)
  })

  it('serializes updates: each change sees the result of the previous one, in call order', async () => {
    const dir = setupDir()
    const store = createConfigStore({ dir, log: quietLog() })
    await store.load()
    const add = (name: string, path: string) => (c: Config) => ({ ...c, projects: [...c.projects, project({ name, path })] })
    const results = await Promise.allSettled([
      store.update(add('a', '/p/a')),
      store.update(add('b', '/p/b')),
      store.update(add('bad', 'relative')),
      store.update(add('c', '/p/c')),
    ])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected', 'fulfilled'])
    const names = (c: unknown) => (c as Config).projects.map((p) => p.name)
    expect(names(store.current())).toEqual(['a', 'b', 'c'])
    expect(names(json(dir, 'config.json'))).toEqual(['a', 'b', 'c'])
    expect(names(json(dir, 'config.json.bak'))).toEqual(['a', 'b'])
  })

  it('never runs two saves at the same time', async () => {
    const dir = setupDir()
    let active = 0
    let maxActive = 0
    const slowFs: ConfigFs = {
      ...nodeConfigFs,
      async rename(from, to) {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        await nodeConfigFs.rename(from, to)
        active -= 1
      },
    }
    const store = createConfigStore({ dir, log: quietLog(), fs: slowFs })
    await store.load()
    await Promise.all([1, 2, 3, 4].map((n) => store.update((c) => ({ ...c, projects: [project({ path: `/p/${n}` })] }))))
    expect(maxActive).toBe(1)
  })

  it('continues with later updates after a failed save, keeping state unchanged on failure', async () => {
    const dir = setupDir()
    let failNext = false
    const flakyFs: ConfigFs = {
      ...nodeConfigFs,
      async rename(from, to) {
        if (failNext) {
          failNext = false
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
        }
        await nodeConfigFs.rename(from, to)
      },
    }
    const store = createConfigStore({ dir, log: quietLog(), fs: flakyFs })
    await store.load()
    failNext = true
    await expect(store.update(() => good)).rejects.toThrow('ENOSPC')
    expect(store.current()).toEqual(emptyConfig())
    await expect(store.update(() => good)).resolves.toEqual(good)
    expect(json(dir, 'config.json')).toEqual(good)
  })

  it('refuses updates before load', async () => {
    const store = createConfigStore({ dir: setupDir(), log: quietLog() })
    await expect(store.update((c) => c)).rejects.toThrow('not loaded')
    expect(() => store.current()).toThrow('not loaded')
  })
})

describe('recovery', () => {
  for (const [label, damaged] of [
    ['not valid JSON', '{"schemaVersion": 1, "projects": ['],
    ['not UTF-8', notUtf8],
    ['failing validation', invalidSchema],
    ['without a schemaVersion', JSON.stringify({ projects: [], settings: { editor: null } })],
  ] as const) {
    it(`loads the backup when config.json is ${label}, and keeps the damaged file`, async () => {
      const dir = setupDir()
      seed(dir, { 'config.json': damaged, 'config.json.bak': good })
      const damagedBytes = readFileSync(join(dir, 'config.json'))
      const backupBefore = read(dir, 'config.json.bak')

      const store = createConfigStore({ dir, log: quietLog(), now: fixedNow })
      const result = await store.load()

      expect(result.config).toEqual(good)
      expect(result.status).toEqual({ writable: true })
      expect(result.notices).toHaveLength(1)
      expect(result.notices[0]).toMatchObject({ kind: 'recovered-from-backup', files: [join(dir, `config.corrupt-${STAMP}.json`)] })
      expect(result.notices[0]?.message).toContain('loaded the backup')
      expect(result.notices[0]?.message).toContain(`config.corrupt-${STAMP}.json`)
      // The damaged file is kept byte for byte under a distinct name.
      expect(readFileSync(join(dir, `config.corrupt-${STAMP}.json`))).toEqual(damagedBytes)
      expect(mode(join(dir, `config.corrupt-${STAMP}.json`))).toBe(0o600)
      // config.json is valid again; the backup is untouched.
      expect(json(dir, 'config.json')).toEqual(good)
      expect(read(dir, 'config.json.bak')).toBe(backupBefore)
      expect(files(dir)).toEqual(['config.corrupt-2026-10-23T09-15-02-123Z.json', 'config.json', 'config.json.bak'])

      // The next save backs up the recovered version, never the damaged one.
      await store.update(() => older)
      expect(json(dir, 'config.json.bak')).toEqual(good)
      expect(readFileSync(join(dir, `config.corrupt-${STAMP}.json`))).toEqual(damagedBytes)
    })
  }

  it('tightens a loose backup mode during recovery without changing its content', async () => {
    const dir = setupDir()
    seed(dir, { 'config.json': 'not json', 'config.json.bak': good })
    chmodSync(join(dir, 'config.json.bak'), 0o644)
    const before = read(dir, 'config.json.bak')
    await createConfigStore({ dir, log: quietLog(), now: fixedNow }).load()
    expect(mode(join(dir, 'config.json.bak'))).toBe(0o600)
    expect(read(dir, 'config.json.bak')).toBe(before)
  })

  it('loads the backup when config.json is missing but a backup exists', async () => {
    const dir = setupDir()
    seed(dir, { 'config.json.bak': good })
    const result = await createConfigStore({ dir, log: quietLog(), now: fixedNow }).load()
    expect(result.config).toEqual(good)
    expect(result.notices).toMatchObject([{ kind: 'recovered-from-backup', files: [] }])
    expect(result.notices[0]?.message).toContain('it is missing')
    expect(json(dir, 'config.json')).toEqual(good)
  })

  it('starts empty when neither file is usable, keeping both damaged files', async () => {
    const dir = setupDir()
    seed(dir, { 'config.json': 'not json', 'config.json.bak': invalidSchema })
    const result = await createConfigStore({ dir, log: quietLog(), now: fixedNow }).load()

    expect(result.config).toEqual(emptyConfig())
    expect(result.status).toEqual({ writable: true })
    expect(result.notices).toMatchObject([
      {
        kind: 'reset-to-empty',
        files: [join(dir, `config.corrupt-${STAMP}.json`), join(dir, `config.bak.corrupt-${STAMP}.json`)],
      },
    ])
    expect(result.notices[0]?.message).toContain('started with an empty configuration')
    expect(read(dir, `config.corrupt-${STAMP}.json`)).toBe('not json')
    expect(read(dir, `config.bak.corrupt-${STAMP}.json`)).toBe(invalidSchema)
    expect(json(dir, 'config.json')).toEqual(emptyConfig())
    expect(files(dir)).toEqual([`config.bak.corrupt-${STAMP}.json`, `config.corrupt-${STAMP}.json`, 'config.json'])
  })

  it('starts empty when config.json is damaged and there is no backup', async () => {
    const dir = setupDir()
    seed(dir, { 'config.json': '[]' })
    const result = await createConfigStore({ dir, log: quietLog(), now: fixedNow }).load()
    expect(result.config).toEqual(emptyConfig())
    expect(result.notices).toMatchObject([{ kind: 'reset-to-empty', files: [join(dir, `config.corrupt-${STAMP}.json`)] }])
    expect(read(dir, `config.corrupt-${STAMP}.json`)).toBe('[]')
  })

  it('never overwrites an earlier preserved file with the same timestamp', async () => {
    const dir = setupDir()
    seed(dir, { 'config.json': 'second', 'config.json.bak': good, [`config.corrupt-${STAMP}.json`]: 'first' })
    const result = await createConfigStore({ dir, log: quietLog(), now: fixedNow }).load()
    expect(result.notices[0]?.files).toEqual([join(dir, `config.corrupt-${STAMP}-1.json`)])
    expect(read(dir, `config.corrupt-${STAMP}.json`)).toBe('first')
    expect(read(dir, `config.corrupt-${STAMP}-1.json`)).toBe('second')
  })

  it('disables changes and modifies nothing when a damaged file cannot be kept', async () => {
    const dir = setupDir()
    seed(dir, { 'config.json': 'not json', 'config.json.bak': good })
    const noRename: ConfigFs = {
      ...nodeConfigFs,
      rename: () => Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })),
    }
    const store = createConfigStore({ dir, log: quietLog(), fs: noRename, now: fixedNow })
    const result = await store.load()
    expect(result.config).toEqual(good)
    expect(result.status).toEqual({ writable: false, reason: 'preservation-failed' })
    expect(result.notices).toMatchObject([{ kind: 'preservation-failed' }])
    expect(read(dir, 'config.json')).toBe('not json')
    expect(files(dir)).toEqual(['config.json', 'config.json.bak'])
    await expect(store.update(() => older)).rejects.toBeInstanceOf(ConfigReadOnlyError)
  })

  it('reports a failed save during recovery and keeps the recovered configuration in memory', async () => {
    const dir = setupDir()
    seed(dir, { 'config.json': 'not json', 'config.json.bak': good })
    let renames = 0
    const failSecondRename: ConfigFs = {
      ...nodeConfigFs,
      async rename(from, to) {
        renames += 1
        if (renames === 2) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
        await nodeConfigFs.rename(from, to)
      },
    }
    const store = createConfigStore({ dir, log: quietLog(), fs: failSecondRename, now: fixedNow })
    const result = await store.load()
    expect(result.config).toEqual(good)
    expect(result.status).toEqual({ writable: true })
    expect(result.notices.map((n) => n.kind)).toEqual(['recovered-from-backup', 'save-failed'])
    expect(read(dir, `config.corrupt-${STAMP}.json`)).toBe('not json')
  })

  it('records every notice in the diagnostic log', async () => {
    const dir = setupDir()
    seed(dir, { 'config.json': 'not json' })
    const log = quietLog()
    await createConfigStore({ dir, log, now: fixedNow }).load()
    expect(log.entries().filter((e) => e.event === 'config.notice').map((e) => e.detail['kind'])).toEqual(['reset-to-empty'])
  })

  it('stops loading on a read error that says nothing about the content, changing nothing', async () => {
    const dir = setupDir()
    seed(dir, { 'config.json': good, 'config.json.bak': older })
    const before = { primary: read(dir, 'config.json'), backup: read(dir, 'config.json.bak') }
    for (const code of ['EIO', 'EACCES', 'EMFILE']) {
      const failingRead: ConfigFs = {
        ...nodeConfigFs,
        readFile: () => Promise.reject(Object.assign(new Error(`${code}: read failed`), { code })),
      }
      const error: unknown = await createConfigStore({ dir, log: quietLog(), fs: failingRead }).load().catch((e: unknown) => e)
      expect(error, code).toBeInstanceOf(ConfigReadError)
      expect((error as Error).message, code).toContain(`${code}: read failed`)
      expect({ primary: read(dir, 'config.json'), backup: read(dir, 'config.json.bak') }, code).toEqual(before)
      expect(files(dir), code).toEqual(['config.json', 'config.json.bak'])
    }
  })

  it('stops loading when the backup cannot be read during recovery, changing nothing', async () => {
    const dir = setupDir()
    seed(dir, { 'config.json': 'not json', 'config.json.bak': good })
    const backupUnreadable: ConfigFs = {
      ...nodeConfigFs,
      readFile: (path) =>
        path.endsWith('.bak')
          ? Promise.reject(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }))
          : nodeConfigFs.readFile(path),
    }
    await expect(createConfigStore({ dir, log: quietLog(), fs: backupUnreadable }).load()).rejects.toBeInstanceOf(ConfigReadError)
    expect(read(dir, 'config.json')).toBe('not json')
    expect(files(dir)).toEqual(['config.json', 'config.json.bak'])
  })

  it('treats a directory in place of config.json as damage', async () => {
    const dir = setupDir()
    seed(dir, { 'config.json.bak': good })
    mkdirSync(join(dir, 'config.json'))
    const result = await createConfigStore({ dir, log: quietLog(), now: fixedNow }).load()
    expect(result.config).toEqual(good)
    expect(result.notices).toMatchObject([{ kind: 'recovered-from-backup', files: [join(dir, `config.corrupt-${STAMP}.json`)] }])
    expect(result.notices[0]?.message).toContain('it is a directory')
    expect(statSync(join(dir, `config.corrupt-${STAMP}.json`)).isDirectory()).toBe(true)
  })

  it('keeps working where modes cannot be set, and logs it', async () => {
    const dir = setupDir()
    seed(dir, { 'config.json': good })
    const eperm = () => Promise.reject(Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }))
    const noChmod: ConfigFs = {
      ...nodeConfigFs,
      chmod: eperm,
      async createExclusive(path, fileMode) {
        const file = await nodeConfigFs.createExclusive(path, fileMode)
        return { ...file, writeFile: (d) => file.writeFile(d), sync: () => file.sync(), close: () => file.close(), chmod: eperm }
      },
    }
    const log = quietLog()
    const store = createConfigStore({ dir, log, fs: noChmod })
    expect(await store.load()).toMatchObject({ config: good, status: { writable: true }, notices: [] })
    await expect(store.update(() => older)).resolves.toEqual(older)
    expect(json(dir, 'config.json')).toEqual(older)
    expect(log.entries().filter((e) => e.event === 'config.chmod-failed').length).toBeGreaterThan(0)
  })

  it('still fails on an unexpected chmod error', async () => {
    const dir = setupDir()
    const brokenChmod: ConfigFs = {
      ...nodeConfigFs,
      chmod: () => Promise.reject(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })),
    }
    await expect(createConfigStore({ dir, log: quietLog(), fs: brokenChmod }).load()).rejects.toThrow('EIO')
  })

  it('can only be loaded once', async () => {
    const store = createConfigStore({ dir: setupDir(), log: quietLog() })
    await store.load()
    await expect(store.load()).rejects.toThrow('already loaded')
  })
})
