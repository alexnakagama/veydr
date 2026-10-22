import { createUnsupportedPlatform } from '../unsupported'
import type { Platform } from '../types'

/** Windows is not implemented in this change; every operation is unsupported. */
export function createWindowsPlatform(): Platform {
  return createUnsupportedPlatform('windows', 'win32')
}
