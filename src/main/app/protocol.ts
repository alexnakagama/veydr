import { readFile as fsReadFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CONTENT_SECURITY_POLICY } from './csp'

export const APP_SCHEME = 'app'
export const APP_HOST = 'veydr'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/**
 * Maps an `app://veydr/...` URL to a file inside `root`, or `null` for a
 * foreign host, a path escaping `root`, or an unknown file type.
 */
export function resolveAssetPath(root: string, url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST) return null

  let pathname: string
  try {
    pathname = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
  if (pathname.includes('\0')) return null
  if (pathname === '/' || pathname === '') pathname = '/index.html'

  const base = resolve(root)
  const file = resolve(join(base, pathname))
  const rel = relative(base, file)
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return null
  if (!(extname(file) in MIME_TYPES)) return null
  return file
}

export type ReadFile = (path: string) => Promise<Uint8Array>

/** `protocol.handle` callback serving bundled content with the D2 CSP header. */
export function createAppProtocolHandler(
  root: string,
  readFile: ReadFile = fsReadFile,
): (request: { url: string; method?: string }) => Promise<Response> {
  const headersFor = (contentType: string): Headers =>
    new Headers({
      'Content-Type': contentType,
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    })

  return async (request) => {
    const notFound = (): Response => new Response('Not found', { status: 404, headers: headersFor('text/plain') })
    if (request.method !== undefined && request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: headersFor('text/plain') })
    }
    const file = resolveAssetPath(root, request.url)
    if (file === null) return notFound()
    let body: Uint8Array
    try {
      body = await readFile(file)
    } catch {
      return notFound()
    }
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: headersFor(MIME_TYPES[extname(file)] ?? 'application/octet-stream'),
    })
  }
}
