import { join } from 'node:path'
import { createLinuxPlatform } from './linux'
import { createUnsupportedPlatform } from './unsupported'
import { createWindowsPlatform } from './windows'
import type { Platform, PlatformConventions, PlatformLog } from './types'

export { NotImplementedError, UnsupportedPlatformError } from './errors'
export type * from './types'

/** Conventions assumed for any other operating system: POSIX-like, with no default shell. */
const UNSUPPORTED_CONVENTIONS: PlatformConventions = { envNames: 'exact', defaultShell: null, directorySync: true }

/**
 * Where the Windows helper is built (`scripts/build-windows-helper.mjs`), below the application
 * path, in development and tests (add-windows-process-supervision design D5). In a packaged app the
 * application path is inside `app.asar`, from which no executable can be started, so W4 must move
 * the helper out of it (e.g. below `process.resourcesPath`); until then a packaged app reports the
 * helper as not found (docs/deferred-checks.md).
 */
export function windowsHelperPath(appPath: string): string {
  return join(appPath, 'out-helper', 'veydr-helper.exe')
}

export interface SelectPlatformOptions {
  readonly log?: PlatformLog
  /**
   * Veydr's own environment. Linux: the fallback and starting point of the login environment.
   * Windows: the environment commands start from, and where `SystemRoot` (for `cmd.exe`) is read.
   */
  readonly inherited?: Readonly<Record<string, string | undefined>>
  /**
   * Full path of the Windows helper, `veydr-helper.exe`, from the composition root. Without it,
   * every Windows process-tree operation that needs the helper rejects; nothing is guessed.
   */
  readonly helperPath?: string
}

/**
 * Selects the platform implementation. Together with the composition root,
 * this is the only module allowed to read `process.platform`.
 */
export function selectPlatform(os: NodeJS.Platform = process.platform, options: SelectPlatformOptions = {}): Platform {
  const { helperPath, ...shared } = options
  switch (os) {
    case 'linux':
      return createLinuxPlatform(shared)
    case 'win32':
      // A composition mistake: shown at startup, not only at the first operation that needs the helper.
      if (helperPath === undefined) options.log?.record('error', 'platform.windows-helper-unconfigured')
      return createWindowsPlatform({ helperPath: helperPath ?? '', ...shared })
    default:
      return createUnsupportedPlatform('unsupported', os, UNSUPPORTED_CONVENTIONS)
  }
}
