// Types for scripts/windows-probe/placeholder.mjs.
import type { CatalogEntry } from './checks.mjs'
import type { RunDriverOptions, User } from './driver.mjs'

export const NOT_IMPLEMENTED: string

export function placeholderIds(area: string, user: User, checks?: readonly CatalogEntry[]): string[]

export function placeholderUsers(area: string, checks?: readonly CatalogEntry[]): User[]

export function runPlaceholder(args: readonly string[], options?: Partial<Pick<RunDriverOptions, 'measure' | 'probeDirectory' | 'write'>>): Promise<void>
