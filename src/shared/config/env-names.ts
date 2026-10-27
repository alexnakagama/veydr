/**
 * How the operating system compares environment variable names: exactly on Linux, without regard
 * to letter case on Windows. Chosen by the platform; shared because the renderer and the main
 * process both need to detect overrides that refer to the same variable.
 */
export const envNameRules = ['exact', 'case-insensitive'] as const
export type EnvNameRule = (typeof envNameRules)[number]

/**
 * Comparison key for an environment variable name: names with equal keys are the same variable.
 * `toUpperCase()` approximates Windows' per-character uppercase comparison; full Unicode case
 * mapping can differ for a few non-ASCII letters (e.g. `ß` becomes `SS`).
 */
export function envNameKey(name: string, rule: EnvNameRule): string {
  return rule === 'case-insensitive' ? name.toUpperCase() : name
}

/**
 * The first name in `names` that refers to the same variable as an earlier one under `rule`, or
 * `null` when every name is distinct.
 */
export function duplicateEnvName(names: readonly string[], rule: EnvNameRule): string | null {
  const seen = new Set<string>()
  for (const name of names) {
    const key = envNameKey(name, rule)
    if (seen.has(key)) return name
    seen.add(key)
  }
  return null
}
