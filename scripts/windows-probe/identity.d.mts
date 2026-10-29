// Types for scripts/windows-probe/identity.mjs.

export class IdentityError extends Error {
  readonly problems: readonly string[]
}

export function identityLine(input: {
  area: string
  /** The job's environment: ImageOS, ImageVersion and NEGATIVE_CONTROL are read. */
  env: Readonly<Record<string, string | undefined>>
  windowsBuild: string
  node: string
}): string
