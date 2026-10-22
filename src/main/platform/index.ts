import { createLinuxPlatform } from './linux'
import { createUnsupportedPlatform } from './unsupported'
import { createWindowsPlatform } from './windows'
import type { Platform } from './types'

export { NotImplementedError, UnsupportedPlatformError } from './errors'
export type * from './types'

/**
 * Selects the platform implementation. Together with the composition root,
 * this is the only module allowed to read `process.platform`.
 */
export function selectPlatform(os: NodeJS.Platform = process.platform): Platform {
  switch (os) {
    case 'linux':
      return createLinuxPlatform()
    case 'win32':
      return createWindowsPlatform()
    default:
      return createUnsupportedPlatform('unsupported', os)
  }
}
