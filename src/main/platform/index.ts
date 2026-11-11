import { join } from 'node:path'
import { createLinuxPlatform } from './linux'
import { createUnsupportedPlatform } from './unsupported'
import { createWindowsPlatform } from './windows'
import type { Platform, PlatformConventions, PlatformLog } from './types'

export { NotImplementedError, UnsupportedPlatformError } from './errors'
export type * from './types'

/** Conventions assumed for any other operating system: POSIX-like, with no default shell. */
const UNSUPPORTED_CONVENTIONS: PlatformConventions = { envNames: 'exact', defaultShell: null, directorySync: true }

/** Where the composition root finds the Windows helper; see {@link windowsHelperPath}. */
export interface WindowsHelperLocation {
  /** `app.isPackaged`. */
  readonly packaged: boolean
  /** `app.getAppPath()`: the repository root unpackaged, `<resources>\app.asar` packaged. */
  readonly appPath: string
  /** `process.resourcesPath`: the directory that holds `app.asar` in a packaged app. */
  readonly resourcesPath: string
}

/**
 * Where the Windows helper is (add-windows-packaging design D2).
 *
 * - Packaged: `<resourcesPath>\veydr-helper.exe`, beside `app.asar`, where electron-builder's
 *   `win.extraResources` places it. The application path is inside `app.asar`, from which no
 *   executable can be started, so the helper is never looked up below it.
 * - Unpackaged (development, tests): `<appPath>\out-helper\veydr-helper.exe`, where
 *   `scripts/build-windows-helper.mjs` builds it (add-windows-process-supervision design D5).
 *
 * Only the location is chosen here. The Windows platform checks the file before every use (an
 * absolute path, a regular file, the protocol version), so a missing helper is reported, not run.
 */
export function windowsHelperPath(location: WindowsHelperLocation): string {
  return location.packaged
    ? join(location.resourcesPath, 'veydr-helper.exe')
    : join(location.appPath, 'out-helper', 'veydr-helper.exe')
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
