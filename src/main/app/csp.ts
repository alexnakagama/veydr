/** Content security policy for bundled content (design D2). */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

/** Relaxed policy for the Vite dev server only; never used by built or packaged apps. */
export function devContentSecurityPolicy(devOrigin: string): string {
  const ws = devOrigin.replace(/^http/, 'ws')
  return [
    "default-src 'none'",
    `script-src 'self' ${devOrigin}`,
    `style-src 'self' 'unsafe-inline' ${devOrigin}`,
    `img-src 'self' data: ${devOrigin}`,
    `font-src 'self' ${devOrigin}`,
    `connect-src ${devOrigin} ${ws}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}
