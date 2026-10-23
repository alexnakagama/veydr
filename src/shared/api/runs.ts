/**
 * Run rules shared by main (`src/main/supervisor/state.ts`) and the renderer stores. No zod here:
 * the renderer bundle imports it.
 */

/** The part of a command's known state the run rule looks at. */
export interface KnownRun {
  readonly runId: string | null
}

/**
 * True if a state event of `runId` with `status` may become the command's current state: it
 * belongs to the current run, or it starts a new run. Anything else is a late event of a previous
 * run (spec: late events ignored).
 *
 * A late `starting` of an older run would be accepted. The supervisor (L3) must therefore emit a
 * run's `starting` before any other state of that run and never after a newer run has started.
 */
export function belongsToCurrentRun(known: KnownRun | undefined, runId: string, status: string): boolean {
  return runId === (known?.runId ?? null) || status === 'starting'
}
