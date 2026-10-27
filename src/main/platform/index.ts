import { createLinuxPlatform } from './linux'
import { createUnsupportedPlatform } from './unsupported'
import { createWindowsPlatform } from './windows'
import type { Platform, PlatformConventions, PlatformLog } from './types'

export { NotImplementedError, UnsupportedPlatformError } from './errors'
export type * from './types'

/** Conventions assumed for any other operating system: POSIX-like, with no default shell. */
const UNSUPPORTED_CONVENTIONS: PlatformConventions = { envNames: 'exact', defaultShell: null, directorySync: true }

/**
 * Selects the platform implementation. Together with the composition root,
 * this is the only module allowed to read `process.platform`.
 */
export function selectPlatform(
  os: NodeJS.Platform = process.platform,
  options: { readonly log?: PlatformLog; readonly inherited?: Readonly<Record<string, string | undefined>> } = {},
): Platform {
  switch (os) {
    case 'linux':
      return createLinuxPlatform(options)
    case 'win32':
      return createWindowsPlatform()
    default:
      return createUnsupportedPlatform('unsupported', os, UNSUPPORTED_CONVENTIONS)
  }
}
