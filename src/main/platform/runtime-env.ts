/**
 * Variables of Veydr's own runtime that must not reach a command (design D6 denylist): Electron's
 * (`ELECTRON_*`, and `NO_AT_BRIDGE`, which Electron sets at startup on Linux), the desktop launcher's
 * (`CHROME_DESKTOP`), and an AppImage runtime's (`APPDIR`, `APPIMAGE`, `ARGV0`, `OWD`).
 */
const RUNTIME_VARIABLES = new Set(['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'CHROME_DESKTOP', 'NO_AT_BRIDGE'])

export function isRuntimeVariable(key: string): boolean {
  return key.startsWith('ELECTRON_') || RUNTIME_VARIABLES.has(key)
}

/** `env` without Veydr's runtime variables and without unset entries. */
export function withoutRuntimeVariables(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !isRuntimeVariable(key)) out[key] = value
  }
  return out
}
