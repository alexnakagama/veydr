import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandConfig, Config, ProjectConfig } from '../../../src/shared/config'
import { createDiagnosticLog } from '../../../src/main/app/diagnostics'
import { nodeConfigFs, type ConfigFs, type SyncableDirectory, type WritableFile } from '../../../src/main/config/fs'
import { selectPlatform } from '../../../src/main/platform'

export const fixturesDir = join(__dirname, '../../fixtures/config')

/**
 * The conventions of the platform these tests run on, as the composition root selects them. Tests
 * that write through the real filesystem follow them, as production does (e.g. no directory flush
 * on Windows).
 */
export const hostConventions = selectPlatform().conventions

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'veydr-config-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export function quietLog() {
  return createDiagnosticLog(() => undefined)
}

export function command(overrides: Partial<CommandConfig> = {}): CommandConfig {
  return {
    id: crypto.randomUUID(),
    name: 'api',
    execution: { mode: 'direct', file: 'npm', args: ['run', 'dev'] },
    cwd: '.',
    env: [],
    stopTimeoutMs: 5000,
    ...overrides,
  }
}

export function project(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return { id: crypto.randomUUID(), name: 'shop', path: '/home/dev/shop', commands: [command()], ...overrides }
}

export function config(projects: ProjectConfig[] = [project()]): Config {
  return { schemaVersion: 1, projects, settings: { editor: null } }
}

/** Thrown by the faulty filesystem: models the process dying at that step. */
export class Interrupted extends Error {
  override readonly name = 'Interrupted'
}

/**
 * Wraps the real filesystem and interrupts one operation. From the faulted
 * step on, every operation throws, as if the process had died there, so no
 * cleanup code can run. A faulted `writeFile` writes half of its data first.
 */
export class FaultyFs implements ConfigFs {
  readonly steps: string[] = []
  private failAt = Number.POSITIVE_INFINITY
  private dead = false
  private readonly open: { close(): Promise<void> }[] = []

  /** Interrupt the operation with this index (counted from the last `arm`). */
  arm(failAt: number): void {
    this.failAt = failAt
    this.steps.length = 0
    this.dead = false
  }

  get interrupted(): boolean {
    return this.dead
  }

  /** Closes real handles left open by an interruption. */
  async release(): Promise<void> {
    for (const handle of this.open.splice(0)) await handle.close().catch(() => undefined)
  }

  private step<T>(name: string, run: () => Promise<T>, partial?: () => Promise<unknown>): Promise<T> {
    if (this.dead) return Promise.reject(new Interrupted(`dead: ${name}`))
    const index = this.steps.length
    this.steps.push(name)
    if (index !== this.failAt) return run()
    this.dead = true
    const fail = (): Promise<T> => Promise.reject(new Interrupted(`interrupted at ${index}: ${name}`))
    return partial === undefined ? fail() : partial().then(fail)
  }

  mkdir = (path: string, mode: number) => this.step(`mkdir ${path}`, () => nodeConfigFs.mkdir(path, mode))
  chmod = (path: string, mode: number) => this.step(`chmod ${path}`, () => nodeConfigFs.chmod(path, mode))
  exists = (path: string) => this.step(`exists ${path}`, () => nodeConfigFs.exists(path))
  readFile = (path: string) => this.step(`readFile ${path}`, () => nodeConfigFs.readFile(path))
  rename = (from: string, to: string) => this.step(`rename ${from} -> ${to}`, () => nodeConfigFs.rename(from, to))
  unlink = (path: string) => this.step(`unlink ${path}`, () => nodeConfigFs.unlink(path))

  createExclusive = (path: string, mode: number): Promise<WritableFile> =>
    this.step(`createExclusive ${path}`, async () => {
      const real = await nodeConfigFs.createExclusive(path, mode)
      this.open.push(real)
      const wrapped: WritableFile = {
        chmod: (m) => this.step(`file.chmod ${path}`, () => real.chmod(m)),
        writeFile: (data) =>
          this.step(
            `file.writeFile ${path}`,
            () => real.writeFile(data),
            () => real.writeFile(data.subarray(0, Math.floor(data.length / 2))),
          ),
        sync: () => this.step(`file.sync ${path}`, () => real.sync()),
        close: () =>
          this.step(`file.close ${path}`, async () => {
            this.open.splice(this.open.indexOf(real), 1)
            await real.close()
          }),
      }
      return wrapped
    })

  /**
   * Records the directory flush without opening the directory, so the step sequence is the same on
   * every platform (Windows cannot flush a directory). The real flush is exercised by the store
   * tests that use the real filesystem on Linux.
   */
  openDirectory = (path: string): Promise<SyncableDirectory> =>
    this.step(`openDirectory ${path}`, () =>
      Promise.resolve({
        sync: () => this.step(`dir.sync ${path}`, () => Promise.resolve()),
        close: () => this.step(`dir.close ${path}`, () => Promise.resolve()),
      }),
    )
}
