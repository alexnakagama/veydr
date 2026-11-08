import { envNameKey } from '../../../shared/config'
import { isRuntimeVariable } from '../runtime-env'
import type { EnvProvider, PlatformLog } from '../types'

export interface WindowsEnvProviderOptions {
  /** Veydr's own environment (`process.env`), read anew on every call. */
  readonly inherited: Readonly<Record<string, string | undefined>>
  readonly log?: PlatformLog
}

/**
 * Whether `name` can be passed on in a Windows environment block. An empty name, a name holding `=`
 * (the block stores `name=value`, so the name would be cut at it; this covers the per-drive `=C:`
 * entries), and a name holding NUL (which ends a block entry) cannot.
 */
const isPassableName = (name: string): boolean => name !== '' && !name.includes('=') && !name.includes('\0')

/**
 * Veydr's inherited environment, as commands get it on Windows (design D3). It is what
 * `withoutRuntimeVariables` returns, and stricter:
 * - Veydr's runtime variables are removed, their names compared regardless of case, since Windows
 *   (and so Electron in a command) reads `electron_run_as_node` as `ELECTRON_RUN_AS_NODE`;
 * - names that cannot be passed on are dropped, and so are values holding NUL;
 * - names that differ only in case are merged into one entry: the first in enumeration order, its
 *   spelling and value, which is the entry a case-insensitive lookup finds (`GetEnvironmentVariableW`
 *   scans the environment block in that order, and `process.env` enumerates it in that order).
 *
 * Each merge is logged as `environment.names-merged`, with the names only, never a value.
 *
 * Names are compared with JavaScript's `toUpperCase()` (`envNameKey`), which differs from Windows'
 * own upper-case table for a few non-ASCII letters (`ſ`, `ı`): two such names could be merged here
 * that Windows keeps apart. No real variable name is known to depend on it.
 */
export function windowsBaseEnvironment(inherited: Readonly<Record<string, string | undefined>>, log?: PlatformLog): Record<string, string> {
  // Without a prototype, so that a variable named `__proto__` is kept like any other.
  const candidates: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined || isRuntimeVariable(name.toUpperCase()) || !isPassableName(name) || value.includes('\0')) continue
    candidates[name] = value
  }
  // `withoutRuntimeVariables` is not called: its denylist is applied above, regardless of case, and
  // its AppImage cleanup, which splits values on ":", has no place on Windows (`C:\…`).

  const byKey = new Map<string, { readonly name: string; readonly value: string; readonly merged: string[] }>()
  for (const [name, value] of Object.entries(candidates)) {
    const key = envNameKey(name, 'case-insensitive')
    const kept = byKey.get(key)
    if (kept === undefined) byKey.set(key, { name, value, merged: [] })
    else kept.merged.push(name)
  }

  // No prototype either: callers read it with `Object.entries` or spread it (the environment service
  // copies it with `{ ...env }`, which keeps `__proto__` as an own entry); never call its methods.
  const env: Record<string, string> = Object.create(null) as Record<string, string>
  for (const { name, value, merged } of byKey.values()) {
    env[name] = value
    if (merged.length > 0) log?.record('info', 'environment.names-merged', { kept: name, merged })
  }
  return env
}

/**
 * The Windows environment provider (design D3): Veydr's inherited environment, cleaned by
 * `windowsBaseEnvironment`. Nothing is resolved that could fail, so it never warns; a refresh
 * reads the same inherited environment again.
 */
export function createWindowsEnvProvider(options: WindowsEnvProviderOptions): EnvProvider {
  return {
    // Run inside the promise, so that anything thrown while reading the environment is a rejection,
    // as for the other providers.
    base: () => Promise.resolve().then(() => ({ env: windowsBaseEnvironment(options.inherited, options.log), warnings: [] })),
  }
}
