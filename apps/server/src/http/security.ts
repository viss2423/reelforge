/**
 * Security headers for every response.
 *
 * CSP notes: JASSUB (libass compiled to WebAssembly) needs `'wasm-unsafe-eval'` and runs in
 * a worker that may be created from a blob: URL; the preview decodes media into blob: URLs;
 * Tailwind/React inject style attributes, hence `'unsafe-inline'` for styles only.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data: blob:",
  "connect-src 'self' blob: data:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

/** Headers applied to every response (HSTS only over HTTPS). */
export const securityHeaders = (https: boolean): Record<string, string> => ({
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'geolocation=(), payment=(), usb=()',
  ...(https ? { 'strict-transport-security': 'max-age=31536000' } : {}),
})
