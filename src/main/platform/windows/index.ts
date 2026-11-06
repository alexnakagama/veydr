import { createUnsupportedPlatform } from '../unsupported'
import type { Platform, PlatformConventions, PlatformLog } from '../types'
import { createWindowsProcessTree } from './process-tree'

/**
 * Windows conventions (design D1). No default shell yet: Veydr runs `<shell> -c <script>`, but
 * `cmd.exe` uses `/c` and PowerShell's quoting and argument rules differ, so the default shell and
 * its argument convention are chosen together later.
 */
const WINDOWS_CONVENTIONS: PlatformConventions = { envNames: 'case-insensitive', defaultShell: null, directorySync: false }

export interface WindowsPlatformOptions {
  /**
   * Full path of `veydr-helper.exe`, chosen by the composition root. Every process-tree operation
   * that needs the helper rejects while it is missing, not fully qualified, or of another protocol
   * version; nothing is looked up on `PATH`.
   */
  readonly helperPath: string
  readonly log?: PlatformLog
}

/**
 * Windows platform (add-windows-process-supervision design D6): the process tree is real (Job
 * Objects through `veydr-helper.exe`), but the command resolver, the environment (W2), and port
 * inspection (W3) are not implemented yet, and neither is `launchDetached` (W2). The supervisor
 * resolves a command before it spawns one, so starting a command still fails with
 * `UnsupportedPlatformError` and creates no process, and the platform stays `supported: false`.
 */
export function createWindowsPlatform(options: WindowsPlatformOptions): Platform {
  const unsupported = createUnsupportedPlatform('windows', 'win32', WINDOWS_CONVENTIONS)
  const tree = createWindowsProcessTree({
    helperPath: options.helperPath,
    ...(options.log === undefined ? {} : { log: options.log }),
  })
  return {
    ...unsupported,
    processTree: {
      spawn: (plan) => tree.spawn(plan),
      launchDetached: (plan) => unsupported.processTree.launchDetached(plan),
      findSurvivors: (entries) => tree.findSurvivors(entries),
      terminateSurvivors: (found) => tree.terminateSurvivors(found),
    },
  }
}
