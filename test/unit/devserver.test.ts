import { describe, expect, it } from 'vitest'
import { resolveDevServerUrl } from '../../src/main/app/devserver'

describe('resolveDevServerUrl', () => {
  it('accepts plain-http loopback URLs', () => {
    for (const url of ['http://localhost:5173/', 'http://127.0.0.1:5173/', 'http://[::1]:5173/']) {
      expect(resolveDevServerUrl(url)).toBe(url)
    }
  })

  it('rejects everything else', () => {
    for (const url of [
      undefined,
      '',
      'not a url',
      'https://localhost:5173/',
      'http://example.com/',
      'http://localhost.evil.com/',
      'http://127.0.0.1.evil.com/',
      'http://user:pw@localhost:5173/',
      'app://veydr/index.html',
      'file:///etc/passwd',
      'javascript:alert(1)',
    ]) {
      expect(resolveDevServerUrl(url), String(url)).toBeUndefined()
    }
  })
})
