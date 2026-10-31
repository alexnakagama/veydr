// Types for scripts/windows-probe/tree-files.mjs.
export const WORKER: string
export const WORKER_LIFETIME_MS: number
export function specFile(dir: string, name: string): string
export function readyFile(dir: string, name: string): string
export function errorFile(dir: string, name: string): string
export function markerFile(dir: string, name: string, signal: string): string
export function writeAtomic(file: string, text: string): void
export function workerCommand(spec: string): string
