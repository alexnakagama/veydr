import { NotImplementedError } from '../errors'
import type { Platform, PlatformLog } from '../types'
import { createLinuxProcessTree } from './process-tree'

const notYet = (operation: string): never => {
  throw new NotImplementedError(operation)
}
const notYetAsync = (operation: string): Promise<never> =>
  Promise.reject(new NotImplementedError(operation))

export interface LinuxPlatformOptions {
  readonly log?: PlatformLog
}

/**
 * Linux platform. Process trees are implemented (L3); the remaining operations are placeholders
 * until their task groups land (survivors in L4, detached launch, resolver and environment in L5,
 * ports in L7).
 */
export function createLinuxPlatform(options: LinuxPlatformOptions = {}): Platform {
  const tree = createLinuxProcessTree(options.log === undefined ? {} : { log: options.log })
  return {
    name: 'linux',
    supported: true,
    processTree: {
      spawn: (plan) => tree.spawn(plan),
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
