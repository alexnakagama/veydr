import { isAbsolute, normalize } from 'node:path'

/**
 * Variables of Veydr's own runtime that must not reach a command (design D6 denylist): Electron's
 * (`ELECTRON_*`, and `NO_AT_BRIDGE`, which Electron sets at startup on Linux), the desktop launcher's
 * (`CHROME_DESKTOP`), and an AppImage runtime's (`APPDIR`, `APPIMAGE`, `ARGV0`, `OWD`).
 */
const RUNTIME_VARIABLES = new Set(['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'CHROME_DESKTOP', 'NO_AT_BRIDGE'])

/**
 * What electron-builder's AppImage launcher (`AppRun`) appends to `XDG_DATA_DIRS`, after the
 * previous value if there was one (task 9.3, checked against the packaged AppImage).
 */
const APPRUN_DATA_DIRS_SUFFIX = ['/usr/share/gnome', '/usr/local/share/', '/usr/share/']

export function isRuntimeVariable(key: string): boolean {
  return key.startsWith('ELECTRON_') || RUNTIME_VARIABLES.has(key)
}

/**
 * `env` without Veydr's runtime variables and without unset entries. Inside an AppImage (`APPDIR`
 * set), the launcher has also put its own directories in front of existing variables (`PATH`,
 * `LD_LIBRARY_PATH`, `XDG_DATA_DIRS`, `GSETTINGS_SCHEMA_DIR`); every `:`-separated entry inside
 * `APPDIR` is removed from every variable, a variable left empty is removed, and the defaults the
 * launcher appends to `XDG_DATA_DIRS` are removed as well.
 */
export function withoutRuntimeVariables(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const appDir = appImageDir(env['APPDIR'])
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || isRuntimeVariable(key)) continue
    const cleaned = appDir === null ? value : withoutAppImageEntries(key, value, appDir)
    if (cleaned !== null) out[key] = cleaned
  }
  return out
}

/** `APPDIR` normalized without a trailing slash, or `null` if it is unset or unusable (relative, `/`). */
function appImageDir(value: string | undefined): string | null {
  if (value === undefined || !isAbsolute(value)) return null
  const dir = normalize(value).replace(/\/+$/, '')
  return dir === '' ? null : dir
}

/** `value` without its entries inside `appDir`; `null` if nothing is left. Unchanged if it has none. */
function withoutAppImageEntries(key: string, value: string, appDir: string): string | null {
  const entries = value.split(':')
  const inside = (entry: string): boolean => {
    if (!isAbsolute(entry)) return false
    const path = normalize(entry)
    return path === appDir || path.startsWith(`${appDir}/`)
  }
  if (!entries.some(inside)) return value
  let kept = entries.filter((entry) => !inside(entry))
  if (key === 'XDG_DATA_DIRS' && endsWith(kept, APPRUN_DATA_DIRS_SUFFIX)) kept = kept.slice(0, -APPRUN_DATA_DIRS_SUFFIX.length)
  return kept.length === 0 ? null : kept.join(':')
}

function endsWith(list: readonly string[], suffix: readonly string[]): boolean {
  return list.length >= suffix.length && suffix.every((entry, i) => list[list.length - suffix.length + i] === entry)
}
