import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONTENT_SECURITY_POLICY } from '../../src/main/app/csp'
import { createAppProtocolHandler, resolveAssetPath } from '../../src/main/app/protocol'

// Resolved, so the expected paths have this platform's form (on Windows: a drive and `\` separators).
const root = resolve('/srv/veydr/renderer')
const inRoot = (...segments: string[]): string => join(root, ...segments)

describe('resolveAssetPath', () => {
  it('maps bundled URLs into the renderer root', () => {
    expect(resolveAssetPath(root, 'app://veydr/')).toBe(inRoot('index.html'))
    expect(resolveAssetPath(root, 'app://veydr/index.html')).toBe(inRoot('index.html'))
    expect(resolveAssetPath(root, 'app://veydr/assets/index-abc.js?x=1#y')).toBe(inRoot('assets', 'index-abc.js'))
    // URL parsing clamps dot segments at the root, so they cannot escape it.
    expect(resolveAssetPath(root, 'app://veydr/../../secret.html')).toBe(inRoot('secret.html'))
    expect(resolveAssetPath(root, 'app://veydr/%2e%2e/%2e%2e/etc/passwd.html')).toBe(inRoot('etc', 'passwd.html'))
  })

  it('rejects foreign hosts, schemes, traversal, and unknown types', () => {
    for (const url of [
      'app://other/index.html',
      'https://veydr/index.html',
      'app://veydr/assets/%2e%2e%2f%2e%2e%2fsecret.js',
      'app://veydr/%00.html',
      'app://veydr/%E0%A4%A.html',
      'app://veydr/config.yaml',
      'app://veydr/assets',
      'not a url',
    ]) {
      expect(resolveAssetPath(root, url), url).toBeNull()
    }
  })
})

describe('app protocol handler', () => {
  const files = new Map([[inRoot('index.html'), new TextEncoder().encode('<!doctype html>')]])
  const handler = createAppProtocolHandler(root, (path) => {
    const data = files.get(path)
    return data === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(data)
  })

  it('serves bundled files with the D2 CSP header', async () => {
    const response = await handler({ url: 'app://veydr/index.html', method: 'GET' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY)
    expect(await response.text()).toBe('<!doctype html>')
  })

  it('answers missing, foreign, and non-GET requests without file access, still with CSP', async () => {
    for (const request of [
      { url: 'app://veydr/missing.html' },
      { url: 'app://other/index.html' },
      { url: 'app://veydr/index.html', method: 'POST' },
    ]) {
      const response = await handler(request)
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(response.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY)
    }
  })

  it('uses the exact D2 policy', () => {
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    )
  })
})
