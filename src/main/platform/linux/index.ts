import type { Platform, PlatformLog } from '../types'
import { createCleanSpawner } from './executable'
import { createLinuxEnvProvider } from './environment'
import { createLinuxPortInspector } from './ports'
import { createProcReader } from './proc-reader'
import { createLinuxProcessTree } from './process-tree'
import { createLinuxCommandResolver } from './resolver'
import { createLinuxSurvivors } from './survivors'

export interface LinuxPlatformOptions {
  readonly log?: PlatformLog
  /** Veydr's own environment, the fallback and starting point of the login environment. */
  readonly inherited?: Readonly<Record<string, string | undefined>>
}

/**
 * Linux platform: process trees (L3), crash survivors (L4), command resolution and the login
 * environment (L5), and listening ports (L7).
 */
export function createLinuxPlatform(options: LinuxPlatformOptions = {}): Platform {
  const logOption = options.log === undefined ? {} : { log: options.log }
  const proc = createProcReader()
  const tree = createLinuxProcessTree({ proc, ...logOption })
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
    portInspector: createLinuxPortInspector({ bootId: () => proc.bootId(), ...logOption }),
  }
}
