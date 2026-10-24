import type { AppInfo } from '../../shared/api'
import type { Config } from '../../shared/config'
import { commandIds, projectViews } from '../projects/view'
import type { CrashRecovery } from '../supervisor/recovery'
import type { ProcessStateRegistry } from '../supervisor/state'
import type { Supervisor } from '../supervisor/supervisor'
import { notImplemented, type OperationHandlers } from './operations'

export interface HandlerServices {
  readonly info: AppInfo
  /** The committed configuration (`ConfigStore.current`). */
  readonly config: () => Config
  readonly processStates: ProcessStateRegistry
  readonly supervisor: Supervisor
  readonly recovery: Pick<CrashRecovery, 'resolve'>
}

/**
 * The handler of every operation in the contract. Operations whose services land in later task
 * groups answer with a `not_implemented` error until then: projects and settings changes (L5),
 * logs (L6), ports (L7).
 */
export function createOperationHandlers({ info, config, processStates, supervisor, recovery }: HandlerServices): OperationHandlers {
  return {
    app: {
      getInfo: () => info,
    },
    projects: {
      list: () => projectViews(config()),
      pickDirectory: notImplemented('projects.pickDirectory'),
      add: notImplemented('projects.add'),
      update: notImplemented('projects.update'),
      remove: notImplemented('projects.remove'),
      relocate: notImplemented('projects.relocate'),
      openFolder: notImplemented('projects.openFolder'),
      openInEditor: notImplemented('projects.openInEditor'),
    },
    commands: {
      upsert: notImplemented('commands.upsert'),
      remove: notImplemented('commands.remove'),
      previewEnvironment: notImplemented('commands.previewEnvironment'),
      revealSecret: notImplemented('commands.revealSecret'),
    },
    processes: {
      snapshot: () => processStates.snapshot(commandIds(config())),
      start: ({ commandId }) => supervisor.start(commandId),
      stop: ({ commandId }) => supervisor.stop(commandId),
      restart: ({ commandId }) => supervisor.restart(commandId),
      resolveSurvivors: async ({ action }) => ({ remaining: await recovery.resolve(action) }),
    },
    logs: {
      read: notImplemented('logs.read'),
      clear: notImplemented('logs.clear'),
      ack: notImplemented('logs.ack'),
    },
    ports: {
      list: notImplemented('ports.list'),
    },
    settings: {
      get: () => config().settings,
      setEditor: notImplemented('settings.setEditor'),
    },
  }
}
