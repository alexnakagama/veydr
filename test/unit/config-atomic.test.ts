import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateConfig, type Config } from '../../src/shared/config'
import { DirectorySyncError, writeFileAtomic } from '../../src/main/config/atomic'
import { nodeConfigFs } from '../../src/main/config/fs'
import { createConfigStore, serializeConfig } from '../../src/main/config/store'
import { config, FaultyFs, project, quietLog, tempDir } from './support/config'

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

describe('writeFileAtomic', () => {
  it('writes the file with mode 0600 and leaves no temporary file', async () => {
    const dir = setupDir()
    const target = join(dir, 'file.json')
    await writeFileAtomic(nodeConfigFs, target, new TextEncoder().encode('{"a":1}'))
    expect(readFileSync(target, 'utf8')).toBe('{"a":1}')
    expect(mode(target)).toBe(0o600)
    expect(() => statSync(`${target}.tmp`)).toThrow()
  })

  it('replaces a stale temporary file from an earlier interruption, including its mode', async () => {
    const dir = setupDir()
    const target = join(dir, 'file.json')
    writeFileSync(`${target}.tmp`, 'partial garbage', { mode: 0o666 })
    await writeFileAtomic(nodeConfigFs, target, new TextEncoder().encode('new'))
    expect(readFileSync(target, 'utf8')).toBe('new')
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

describe('config save under interruption', () => {
  /**
   * Prepares a directory whose config.json is `current` and config.json.bak is
   * `previous`, then loads a store over a faulty filesystem.
   */
  async function prepared(previous: Config, current: Config, log = quietLog()) {
    const dir = setupDir()
    const seed = createConfigStore({ dir, log: quietLog() })
    await seed.load()
    await seed.update(() => previous)
    await seed.update(() => current)
    const fs = new FaultyFs()
    cleanups.push(() => fs.release())
    const store = createConfigStore({ dir, log, fs })
    await store.load()
    return { dir, fs, store }
  }

  const previous = config([project({ name: 'previous' })])
  const current = config([project({ name: 'current' })])
  const next = config([project({ name: 'next' }), project({ name: 'added', path: '/home/dev/added' })])

  /** The save's steps, recorded from an uninterrupted run. */
  async function saveSteps(): Promise<string[]> {
    const { dir, fs, store } = await prepared(previous, current)
    fs.arm(Number.POSITIVE_INFINITY)
    await store.update(() => next)
    // Relative to the configuration directory, for readability.
    return fs.steps.map((step) => step.replaceAll(`${dir}/`, '').replace(new RegExp(` ${dir}$`), ''))
  }

  it('performs the documented step sequence', async () => {
    expect(await saveSteps()).toEqual([
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
      'openDirectory',
      'dir.sync',
      'dir.close',
    ])
  })

  it('[spec:config-storage/interrupted-save] leaves a complete, valid config.json after an interruption at every step', async () => {
    const steps = await saveSteps()
    const primaryRename = steps.indexOf('rename config.json.tmp -> config.json')
    expect(primaryRename).toBeGreaterThan(0)

    for (let failAt = 0; failAt < steps.length; failAt += 1) {
      const { dir, fs, store } = await prepared(previous, current)
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
      const reloaded = createConfigStore({ dir, log: quietLog() })
      const result = await reloaded.load()
      expect(result.notices, label).toEqual([])
      expect(result.config, label).toEqual(failAt <= primaryRename ? current : next)
      await fs.release()
    }
  })

  it('treats a failed directory flush after the rename as saved', async () => {
    const steps = await saveSteps()
    const log = quietLog()
    const { dir, fs, store } = await prepared(previous, current, log)
    fs.arm(steps.indexOf('dir.sync'))
    await expect(store.update(() => next)).resolves.toEqual(next)
    expect(store.current()).toEqual(next)
    expect(readJson(join(dir, 'config.json'))).toEqual(next)
    expect(log.entries().map((e) => e.event)).toContain('config.directory-sync-failed')
  })
})
