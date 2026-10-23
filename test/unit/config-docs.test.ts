import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DIRECTORY_MODE, FILE_MODE } from '../../src/main/config/atomic'
import {
  BACKUP_FILE,
  CONFIG_FILE,
  corruptBackupName,
  corruptConfigName,
  fileTimestamp,
  preMigrationName,
} from '../../src/main/config/paths'
import { CURRENT_SCHEMA_VERSION } from '../../src/shared/config'

const doc = readFileSync(join(__dirname, '../../docs/configuration.md'), 'utf8')

describe('docs/configuration.md matches the implementation', () => {
  it('documents the locations checked by test/integration/config-location.test.ts', () => {
    expect(doc).toContain('`~/.config/Veydr/config.json`')
    expect(doc).toContain('`$XDG_CONFIG_HOME/Veydr/config.json`')
  })

  it('documents every file name the store writes', () => {
    for (const name of [
      CONFIG_FILE,
      BACKUP_FILE,
      corruptConfigName('<timestamp>'),
      corruptBackupName('<timestamp>'),
      preMigrationName(Number.NaN, '<timestamp>').replace('vNaN', 'v<version>'),
      `${CONFIG_FILE}.tmp`,
      `${BACKUP_FILE}.tmp`,
    ]) {
      expect(doc).toContain(`\`${name}\``)
    }
    expect(doc).toContain(`\`${fileTimestamp(new Date('2026-10-23T09:15:02.123Z'))}\``)
  })

  it('documents the modes and the current schema version', () => {
    expect(doc).toContain(`\`0${FILE_MODE.toString(8)}\``)
    expect(doc).toContain(`\`0${DIRECTORY_MODE.toString(8)}\``)
    expect(doc).toContain(`currently \`${CURRENT_SCHEMA_VERSION}\``)
  })

  it('states the plaintext secret limitation', () => {
    expect(doc).toMatch(/secret\*\* are stored \*\*unencrypted\*\*/)
    expect(doc).toContain('best-effort')
  })
})
