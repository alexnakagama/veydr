import { NotImplementedError } from '../errors'
import type { Platform } from '../types'

const notYet = (operation: string): never => {
  throw new NotImplementedError(operation)
}
const notYetAsync = (operation: string): Promise<never> =>
  Promise.reject(new NotImplementedError(operation))

/**
 * Linux platform. Operations are placeholders until their task groups land
 * (process trees in L3/L4, resolver and environment in L5, ports in L7).
 */
export function createLinuxPlatform(): Platform {
  return {
    name: 'linux',
    supported: true,
    processTree: {
      spawn: () => notYet('processTree.spawn'),
      launchDetached: () => notYet('processTree.launchDetached'),
      findSurvivors: () => notYetAsync('processTree.findSurvivors'),
      terminateSurvivors: () => notYetAsync('processTree.terminateSurvivors'),
    },
    commandResolver: {
      resolve: () => notYet('commandResolver.resolve'),
    },
    envProvider: {
      base: () => notYetAsync('envProvider.base'),
    },
    portInspector: {
      list: () => notYetAsync('portInspector.list'),
    },
  }
}
