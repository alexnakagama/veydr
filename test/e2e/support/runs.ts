import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import type { CommandConfig, Config } from '../../../src/shared/config'
import { TAG_VARIABLE } from '../../support/proc'
import { collectNetworkReport, type NetworkReport } from './network'

/** Veydr's runtime ledger for a config home (design D4, D9). */
export function ledgerFile(configHome: string): string {
  return join(configHome, 'Veydr', 'runtime', 'ledger.json')
}

export interface RecordedRun {
  readonly runId: string
  readonly leader: { readonly pid: number }
  readonly descendants: readonly { readonly pid: number }[]
}

/** Runs recorded in the ledger; `null` if there is no ledger file. */
export function recordedRuns(configHome: string): RecordedRun[] | null {
  const path = ledgerFile(configHome)
  if (!existsSync(path)) return null
  return (JSON.parse(readFileSync(path, 'utf8')) as { entries: RecordedRun[] }).entries
}

/** Resolves with the exit code once the app's main process has exited. */
export function exited(app: ElectronApplication): Promise<number | null> {
  const child = app.process()
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)))
}

/** What the network observers saw for an app that already exited on its own. */
export function networkReportOf(workDir: string): NetworkReport {
  return collectNetworkReport(join(workDir, 'node-net.jsonl'), join(workDir, 'netlog.json'))
}

/** A configuration with one project whose commands all carry the scenario tag. */
export function taggedConfig(projectPath: string, tag: string, commands: readonly Omit<CommandConfig, 'env' | 'cwd'>[]): Config {
  return {
    schemaVersion: 1,
    projects: [
      {
        id: '7a2e9b5d-4d2f-4f66-8b8c-1e7e2a3c0b12',
        name: 'fixtures',
        path: projectPath,
        commands: commands.map((command) => ({ ...command, cwd: '.', env: [{ key: TAG_VARIABLE, value: tag, secret: false }] })),
      },
    ],
    settings: { editor: null },
  }
}
