import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from './temp'

export interface Seeded {
  readonly root: string
  readonly configHome: string
  readonly configDir: string
}

/** A temporary config home whose Veydr directory holds the given files. */
export function seed(files: Readonly<Record<string, string>>): Seeded {
  const root = tempDir('veydr-e2e-seed-')
  const configHome = join(root, 'config')
  const configDir = join(configHome, 'Veydr')
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(configDir, name), content, { mode: 0o600 })
  return { root, configHome, configDir }
}
