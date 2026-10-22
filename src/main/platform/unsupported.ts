import type { PlatformName } from '../../shared/api'
import { UnsupportedPlatformError } from './errors'
import type { Platform } from './types'

/**
 * A platform whose every operation fails with `UnsupportedPlatformError`:
 * synchronous operations throw, asynchronous ones reject.
 */
export function createUnsupportedPlatform(name: PlatformName, osName: string): Platform {
  const unsupported = (operation: string): never => {
    throw new UnsupportedPlatformError(osName, operation)
  }
  const rejected = (operation: string): Promise<never> =>
    Promise.reject(new UnsupportedPlatformError(osName, operation))

  return {
    name,
    supported: false,
    processTree: {
      spawn: () => unsupported('processTree.spawn'),
      launchDetached: () => unsupported('processTree.launchDetached'),
      findSurvivors: () => rejected('processTree.findSurvivors'),
      terminateSurvivors: () => rejected('processTree.terminateSurvivors'),
    },
    commandResolver: {
      resolve: () => unsupported('commandResolver.resolve'),
    },
    envProvider: {
      base: () => rejected('envProvider.base'),
    },
    portInspector: {
      list: () => rejected('portInspector.list'),
    },
  }
}
