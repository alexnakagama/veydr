// Types for scripts/windows-probe/cmd-corpus.mjs.

export interface CorpusCase {
  /** Stable ID, part of the `cmd-route-<route>-<case>` check IDs. */
  readonly id: string
  /** The arguments the shim's target program must receive exactly. */
  readonly args: readonly string[]
  readonly description: string
}

export function sentinelFor(caseId: string): string
export const CORPUS: readonly CorpusCase[]
