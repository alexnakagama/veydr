import type { CommandProcessState, ProcessSnapshot, ProcessStateEvent, RunState } from '../../shared/api'
import { belongsToCurrentRun } from '../../shared/api/runs'

/** State of a command that has not run in this session. */
const IDLE: RunState = { status: 'idle', pid: null, startedAt: null, exit: null, error: null, survivors: [] }

export interface ProcessStateRegistry {
  /**
   * Records a new state for `runId` of `commandId`, stamps it with the event envelope
   * (`{commandId, runId, seq}`), and emits it. `seq` increases per command across runs.
   * A state of a run other than the current one that does not start a new run is a late event:
   * it is neither recorded nor emitted, and `null` is returned (spec: late events ignored).
   */
  record(commandId: string, runId: string, state: RunState): ProcessStateEvent | null
  /** Current state of each of `commandIds`, in that order; unknown commands are idle. */
  snapshot(commandIds: readonly string[]): ProcessSnapshot
  /** Drops the state of a removed command. Its sequence counter is kept, so `seq` never repeats. */
  forget(commandId: string): void
}

/**
 * Main-side source of truth for per-command process state (design D7). The supervisor records
 * transitions here; `processes.snapshot` and `processes.onState` read from it.
 */
export function createProcessStateRegistry(emit: (event: ProcessStateEvent) => void): ProcessStateRegistry {
  const states = new Map<string, ProcessStateEvent>()
  // Kept for removed commands too (bounded by the commands created in this session).
  const sequences = new Map<string, number>()

  return {
    record(commandId, runId, state) {
      if (!belongsToCurrentRun(states.get(commandId), runId, state.status)) return null
      const seq = (sequences.get(commandId) ?? 0) + 1
      sequences.set(commandId, seq)
      const event: ProcessStateEvent = { commandId, runId, seq, ...state, survivors: state.survivors.map((s) => ({ ...s })) }
      states.set(commandId, event)
      emit(event)
      return event
    },

    snapshot(commandIds) {
      return {
        commands: commandIds.map((commandId): CommandProcessState => {
          const state = states.get(commandId)
          if (state === undefined) return { commandId, runId: null, seq: sequences.get(commandId) ?? 0, ...IDLE, survivors: [] }
          return { ...state, survivors: state.survivors.map((s) => ({ ...s })) }
        }),
      }
    },

    forget(commandId) {
      states.delete(commandId)
    },
  }
}
