// Types for scripts/windows-probe/ports.mjs.
import type { Answer, ProgramResult, RunDriverOptions, User } from './driver.mjs'
import type { AnswerDetail } from './process-tree.mjs'

export interface Listener { address: string; port: number }
export interface Row { address: string; port: number; pid: number }
export interface Owner { Pid: number; Name: string | null; NameError: string | null; Created: string | null; CreatedError: string | null; Gone: boolean }
export interface Unreadable { pid: number; name: string | null; nameError?: string; createdError?: string }

type Failed = { error: string }
export type Listing = { rows: Row[] } | Failed
export type TimedListing = { durationsMs: number[]; rows: Row[] } | Failed
export type Owners = { rows: Owner[] } | Failed
export interface PortsResult { ps: TimedListing; api: TimedListing; owners: Owners }

export const LISTEN_ADDRESSES: readonly string[]
export const LATENCY_CALLS: number
export const LATENCY_MEDIAN_MS: number
export const LATENCY_SLOWEST_MS: number

export function parseNetstat(stdout: string): Row[]
export function netstatListing(run: ProgramResult): Listing
export function listenerAnswer(input: { method: string; listing: Listing; listeners: readonly Listener[]; helperPid: number }): AnswerDetail
export function controlAnswer(results: Readonly<Record<string, AnswerDetail>>): AnswerDetail
export function median(values: readonly number[]): number
export function latencyAnswer(listing: TimedListing): AnswerDetail
export function unreadableOwners(owners: readonly Owner[]): Unreadable[]
export function ownerAnswer(input: { section: Owners; helperPid: number }): AnswerDetail
export function portsResult(input: { fileText: string | undefined; run: ProgramResult }): PortsResult
export function portAnswers(input: {
  user: User
  listener: { pid: number; listeners: readonly Listener[] }
  netstat?: Listing
  script: PortsResult
}): Record<string, { answer: Answer; detail: string; data: Record<string, unknown> }>
export function startListener(options?: { addresses?: readonly string[]; timeoutMs?: number }): Promise<{ pid: number; listeners: Listener[]; alive: () => boolean; stop: () => Promise<void> }>

export function runPorts(args: readonly string[], options?: Partial<RunDriverOptions>): Promise<void>
