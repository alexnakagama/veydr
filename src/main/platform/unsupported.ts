import type { PlatformName } from '../../shared/api'
import { UnsupportedPlatformError } from './errors'
import type { Platform, PlatformConventions } from './types'

/**
 * A platform whose every operation rejects with `UnsupportedPlatformError`. `conventions` are the
 * operating system's own, so shared code already follows them while the operations are missing.
 */
export function createUnsupportedPlatform(name: PlatformName, osName: string, conventions: PlatformConventions): Platform {
  const rejected = (operation: string): Promise<never> =>
    Promise.reject(new UnsupportedPlatformError(osName, operation))

  return {
    name,
    supported: false,
    conventions,
    processTree: {
      spawn: () => rejected('processTree.spawn'),
      launchDetached: () => rejected('processTree.launchDetached'),
      findSurvivors: () => rejected('processTree.findSurvivors'),
      terminateSurvivors: () => rejected('processTree.terminateSurvivors'),
    },
    commandResolver: {
      resolve: () => rejected('commandResolver.resolve'),
    },
    envProvider: {
      base: () => rejected('envProvider.base'),
    },
    portInspector: {
      list: () => rejected('portInspector.list'),
    },
  }
}
