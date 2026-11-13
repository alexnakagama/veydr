// Types for scripts/sha256sums.mjs, so TypeScript tests can import it.

export const SUMS_FILE: 'SHA256SUMS'
export function nameProblem(name: string): string | undefined
export function sha256File(file: string): Promise<string>
export function formatLine(hex: string, name: string): string
export function parseSums(text: string): [hex: string, name: string][]
export function writeSums(directory: string, names: readonly string[]): Promise<string>
export function verifySums(directory: string, names: readonly string[], expected: string): Promise<void>
export function main(args: readonly string[]): Promise<number>
