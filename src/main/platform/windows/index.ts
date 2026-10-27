import { createUnsupportedPlatform } from '../unsupported'
import type { Platform, PlatformConventions } from '../types'

/**
 * Windows conventions (design D1). No default shell yet: Veydr runs `<shell> -c <script>`, but
 * `cmd.exe` uses `/c` and PowerShell's quoting and argument rules differ, so the default shell and
 * its argument convention are chosen together later.
 */
const WINDOWS_CONVENTIONS: PlatformConventions = { envNames: 'case-insensitive', defaultShell: null, directorySync: false }

/** Windows is not implemented yet; every operation is unsupported, but its conventions apply. */
export function createWindowsPlatform(): Platform {
  return createUnsupportedPlatform('windows', 'win32', WINDOWS_CONVENTIONS)
}
