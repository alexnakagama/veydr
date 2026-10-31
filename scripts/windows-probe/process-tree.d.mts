// Types for scripts/windows-probe/process-tree.mjs.
import type { ChildProcess } from 'node:child_process'
import type { Answer, RunDriverOptions } from './driver.mjs'

export interface Member { name: string; pid: number; created: string }
export interface ProcessRow { Pid: number; Running: boolean; Created: string | null; Error: string | null }
export interface AnswerDetail { answer: Answer; detail: string }
export interface CtrlSend { Attached: boolean; AttachError: number; Sent: boolean; SendError: number }

export function survivors<T extends Member>(members: readonly T[], rows: readonly ProcessRow[], options?: { tolerate?: boolean }): T[]
export function descendantsOf(processes: readonly { Pid: number; Parent: number }[], root: number): number[]
export function allEndedAnswer(members: readonly Member[], left: readonly Member[], action: string): AnswerDetail
export function libuvJobAnswer(input: { childInJob: boolean; childPid: number; ownJob: { Pids?: number[] | null; PidsError?: string | null; LimitFlags?: number | null; LimitsError?: string | null } }): AnswerDetail
export function gracefulAnswer(input: { send: CtrlSend | null; marker: boolean; left: readonly Member[]; helperAlive: boolean; driverEvents: number; unknown?: readonly Member[] }): AnswerDetail
export function ctrlCAnswer(input: { baselineMarker: boolean; groupMarker: boolean; send: CtrlSend }): AnswerDetail
export function consoleWindowAnswer(input: { station: { Name: string; Visible: boolean }; hidden: { Attached: boolean; AttachError: number; Visible: boolean }; shown: { Attached: boolean; AttachError: number; Visible: boolean } }): AnswerDetail
export function reuseAnswer(reuse: { Spawned: number; ElapsedMs: number; ReusedPid: number | null; FirstCreated: string | null; SecondCreated: string | null }): AnswerDetail

export class Helper {
  get alive(): boolean
  request(op: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  alivePing(): Promise<boolean>
  close(): Promise<void>
}

export function startHelper(options?: { start?: () => ChildProcess; timeoutMs?: number }): Promise<Helper>

export function runProcessTree(args: readonly string[], options?: Partial<RunDriverOptions>): Promise<void>
