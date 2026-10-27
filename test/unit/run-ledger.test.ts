import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nodeConfigFs, type ConfigFs } from '../../src/main/config/fs'
import type { LedgerEntry } from '../../src/main/platform/types'
import { createRunLedger, damagedLedgerName, LEDGER_UPDATE_INTERVAL_MS, ledgerPath } from '../../src/main/supervisor/ledger'
import { FaultyFs, quietLog, tempDir } from './support/config'

// Task 5.1: the runtime ledger (design D9).

const cleanups: (() => void)[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function dir(): string {
  const t = tempDir()
  cleanups.push(t.cleanup)
  return t.dir
}

const entry = (runId: string, pid = 4242): LedgerEntry => ({
  commandId: `cmd-${runId}`,
  runId,
  leader: { pid, token: `boot:${pid}00` },
  sessionId: pid,
  descendants: [],
})

const onDisk = (configDir: string): { version: number; entries: LedgerEntry[] } =>
  JSON.parse(readFileSync(ledgerPath(configDir), 'utf8')) as { version: number; entries: LedgerEntry[] }

/** The real filesystem, counting completed ledger writes (renames onto the ledger). */
function countingFs(): ConfigFs & { writes: number } {
  const fs = {
    ...nodeConfigFs,
    writes: 0,
    rename: async (from: string, to: string) => {
      await nodeConfigFs.rename(from, to)
      fs.writes += 1
    },
  }
  return fs
}

describe('run ledger', () => {
  it('starts empty when no ledger exists', async () => {
    const ledger = createRunLedger({ dir: dir(), log: quietLog() })
    expect(await ledger.load()).toEqual({ entries: [], problem: null })
    expect(ledger.entries()).toEqual([])
  })

  it('writes a started run at once, in a 0700 directory as a 0600 file', async () => {
    const configDir = dir()
    const ledger = createRunLedger({ dir: configDir, log: quietLog() })
    await ledger.load()
    void ledger.add(entry('a'))
    await ledger.flush()
    expect(onDisk(configDir)).toEqual({ version: 1, entries: [entry('a')] })
    expect(statSync(ledgerPath(configDir)).mode & 0o777).toBe(0o600)
    expect(statSync(join(configDir, 'runtime')).mode & 0o777).toBe(0o700)
  })

  it('clears a run when it is removed; the file is empty once every run has ended', async () => {
    const configDir = dir()
    const ledger = createRunLedger({ dir: configDir, log: quietLog() })
    await ledger.load()
    void ledger.add(entry('a', 10))
    void ledger.add(entry('b', 20))
    await ledger.flush()
    ledger.remove('a')
    await ledger.flush()
    expect(onDisk(configDir).entries.map((e) => e.runId)).toEqual(['b'])
    ledger.remove('b')
    ledger.remove('unknown')
    await ledger.flush()
    expect(onDisk(configDir)).toEqual({ version: 1, entries: [] })
  })

  it('writes descendant updates at most once per second, and new runs at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let clock = 1_000_000
    const fs = countingFs()
    const configDir = dir()
    const ledger = createRunLedger({ dir: configDir, log: quietLog(), fs, now: () => clock })
    await ledger.load()
    void ledger.add(entry('a'))
    await vi.waitFor(() => expect(fs.writes).toBe(1))

    for (let i = 1; i <= 5; i += 1) ledger.updateDescendants('a', [{ pid: 5000 + i, token: `boot:${i}` }])
    clock += 200
    await vi.advanceTimersByTimeAsync(200)
    expect(fs.writes).toBe(1)
    clock += LEDGER_UPDATE_INTERVAL_MS
    await vi.advanceTimersByTimeAsync(LEDGER_UPDATE_INTERVAL_MS)
    await vi.waitFor(() => expect(fs.writes).toBe(2))
    expect(onDisk(configDir).entries[0]?.descendants).toEqual([{ pid: 5005, token: 'boot:5' }])

    // An unchanged set is not written again.
    ledger.updateDescendants('a', [{ pid: 5005, token: 'boot:5' }])
    clock += 5 * LEDGER_UPDATE_INTERVAL_MS
    await vi.advanceTimersByTimeAsync(5 * LEDGER_UPDATE_INTERVAL_MS)
    expect(fs.writes).toBe(2)

    // A pending update is written together with a new run, without waiting.
    ledger.updateDescendants('a', [])
    void ledger.add(entry('b', 77))
    await vi.waitFor(() => expect(fs.writes).toBe(3))
    expect(onDisk(configDir).entries).toEqual([entry('a'), entry('b', 77)])
    await ledger.flush()
    expect(fs.writes).toBe(3)
  })

  it('flush writes a pending descendant update without waiting for the interval', async () => {
    const configDir = dir()
    const ledger = createRunLedger({ dir: configDir, log: quietLog() })
    await ledger.load()
    void ledger.add(entry('a'))
    await ledger.flush()
    ledger.updateDescendants('a', [{ pid: 9, token: 'boot:9' }])
    await ledger.flush()
    expect(onDisk(configDir).entries[0]?.descendants).toEqual([{ pid: 9, token: 'boot:9' }])
  })

  it('ignores descendant updates of runs it does not hold', async () => {
    const fs = countingFs()
    const ledger = createRunLedger({ dir: dir(), log: quietLog(), fs })
    await ledger.load()
    ledger.updateDescendants('nope', [{ pid: 9, token: 'boot:9' }])
    await ledger.flush()
    expect(fs.writes).toBe(0)
  })

  it('loads the previous session’s runs as inherited, separate from this session’s', async () => {
    const configDir = dir()
    const first = createRunLedger({ dir: configDir, log: quietLog() })
    await first.load()
    void first.add(entry('old'))
    await first.flush()

    const second = createRunLedger({ dir: configDir, log: quietLog() })
    expect(await second.load()).toEqual({ entries: [entry('old')], problem: null })
    void second.add(entry('new', 99))
    expect(second.entries().map((e) => e.runId)).toEqual(['old', 'new'])
    expect(second.sessionEntries().map((e) => e.runId)).toEqual(['new'])
    second.remove('old')
    await second.flush()
    expect(onDisk(configDir).entries.map((e) => e.runId)).toEqual(['new'])
  })

  it('skips the directory flush when the platform cannot flush a directory', async () => {
    const configDir = dir()
    let opened = 0
    const fs: ConfigFs = {
      ...nodeConfigFs,
      openDirectory: () => {
        opened += 1
        return Promise.reject(Object.assign(new Error('EISDIR: illegal operation on a directory'), { code: 'EISDIR' }))
      },
    }
    const log = quietLog()
    const errors: string[] = []
    const ledger = createRunLedger({ dir: configDir, log, fs, directorySync: false, onWriteError: (message) => errors.push(message) })
    await ledger.load()
    await ledger.add(entry('a'))
    ledger.remove('a')
    await ledger.flush()
    expect(onDisk(configDir)).toEqual({ version: 1, entries: [] })
    expect(opened).toBe(0)
    expect(errors).toEqual([])
    expect(log.entries().map((e) => e.event)).not.toContain('ledger.write-failed')
    expect(log.entries().map((e) => e.event)).not.toContain('config.directory-sync-failed')
  })

  it('reports a damaged ledger instead of guessing its content, and keeps it for inspection', async () => {
    const configDir = dir()
    const runtime = join(configDir, 'runtime')
    mkdirSync(runtime)
    const contents = ['{not json', JSON.stringify({ version: 1, entries: [{ runId: 'x' }] }), JSON.stringify({ version: 2, entries: [] })]
    for (const [i, content] of contents.entries()) {
      writeFileSync(ledgerPath(configDir), content)
      const ledger = createRunLedger({ dir: configDir, log: quietLog(), now: () => Date.UTC(2026, 9, 24) })
      const loaded = await ledger.load()
      const kept = join(runtime, damagedLedgerName(i === 0 ? '2026-10-24T00-00-00-000Z' : `2026-10-24T00-00-00-000Z-${i}`))
      expect(loaded).toEqual({ entries: [], problem: `${ledgerPath(configDir)} is damaged; it was kept as ${kept}` })
      expect(readFileSync(kept, 'utf8')).toBe(content)
      // The next write does not destroy the evidence.
      await ledger.add(entry('a'))
      expect(readFileSync(kept, 'utf8')).toBe(content)
    }
    expect(readdirSync(runtime).filter((name) => name.startsWith('ledger.damaged-'))).toHaveLength(3)
  })

  it('reports a ledger that cannot be read and moves it aside', async () => {
    const configDir = dir()
    mkdirSync(join(configDir, 'runtime'))
    writeFileSync(ledgerPath(configDir), '{}')
    const fs: ConfigFs = {
      ...nodeConfigFs,
      readFile: () => Promise.reject(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })),
    }
    const loaded = await createRunLedger({ dir: configDir, log: quietLog(), fs, now: () => Date.UTC(2026, 9, 24) }).load()
    const kept = join(configDir, 'runtime', damagedLedgerName('2026-10-24T00-00-00-000Z'))
    expect(loaded).toEqual({ entries: [], problem: `${ledgerPath(configDir)} could not be read (EIO: i/o error); it was kept as ${kept}` })
    expect(existsSync(kept)).toBe(true)
    expect(existsSync(ledgerPath(configDir))).toBe(false)
  })

  it('says so when an unusable ledger cannot be moved aside', async () => {
    const configDir = dir()
    mkdirSync(join(configDir, 'runtime'))
    writeFileSync(ledgerPath(configDir), '{bad')
    const fs: ConfigFs = { ...nodeConfigFs, rename: () => Promise.reject(new Error('EROFS')) }
    expect(await createRunLedger({ dir: configDir, log: quietLog(), fs }).load()).toEqual({ entries: [], problem: `${ledgerPath(configDir)} is damaged` })
  })

  it('reports a failed write and writes the current state with the next change', async () => {
    const configDir = dir()
    let failing = true
    const fs: ConfigFs = {
      ...nodeConfigFs,
      rename: (from, to) => (failing ? Promise.reject(Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' })) : nodeConfigFs.rename(from, to)),
    }
    const errors: string[] = []
    const ledger = createRunLedger({ dir: configDir, log: quietLog(), fs, onWriteError: (message) => errors.push(message) })
    await ledger.load()
    void ledger.add(entry('a'))
    await ledger.flush()
    expect(errors).toEqual(['ENOSPC: no space left'])

    failing = false
    void ledger.add(entry('b', 7))
    await ledger.flush()
    expect(onDisk(configDir).entries.map((e) => e.runId)).toEqual(['a', 'b'])
  })

  it('keeps the previous complete ledger when a write is interrupted at any step', async () => {
    const configDir = dir()
    const base = createRunLedger({ dir: configDir, log: quietLog() })
    await base.load()
    void base.add(entry('a'))
    await base.flush()
    const before = readFileSync(ledgerPath(configDir), 'utf8')

    for (let step = 0; ; step += 1) {
      const fs = new FaultyFs()
      fs.arm(step)
      const ledger = createRunLedger({ dir: configDir, log: quietLog(), fs })
      void ledger.add(entry('a'))
      void ledger.add(entry('b', 8))
      await ledger.flush()
      await fs.release()
      const after = readFileSync(ledgerPath(configDir), 'utf8')
      if (!fs.interrupted) {
        // Every step has been interrupted once; the write without interruption replaced the file.
        expect(JSON.parse(after)).toEqual({ version: 1, entries: [entry('a'), entry('b', 8)] })
        break
      }
      const parsed = JSON.parse(after) as unknown
      expect([before, `${JSON.stringify({ version: 1, entries: [entry('a'), entry('b', 8)] }, null, 2)}\n`]).toContain(after)
      expect(parsed).toBeTruthy()
      // Restore the previous content for the next step.
      writeFileSync(ledgerPath(configDir), before)
    }
  })
})
