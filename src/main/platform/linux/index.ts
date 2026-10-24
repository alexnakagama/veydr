import { NotImplementedError } from '../errors'
import type { Platform, PlatformLog } from '../types'
import { createLinuxProcessTree } from './process-tree'
import { createLinuxSurvivors } from './survivors'

const notYet = (operation: string): never => {
  throw new NotImplementedError(operation)
}
const notYetAsync = (operation: string): Promise<never> =>
  Promise.reject(new NotImplementedError(operation))

export interface LinuxPlatformOptions {
  readonly log?: PlatformLog
}

/**
 * Linux platform. Process trees (L3) and crash survivors (L4) are implemented; the remaining
 * operations are placeholders until their task groups land (detached launch, resolver and
 * environment in L5, ports in L7).
 */
export function createLinuxPlatform(options: LinuxPlatformOptions = {}): Platform {
  const logOption = options.log === undefined ? {} : { log: options.log }
  const tree = createLinuxProcessTree(logOption)
  const survivors = createLinuxSurvivors(logOption)
  return {
    name: 'linux',
    supported: true,
    processTree: {
      spawn: (plan) => tree.spawn(plan),
      launchDetached: () => notYet('processTree.launchDetached'),
      findSurvivors: (entries) => survivors.findSurvivors(entries),
      terminateSurvivors: (found) => survivors.terminateSurvivors(found),
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
