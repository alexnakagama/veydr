// Types for scripts/release-version.mjs, so TypeScript tests can import its pure functions.

export interface Version {
  major: number
  minor: number
  patch: number
  /** Dot-separated prerelease identifiers; empty for a release version. */
  prerelease: string[]
}

export type CheckResult = { ok: true; tag: string; prerelease: boolean } | { ok: false; error: string }

export const FORMAT: string
export function parseVersion(text: string): Version | null
export function compareVersions(a: string, b: string): -1 | 0 | 1
export function checkVersion(input: { requested: string; current: string; tags: readonly string[] }): CheckResult
