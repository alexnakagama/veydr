// Types for scripts/windows-probe/environment.mjs.
import type { ProgramResult, RunDriverOptions } from './driver.mjs'
import type { AnswerDetail } from './process-tree.mjs'

export interface EnvironmentComparison {
  compared: number
  different: string[]
  onlyInRegistry: string[]
  onlyInherited: string[]
}

type Variables = Readonly<Record<string, string>>

export function registryEnvironment(machine: Variables, user: Variables): Map<string, { name: string; value: string }>
export function compareEnvironment(registry: ReadonlyMap<string, { name: string; value: string }>, inherited: Readonly<Record<string, string | undefined>>): EnvironmentComparison
export function registryAnswer(comparison: Pick<EnvironmentComparison, 'compared' | 'different'>): AnswerDetail
export function registryResult(input: { fileText: string | undefined; run: ProgramResult }): { machine: Record<string, string>; user: Record<string, string> } | { error: string }
export function withoutPath<T>(env: Readonly<Record<string, T>>): Record<string, T>
export function parseSeen(stdout: string): [string, string][] | undefined
export function seenForData(seen: readonly (readonly [string, string])[], markers: readonly string[]): { name: string; value: string }[]
export function pathCaseAnswer(input: { seen: readonly (readonly [string, string])[] | undefined; marker: string }): AnswerDetail

export function runEnvironment(args: readonly string[], options?: Partial<RunDriverOptions>): Promise<void>
