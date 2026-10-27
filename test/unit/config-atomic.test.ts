import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateConfig, type Config } from '../../src/shared/config'
import { DEFAULT_RENAME_RETRY, DirectorySyncError, writeFileAtomic } from '../../src/main/config/atomic'
import { nodeConfigFs, type ConfigFs } from '../../src/main/config/fs'
import { createConfigStore, serializeConfig } from '../../src/main/config/store'
import { config, FaultyFs, hostConventions, project, quietLog, tempDir } from './support/config'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function setupDir(): string {
  const { dir, cleanup } = tempDir()
  cleanups.push(cleanup)
  return dir
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const mode = (path: string): number => statSync(path).mode & 0o777

/** Real-filesystem writes flush the directory only where the platform can (as callers in production do). */
const syncDirectory = hostConventions.directorySync

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: rename failed`), { code })

/** The real filesystem, except that the first `times` renames fail with `code`. Counts rename attempts. */
function failingRenames(code: string, times: number): ConfigFs & { readonly renames: number } {
  const fs = {
    ...nodeConfigFs,
    renames: 0,
    async rename(from: string, to: string) {
      fs.renames += 1
      if (fs.renames <= times) throw errno(code)
      await nodeConfigFs.rename(from, to)
    },
  }
  return fs
}

/** Records requested waits without waiting. */
function recordedSleep(): { readonly waits: number[]; sleep: (ms: number) => Promise<void> } {
  const waits: number[] = []
  return { waits, sleep: (ms) => (waits.push(ms), Promise.resolve()) }
}

describe('writeFileAtomic', () => {
  it('writes the file and leaves no temporary file', async () => {
    const dir = setupDir()
    const target = join(dir, 'file.json')
    await writeFileAtomic(nodeConfigFs, target, new TextEncoder().encode('{"a":1}'), { syncDirectory })
    expect(readFileSync(target, 'utf8')).toBe('{"a":1}')
    expect(() => statSync(`${target}.tmp`)).toThrow()
  })

  it('replaces a stale temporary file from an earlier interruption', async () => {
    const dir = setupDir()
    const target = join(dir, 'file.json')
    writeFileSync(`${target}.tmp`, 'partial garbage')
    await writeFileAtomic(nodeConfigFs, target, new TextEncoder().encode('new'), { syncDirectory })
    expect(readFileSync(target, 'utf8')).toBe('new')
    expect(() => statSync(`${target}.tmp`)).toThrow()
  })

  it.skipIf(process.platform !== 'linux')('[linux-only: POSIX file modes] writes the file with mode 0600, also over a stale temporary file', async () => {
    const dir = setupDir()
    const target = join(dir, 'file.json')
    await writeFileAtomic(nodeConfigFs, target, new TextEncoder().encode('{"a":1}'))
    expect(mode(target)).toBe(0o600)
    writeFileSync(`${target}.tmp`, 'partial garbage', { mode: 0o666 })
    await writeFileAtomic(nodeConfigFs, target, new TextEncoder().encode('new'))
    expect(mode(target)).toBe(0o600)
  })

  it('reports a failed directory flush as committed (the new file is in place)', async () => {
    const dir = setupDir()
    const target = join(dir, 'file.json')
    const fs = new FaultyFs()
    // Steps: unlink tmp, create, chmod, write, sync, close, rename, openDirectory, ...
    fs.arm(7)
    const error: unknown = await writeFileAtomic(fs, target, new TextEncoder().encode('new')).catch((e: unknown) => e)
    cleanups.push(() => fs.release())
    expect(fs.steps[7]).toMatch(/^openDirectory /)
    expect(error).toBeInstanceOf(DirectorySyncError)
    expect(readFileSync(target, 'utf8')).toBe('new')
  })
})

describe('writeFileAtomic rename retries', () => {
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

  function previousFile(): string {
    const target = join(setupDir(), 'file.json')
    writeFileSync(target, 'previous', { mode: 0o600 })
    return target
  }

  it('[spec:config-storage/file-briefly-held-by-another-program] retries a busy rename and saves', async () => {
    const target = previousFile()
    const fs = failingRenames('EBUSY', 2)
    const { waits, sleep } = recordedSleep()
    await writeFileAtomic(fs, target, encode('new'), { syncDirectory, renameRetry: { ...DEFAULT_RENAME_RETRY, sleep } })
    expect(readFileSync(target, 'utf8')).toBe('new')
    expect(fs.renames).toBe(3)
    expect(waits).toEqual([50, 100])
    expect(() => statSync(`${target}.tmp`)).toThrow()
  })

  it('[spec:config-storage/file-held-beyond-the-retry-bound] gives up after the last attempt and keeps the previous file', async () => {
    const target = previousFile()
    const fs = failingRenames('EPERM', Number.POSITIVE_INFINITY)
    const { waits, sleep } = recordedSleep()
    const error: unknown = await writeFileAtomic(fs, target, encode('new'), { renameRetry: { ...DEFAULT_RENAME_RETRY, sleep } }).catch(
      (e: unknown) => e,
    )
    expect(error).toMatchObject({ code: 'EPERM', message: 'EPERM: rename failed' })
    expect(fs.renames).toBe(5)
    expect(waits).toEqual([50, 100, 150, 200])
    expect(readFileSync(target, 'utf8')).toBe('previous')
  })

  it('retries EACCES as well', async () => {
    const target = previousFile()
    const fs = failingRenames('EACCES', 1)
    const { sleep } = recordedSleep()
    await writeFileAtomic(fs, target, encode('new'), { syncDirectory, renameRetry: { ...DEFAULT_RENAME_RETRY, sleep } })
    expect(readFileSync(target, 'utf8')).toBe('new')
    expect(fs.renames).toBe(2)
  })

  it('does not retry other errors such as ENOSPC', async () => {
    const target = previousFile()
    const fs = failingRenames('ENOSPC', 1)
    const { waits, sleep } = recordedSleep()
    await expect(writeFileAtomic(fs, target, encode('new'), { renameRetry: { ...DEFAULT_RENAME_RETRY, sleep } })).rejects.toMatchObject({
      code: 'ENOSPC',
    })
    expect(fs.renames).toBe(1)
    expect(waits).toEqual([])
    expect(readFileSync(target, 'utf8')).toBe('previous')
  })

  it('a later save succeeds after giving up, replacing the leftover temporary file', async () => {
    const target = previousFile()
    const { sleep } = recordedSleep()
    const retry = { ...DEFAULT_RENAME_RETRY, sleep }
    await expect(writeFileAtomic(failingRenames('EBUSY', Number.POSITIVE_INFINITY), target, encode('lost'), { renameRetry: retry })).rejects.toThrow('EBUSY')
    await writeFileAtomic(nodeConfigFs, target, encode('new'), { syncDirectory, renameRetry: retry })
    expect(readFileSync(target, 'utf8')).toBe('new')
    expect(() => statSync(`${target}.tmp`)).toThrow()
  })

  it('retries with the default policy when none is given', async () => {
    const target = previousFile()
    const fs = failingRenames('EBUSY', 1)
    await writeFileAtomic(fs, target, encode('new'), { syncDirectory })
    expect(fs.renames).toBe(2)
    expect(readFileSync(target, 'utf8')).toBe('new')
  })

  it.each([
    { attempts: 0, delayMs: 50 },
    { attempts: -1, delayMs: 50 },
    { attempts: 2.5, delayMs: 50 },
    { attempts: Number.NaN, delayMs: 50 },
    { attempts: Number.POSITIVE_INFINITY, delayMs: 50 },
    { attempts: 5, delayMs: -1 },
    { attempts: 5, delayMs: Number.NaN },
  ])('rejects the retry policy $attempts attempts / $delayMs ms before writing anything', async (policy) => {
    const target = previousFile()
    const fs = failingRenames('EBUSY', Number.POSITIVE_INFINITY)
    await expect(writeFileAtomic(fs, target, encode('new'), { renameRetry: policy })).rejects.toBeInstanceOf(RangeError)
    expect(fs.renames).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('previous')
    expect(() => statSync(`${target}.tmp`)).toThrow()
  })
})

describe('config save under interruption', () => {
  /**
   * Prepares a directory whose config.json is `current` and config.json.bak is
   * `previous`, then loads a store over a faulty filesystem that flushes the
   * directory when `directorySync` is true. The faulty filesystem only records
   * the flush, so both settings behave the same on every platform.
   */
  async function prepared(previous: Config, current: Config, { log = quietLog(), directorySync }: { log?: ReturnType<typeof quietLog>; directorySync: boolean }) {
    const dir = setupDir()
    const seed = createConfigStore({ dir, log: quietLog(), directorySync: syncDirectory })
    await seed.load()
    await seed.update(() => previous)
    await seed.update(() => current)
    const fs = new FaultyFs()
    cleanups.push(() => fs.release())
    const store = createConfigStore({ dir, log, fs, directorySync })
    await store.load()
    return { dir, fs, store }
  }

  const previous = config([project({ name: 'previous' })])
  const current = config([project({ name: 'current' })])
  const next = config([project({ name: 'next' }), project({ name: 'added', path: '/home/dev/added' })])

  /** The save's steps, recorded from an uninterrupted run. */
  async function saveSteps(directorySync: boolean): Promise<string[]> {
    const { dir, fs, store } = await prepared(previous, current, { directorySync })
    fs.arm(Number.POSITIVE_INFINITY)
    await store.update(() => next)
    // Relative to the configuration directory, for readability.
    const inDir = `${dir}${sep}`
    const atDir = ` ${dir}`
    return fs.steps.map((step) => {
      const relative = step.replaceAll(inDir, '')
      return relative.endsWith(atDir) ? relative.slice(0, -atDir.length) : relative
    })
  }

  it.each([true, false])('performs the documented step sequence (directory flush: %s)', async (directorySync) => {
    const flush = ['openDirectory', 'dir.sync', 'dir.close']
    expect(await saveSteps(directorySync)).toEqual([
      'unlink config.json.bak.tmp',
      'createExclusive config.json.bak.tmp',
      'file.chmod config.json.bak.tmp',
      'file.writeFile config.json.bak.tmp',
      'file.sync config.json.bak.tmp',
      'file.close config.json.bak.tmp',
      'rename config.json.bak.tmp -> config.json.bak',
      'unlink config.json.tmp',
      'createExclusive config.json.tmp',
      'file.chmod config.json.tmp',
      'file.writeFile config.json.tmp',
      'file.sync config.json.tmp',
      'file.close config.json.tmp',
      'rename config.json.tmp -> config.json',
      ...(directorySync ? flush : []),
    ])
  })

  it.each([true, false])('[spec:config-storage/interrupted-save] leaves a complete, valid config.json after an interruption at every step (directory flush: %s)', async (directorySync) => {
    const steps = await saveSteps(directorySync)
    const primaryRename = steps.indexOf('rename config.json.tmp -> config.json')
    expect(primaryRename).toBeGreaterThan(0)

    for (let failAt = 0; failAt < steps.length; failAt += 1) {
      const { dir, fs, store } = await prepared(previous, current, { directorySync })
      fs.arm(failAt)
      const outcome = await store.update(() => next).then(
        () => 'saved',
        (e: unknown) => e,
      )
      const label = `interrupted at step ${failAt} (${steps[failAt]})`
      expect(fs.interrupted, label).toBe(true)

      // The primary file is complete and valid: the previous version until the rename, the new one after.
      const onDisk = readJson(join(dir, 'config.json'))
      expect(validateConfig(onDisk).ok, label).toBe(true)
      expect(onDisk, label).toEqual(failAt <= primaryRename ? current : next)
      expect(readFileSync(join(dir, 'config.json'), 'utf8'), label).toBe(
        new TextDecoder().decode(serializeConfig(failAt <= primaryRename ? current : next)),
      )
      // The backup is complete and valid too.
      expect([previous, current], label).toContainEqual(readJson(join(dir, 'config.json.bak')))

      // Before the rename, the failure is reported and the in-memory state is unchanged.
      if (failAt <= primaryRename) {
        expect(outcome, label).not.toBe('saved')
        expect(store.current(), label).toEqual(current)
      }

      // A fresh start loads it without recovery.
      const reloaded = createConfigStore({ dir, log: quietLog(), directorySync: syncDirectory })
      const result = await reloaded.load()
      expect(result.notices, label).toEqual([])
      expect(result.config, label).toEqual(failAt <= primaryRename ? current : next)
      await fs.release()
    }
  })

  it('treats a failed directory flush after the rename as saved', async () => {
    const steps = await saveSteps(true)
    const log = quietLog()
    const { dir, fs, store } = await prepared(previous, current, { log, directorySync: true })
    fs.arm(steps.indexOf('dir.sync'))
    await expect(store.update(() => next)).resolves.toEqual(next)
    expect(store.current()).toEqual(next)
    expect(readJson(join(dir, 'config.json'))).toEqual(next)
    expect(log.entries().map((e) => e.event)).toContain('config.directory-sync-failed')
  })
})
