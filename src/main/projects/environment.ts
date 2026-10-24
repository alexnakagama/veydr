import type { EnvironmentEntry } from '../../shared/api'
import type { CommandConfig, EnvEntry } from '../../shared/config'
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

/** `base` with the command's overrides applied last (spec: override applied). */
export function effectiveEnvironment(base: Env, overrides: readonly EnvEntry[]): Record<string, string> {
  const env: Record<string, string> = { ...base }
  for (const entry of overrides) env[entry.key] = entry.value
  return env
}

/**
 * The effective environment of `command` as the user may see it, sorted by name: secret
 * overrides are masked (`null`), and each entry says whether it comes from an override.
 */
export function previewEntries(base: Env, command: Pick<CommandConfig, 'env'>): EnvironmentEntry[] {
  const overrides = new Map(command.env.map((entry) => [entry.key, entry]))
  const keys = [...new Set([...Object.keys(base), ...overrides.keys()])].sort()
  return keys.map((key): EnvironmentEntry => {
    const override = overrides.get(key)
    if (override === undefined) return { key, secret: false, value: base[key] ?? '', source: 'base' }
    return override.secret ? { key, secret: true, value: null, source: 'override' } : { key, secret: false, value: override.value, source: 'override' }
  })
}
