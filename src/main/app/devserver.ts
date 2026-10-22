const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Validates the Vite dev-server URL handed over by `electron-vite dev`.
 * Only plain-http loopback URLs are accepted, so a stray environment variable
 * can never make a remote origin the trusted IPC origin. Returns `undefined`
 * for anything else.
 */
export function resolveDevServerUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname)) return undefined
  if (parsed.username !== '' || parsed.password !== '') return undefined
  return parsed.href
}
