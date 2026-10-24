import type { Platform, PlatformLog } from '../types'
import { NotImplementedError } from '../errors'
import { createCleanSpawner } from './executable'
import { createLinuxEnvProvider } from './environment'
import { createLinuxProcessTree } from './process-tree'
import { createLinuxCommandResolver } from './resolver'
import { createLinuxSurvivors } from './survivors'

const notYetAsync = (operation: string): Promise<never> =>
  Promise.reject(new NotImplementedError(operation))

export interface LinuxPlatformOptions {
  readonly log?: PlatformLog
  /** Veydr's own environment, the fallback and starting point of the login environment. */
  readonly inherited?: Readonly<Record<string, string | undefined>>
}

/**
 * Linux platform. Process trees (L3), crash survivors (L4), command resolution and the login
 * environment (L5) are implemented; ports are a placeholder until L7.
 */
export function createLinuxPlatform(options: LinuxPlatformOptions = {}): Platform {
  const logOption = options.log === undefined ? {} : { log: options.log }
  const tree = createLinuxProcessTree(logOption)
  const survivors = createLinuxSurvivors(logOption)
  const env = createLinuxEnvProvider({ inherited: options.inherited ?? process.env, spawner: createCleanSpawner(), ...logOption })
  return {
    name: 'linux',
    supported: true,
    processTree: {
      spawn: (plan) => tree.spawn(plan),
      launchDetached: (plan) => tree.launchDetached(plan),
      findSurvivors: (entries) => survivors.findSurvivors(entries),
      terminateSurvivors: (found) => survivors.terminateSurvivors(found),
    },
    commandResolver: createLinuxCommandResolver(),
    envProvider: env,
    portInspector: {
      list: () => notYetAsync('portInspector.list'),
    },
  }
}
