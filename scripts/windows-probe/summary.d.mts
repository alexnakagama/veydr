// Types for scripts/windows-probe/summary.mjs.
import type { CatalogEntry, Prediction, ProbeArea, Revision } from './checks.mjs'

export type Answer = 'yes' | 'no' | null
export type Status = 'PASS' | 'FAIL' | 'EXPECTED-FAIL' | 'NOT-TESTABLE'
export type User = 'admin' | 'standard'

/** A probe job's identity line (design D4). */
export interface Identity {
  readonly area: ProbeArea
  /** The runner's ImageOS and ImageVersion variables. */
  readonly imageOS: string
  readonly imageVersion: string
  readonly windowsBuild: string
  readonly node: string
  readonly negativeControl: boolean
}

export interface ResultLine {
  readonly id: string
  readonly answer: Answer
  readonly detail: string
  readonly data: { readonly context: { readonly user: User; readonly console: 'none' | 'present' }; readonly [key: string]: unknown }
  /** `<source>:<line>`, for error messages. */
  readonly where: string
}

export interface ResultsFile {
  readonly source: string
  readonly identity: Identity
  readonly lines: readonly ResultLine[]
}

export interface SummaryLine {
  readonly id: string
  readonly status: Status
  /** Whether REVISIONS lists the check. */
  readonly revised: boolean
  readonly detail: string
}

export interface Summary {
  readonly commit: string
  readonly runId: string
  readonly date: string
  readonly checksHash: string
  readonly negativeControl: boolean
  /** Distinct Windows identities, with the areas measured on each. */
  readonly images: readonly { imageOS: string; imageVersion: string; windowsBuild: string; node: string; areas: readonly ProbeArea[] }[]
  /** Areas and accounts (`<area> as <user>`) whose control did not answer yes. */
  readonly invalid: readonly { where: string; reasons: readonly string[] }[]
  /** One per catalog entry, sorted by ID. */
  readonly lines: readonly SummaryLine[]
}

export const STATUSES: readonly Status[]
export const NO_RESULT: string

export class ProbeResultError extends Error {
  readonly problems: readonly string[]
}

export function deriveStatus(prediction: Prediction, answer: Answer): Status
export function parseResults(text: string, source: string): ResultsFile | null
export function summarize(input: {
  results: readonly (ResultsFile | null)[]
  commit: string
  runId: string
  checksHash: string
  date: string
  checks?: readonly CatalogEntry[]
  revisions?: readonly Revision[]
}): Summary
export function formatSummary(summary: Summary): string
