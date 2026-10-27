// Types for scripts/windows-probe/checks.mjs.

export type Prediction = 'yes' | 'no'
export type ProbeArea = 'process-tree' | 'helper' | 'commands' | 'environment' | 'encoding' | 'ports' | 'electron' | 'nsis'
export type Area = 'context' | ProbeArea

export interface RequiredContext {
  readonly console: 'none'
  readonly user: 'admin' | 'standard' | 'both'
}

/** A check the probes answer. */
export interface Check {
  readonly kind: 'check'
  readonly id: string
  /** The probe area that reports it; `context` checks are reported by every driver. */
  readonly area: Area
  readonly question: string
  readonly prediction: Prediction
  /** Why the prediction was made. */
  readonly reason: string
  /** What the answer feeds (W1–W4, G-4, other checks). */
  readonly feeds: readonly string[]
  readonly context: RequiredContext
  /** Control checks that must answer yes in the same area and account for this answer to count. */
  readonly controls: readonly string[]
  /** Whether this is itself a control check. */
  readonly control: boolean
}

/** A runner limit: never answered, always NOT-TESTABLE with `reason`. */
export interface Limit {
  readonly kind: 'limit'
  readonly id: string
  readonly area: Area
  readonly reason: string
  /** What would verify it. */
  readonly verify: string
}

export type CatalogEntry = Check | Limit

interface RevisionBase {
  readonly id: string
  readonly reason: string
  /** YYYY-MM-DD */
  readonly date: string
}

export type Revision = RevisionBase &
  (
    | { readonly change: 'prediction'; readonly from: Prediction; readonly to: Prediction }
    | { readonly change: 'question'; readonly from: string; readonly to: string }
    | { readonly change: 'added'; readonly to: Prediction; readonly question: string }
    | { readonly change: 'removed'; readonly from: Prediction }
  )

/** One entry of test/windows-probe/predictions.json. */
export interface SnapshotEntry {
  readonly prediction: Prediction
  /** `questionHash` of the question. */
  readonly question: string
}

export const PROBE_AREAS: readonly ProbeArea[]
export const CONTEXT_AREA: 'context'
export const CMD_ROUTES: Readonly<Record<'shell' | 'verbatim', string>>
export const ENCODING_TEST_STRING: string
export const ENCODING_TOOLS: Readonly<Record<'cmd' | 'node' | 'python', string>>
export const ENCODING_VARIANTS: Readonly<Record<'plain' | 'utf8', string>>
export const CHECKS: readonly CatalogEntry[]
export const REVISIONS: readonly Revision[]

export function catalogProblems(checks: readonly CatalogEntry[]): string[]
export function questionHash(question: string): string
export function snapshotPredictions(checks: readonly CatalogEntry[]): Record<string, SnapshotEntry>
export function revisionProblems(checks: readonly CatalogEntry[], snapshot: Readonly<Record<string, unknown>>, revisions: readonly Revision[]): string[]
