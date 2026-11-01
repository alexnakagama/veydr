// Types for scripts/windows-probe/commands.mjs.
import type { ProgramResult, RunDriverOptions } from './driver.mjs'
import type { AnswerDetail } from './process-tree.mjs'

export const SHIM_LINE: string
export const RECORD_FILE: string

export function previewArgs(args: readonly string[]): string[]
export function directSpawnAnswer(spawned: { started?: boolean; code?: string }): AnswerDetail
export function withoutEnvironment(recorded: readonly string[], intended: readonly string[], env: Readonly<Record<string, string | undefined>>): string[]
export function stderrWithoutEnvironment(stderr: string, env: Readonly<Record<string, string | undefined>>): string
export function refusalAnswer(input: { expected: boolean; reason: string; shim: string }): AnswerDetail
export function routeAnswer(input: { intended: readonly string[]; recorded: readonly string[] | undefined; shown?: readonly string[] | undefined; sentinel: boolean; run: ProgramResult }): AnswerDetail
export function pathextAnswer(input: { pathext: string | undefined; where: ProgramResult; run: ProgramResult }): AnswerDetail
export function pathextCwdAnswer(input: { sentinel: boolean; run: ProgramResult }): AnswerDetail

export function runCommands(args: readonly string[], options?: Partial<RunDriverOptions>): Promise<void>
