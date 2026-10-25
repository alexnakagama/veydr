import type { AppInfo } from '../../shared/api'
import type { Config } from '../../shared/config'
import type { LogService } from '../logs/service'
import type { DesktopActions } from '../projects/desktop'
import { previewEntries, type EnvironmentService } from '../projects/environment'
import { findCommand } from '../projects/lookup'
import type { ProjectService } from '../projects/service'
import { commandIds } from '../projects/view'
import { NotFoundError } from '../errors'
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
  readonly projects: ProjectService
  readonly environment: EnvironmentService
  readonly desktop: DesktopActions
  readonly logs: Pick<LogService, 'read' | 'clear' | 'ack'>
}

/**
 * The handler of every operation in the contract. Operations whose services land in later task
 * groups answer with a `not_implemented` error until then: ports (L7).
 */
export function createOperationHandlers(services: HandlerServices): OperationHandlers {
  const { info, config, processStates, supervisor, recovery, projects, environment, desktop, logs } = services
  return {
    app: {
      getInfo: () => info,
    },
    projects: {
      list: () => projects.list(),
      pickDirectory: () => desktop.pickDirectory(),
      add: (request) => projects.add(request),
      update: (request) => projects.rename(request),
      remove: async ({ projectId }) => {
        await projects.remove(projectId)
        return null
      },
      relocate: (request) => projects.relocate(request),
      openFolder: async ({ projectId }) => {
        await desktop.openFolder(projectId)
        return null
      },
      openInEditor: async ({ projectId }) => {
        await desktop.openInEditor(projectId)
        return null
      },
    },
    commands: {
      upsert: ({ projectId, command }) => projects.upsertCommand(projectId, command),
      remove: async ({ commandId }) => {
        await projects.removeCommand(commandId)
        return null
      },
      previewEnvironment: async ({ commandId, refresh }) => {
        const found = findCommand(config(), commandId)
        if (found === null) throw new NotFoundError(`Command ${commandId} does not exist`)
        const base = await (refresh ? environment.refresh() : environment.base())
        return { entries: previewEntries(base.env, found.command), warnings: [...base.warnings] }
      },
      revealSecret: ({ commandId, key }) => ({ value: projects.revealSecret(commandId, key) }),
    },
    processes: {
      snapshot: () => processStates.snapshot(commandIds(config())),
      start: ({ commandId }) => supervisor.start(commandId),
      stop: ({ commandId }) => supervisor.stop(commandId),
      restart: ({ commandId }) => supervisor.restart(commandId),
      resolveSurvivors: async ({ action }) => ({ remaining: await recovery.resolve(action) }),
    },
    logs: {
      read: (request) => logs.read(request),
      clear: ({ runId }) => logs.clear(runId),
      ack: ({ batchId }) => {
        logs.ack(batchId)
        return null
      },
    },
    ports: {
      list: notImplemented('ports.list'),
    },
    settings: {
      get: () => config().settings,
      setEditor: ({ editor }) => projects.setEditor(editor),
    },
  }
}
