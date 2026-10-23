import type { CommandProcessState, ProcessSnapshot, ProcessStateEvent, Unsubscribe, VeydrApi } from '../../../shared/api'
import { belongsToCurrentRun } from '../../../shared/api/runs'
import { createStore, UNREACHABLE, type Store } from './store'

export type CommandStates = ReadonlyMap<string, CommandProcessState>

export interface ProcessesState {
  readonly status: 'loading' | 'ready' | 'error'
  /** Why the snapshot could not be loaded. */
  readonly error: string | null
  /** Why live state events cannot be received; states may then be outdated. */
  readonly liveError: string | null
  readonly commands: CommandStates
}

/**
 * Applies a snapshot. Commands missing from it no longer exist and are dropped; a command whose
 * known state is newer than the snapshot (higher `seq`) keeps it.
 */
export function applySnapshot(commands: CommandStates, snapshot: ProcessSnapshot): CommandStates {
  const next = new Map<string, CommandProcessState>()
  for (const entry of snapshot.commands) {
    const known = commands.get(entry.commandId)
    next.set(entry.commandId, known !== undefined && known.seq > entry.seq ? known : entry)
  }
  return next
}

/**
 * Applies a state event, or returns `commands` unchanged when the event must be ignored:
 * - the command is not known (removed, or not yet in a snapshot or project list);
 * - it is not newer than the known state (`seq`), e.g. already reflected by the snapshot;
 * - it belongs to a run other than the command's current one and does not start a new run,
 *   i.e. it is a late event from a previous run (spec: late events ignored). Main applies the
 *   same rule before recording a state.
 */
export function applyStateEvent(commands: CommandStates, event: ProcessStateEvent): CommandStates {
  const known = commands.get(event.commandId)
  if (known === undefined || event.seq <= known.seq) return commands
  if (!belongsToCurrentRun(known, event.runId, event.status)) return commands
  const next = new Map(commands)
  next.set(event.commandId, { ...event })
  return next
}

/**
 * Aligns the known commands with the configured ones: new commands start idle (their first run
 * arrives as a `starting` event), removed ones are dropped so their events are ignored.
 */
export function withCommands(commands: CommandStates, commandIds: readonly string[]): CommandStates {
  const unchanged = commandIds.length === commands.size && commandIds.every((id) => commands.has(id))
  if (unchanged) return commands
  const next = new Map<string, CommandProcessState>()
  for (const commandId of commandIds) {
    next.set(commandId, commands.get(commandId) ?? { commandId, runId: null, seq: 0, status: 'idle', pid: null, startedAt: null, exit: null, error: null, survivors: [] })
  }
  return next
}

/** True if `runId` is the current run of `commandId`; output of any other run must not be shown for it. */
export function isCurrentRun(commands: CommandStates, commandId: string, runId: string): boolean {
  return commands.get(commandId)?.runId === runId
}

export interface ProcessStore extends Store<ProcessesState> {
  /** Handles a live event; events received before the snapshot are held and applied after it. */
  readonly receive: (event: ProcessStateEvent) => void
  readonly loaded: (snapshot: ProcessSnapshot) => void
  readonly failed: (message: string) => void
  /** Live events cannot be received (the subscription was refused or failed). */
  readonly liveFailed: (message: string) => void
  /** Aligns the known commands with the configured ones (see `withCommands`); ignored while loading. */
  readonly setCommands: (commandIds: readonly string[]) => void
  readonly isCurrentRun: (commandId: string, runId: string) => boolean
}

export function createProcessStore(): ProcessStore {
  const store = createStore<ProcessesState>({ status: 'loading', error: null, liveError: null, commands: new Map() })
  let pending: ProcessStateEvent[] | null = []

  const update = (commands: CommandStates): void => {
    const state = store.getState()
    if (commands !== state.commands) store.set({ ...state, commands })
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    receive(event) {
      if (pending !== null) {
        pending.push(event)
        return
      }
      update(applyStateEvent(store.getState().commands, event))
    },
    loaded(snapshot) {
      let commands = applySnapshot(store.getState().commands, snapshot)
      for (const event of pending ?? []) commands = applyStateEvent(commands, event)
      pending = null
      store.set({ ...store.getState(), status: 'ready', error: null, commands })
    },
    failed(message) {
      let commands = store.getState().commands
      for (const event of pending ?? []) commands = applyStateEvent(commands, event)
      pending = null
      store.set({ ...store.getState(), status: 'error', error: message, commands })
    },
    liveFailed(message) {
      store.set({ ...store.getState(), liveError: message })
    },
    setCommands(commandIds) {
      if (pending !== null) return
      update(withCommands(store.getState().commands, commandIds))
    },
    isCurrentRun: (commandId, runId) => isCurrentRun(store.getState().commands, commandId, runId),
  }
}

/**
 * Subscribes to state events first and then loads the snapshot, so no transition between the two
 * is missed; events the snapshot already reflects are dropped by their `seq`.
 */
export function connectProcessStore(store: ProcessStore, api: Pick<VeydrApi['processes'], 'onState' | 'snapshot'>): Unsubscribe {
  const unsubscribe = api.onState(
    (event) => store.receive(event),
    (error) => store.liveFailed(error.message),
  )
  api.snapshot().then(
    (result) => (result.ok ? store.loaded(result.value) : store.failed(result.error.message)),
    () => store.failed(UNREACHABLE),
  )
  return unsubscribe
}
