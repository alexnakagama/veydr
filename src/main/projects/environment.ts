import type { EnvironmentEntry } from '../../shared/api'
import { envNameKey, type CommandConfig, type EnvEntry, type EnvNameRule } from '../../shared/config'
import type { Env, EnvProvider } from '../platform/types'

export interface BaseEnvironment {
  readonly env: Env
  /** Why the environment is a fallback, if it is one. */
  readonly warnings: readonly string[]
}

/**
 * The environment commands start from, resolved once per session (design D6) and again on an
 * explicit refresh.
 */
export interface EnvironmentService {
  base(): Promise<BaseEnvironment>
  refresh(): Promise<BaseEnvironment>
}

export interface EnvironmentServiceDeps {
  readonly provider: EnvProvider
  /** Told the warnings of every resolution, also when there are none (e.g. to show or withdraw a notice). */
  readonly onWarnings?: (warnings: readonly string[]) => void
}

export function createEnvironmentService({ provider, onWarnings }: EnvironmentServiceDeps): EnvironmentService {
  let current: Promise<BaseEnvironment> | null = null
  const resolveBase = (): Promise<BaseEnvironment> => {
    const resolving = provider.base().then((result) => {
      onWarnings?.(result.warnings)
      return { env: Object.freeze({ ...result.env }), warnings: [...result.warnings] }
    })
    current = resolving
    // A failure (e.g. an unsupported platform) is not kept: the next call tries again.
    resolving.catch(() => {
      if (current === resolving) current = null
    })
    return resolving
  }
  return {
    base: () => current ?? resolveBase(),
    refresh: resolveBase,
  }
}

/**
 * The overrides by name key under `rule`; of overrides naming the same variable, the last wins.
 * Saving rejects such overrides (`ProjectService.upsertCommand`), so normally each key has one.
 */
function overridesByKey(overrides: readonly EnvEntry[], rule: EnvNameRule): Map<string, EnvEntry> {
  return new Map(overrides.map((entry) => [envNameKey(entry.key, rule), entry]))
}

/**
 * `base` with the command's overrides applied last (spec: override applied). Names are compared
 * under `rule`: an override replaces every base entry naming the same variable, and the
 * override's spelling is kept (spec: override differing in case on Windows).
 */
export function effectiveEnvironment(base: Env, overrides: readonly EnvEntry[], rule: EnvNameRule): Record<string, string> {
  const applied = overridesByKey(overrides, rule)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (!applied.has(envNameKey(key, rule))) env[key] = value
  for (const entry of applied.values()) env[entry.key] = entry.value
  return env
}

/**
 * The effective environment of `command` as the user may see it, sorted by name: secret
 * overrides are masked (`null`), and each entry says whether it comes from an override. Names are
 * merged under `rule` as in `effectiveEnvironment`.
 */
export function previewEntries(base: Env, command: Pick<CommandConfig, 'env'>, rule: EnvNameRule): EnvironmentEntry[] {
  const applied = overridesByKey(command.env, rule)
  const entries: EnvironmentEntry[] = []
  for (const [key, value] of Object.entries(base)) {
    if (!applied.has(envNameKey(key, rule))) entries.push({ key, secret: false, value, source: 'base' })
  }
  for (const { key, value, secret } of applied.values()) {
    entries.push(secret ? { key, secret: true, value: null, source: 'override' } : { key, secret: false, value, source: 'override' })
  }
  return entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}
