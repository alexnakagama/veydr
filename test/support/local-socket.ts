import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectPlatform } from '../../src/main/platform'

/**
 * Fresh paths for a local `net` server, as the host supports them: a named pipe on Windows (where
 * `net` servers are named pipes), a Unix socket in a private temporary directory elsewhere. Both run
 * the same tests; only the transport differs. `cleanup` removes the directory.
 */
export function localSockets(): { next: () => string; cleanup: () => void } {
  if (selectPlatform().name === 'windows') {
    return { next: () => `\\\\.\\pipe\\veydr-test-${randomBytes(16).toString('hex')}`, cleanup: () => undefined }
  }
  const dir = mkdtempSync(join(tmpdir(), 'veydr-sock-'))
  let n = 0
  return { next: () => join(dir, `ctl-${++n}.sock`), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
