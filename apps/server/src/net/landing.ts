/**
 * Plain-HTTP server (port 8080): the first thing a phone opens. It serves only
 *   - a mobile-friendly pairing landing page (install the local CA, then open the app),
 *   - the CA certificate at /ca.crt,
 * and permanently redirects (308) everything else to HTTPS.
 */
import { isIP } from 'node:net'
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify'
import QRCode from 'qrcode'
import type { AppLogger } from '../logger.ts'
import { securityHeaders } from '../http/security.ts'

export interface LandingDeps {
  httpsPort: number
  /** DER-encoded CA certificate (read on each request: it may be re-created). */
  caDer: () => Buffer
  /** Host to use when the request's Host header is unusable. */
  fallbackHost: () => string
  log: AppLogger
}

const HOST_RE =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** The host part of the request (validated), used to build the HTTPS URL. */
export const requestHost = (req: FastifyRequest, fallback: string): string => {
  const raw = req.headers.host ?? ''
  const host = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0]!
  if (isIP(host) === 4 || HOST_RE.test(host)) return host.toLowerCase()
  if (isIP(host) === 6) return `[${host}]`
  return fallback
}

const httpsBase = (host: string, port: number): string =>
  `https://${host}${port === 443 ? '' : `:${port}`}`

/** Server-rendered landing page. Pure (tested). */
export const landingPage = (opts: { appUrl: string; qrSvg: string }): string => {
  const url = escapeHtml(opts.appUrl)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>Connect to ReelForge</title>
<style>
:root{--bg:#0b0b0f;--card:#16161d;--fg:#f4f4f5;--muted:#a1a1aa;--accent:#ff3d71;--line:#27272a}
@media (prefers-color-scheme:light){:root{--bg:#f4f4f5;--card:#fff;--fg:#18181b;--muted:#52525b;--line:#e4e4e7}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:max(16px,env(safe-area-inset-top)) 16px 32px}
main{max-width:34rem;margin:0 auto}h1{font-size:1.6rem;margin:.5rem 0 1rem}h2{font-size:1.05rem;margin:0 0 .5rem}
section{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin:12px 0}
.btn{display:block;text-align:center;background:var(--accent);color:#fff;text-decoration:none;font-weight:700;padding:14px;border-radius:12px;margin:12px 0 4px}
.btn.alt{background:transparent;color:var(--fg);border:1px solid var(--line)}
ol{padding-left:1.2rem;margin:.25rem 0}li{margin:.2rem 0}small,.muted{color:var(--muted)}
details{margin-top:.5rem}summary{cursor:pointer;font-weight:600}
.qr{display:flex;justify-content:center;background:#fff;border-radius:12px;padding:12px;max-width:240px;margin:8px auto}
.qr svg{width:100%;height:auto}code{word-break:break-all}
</style>
</head>
<body>
<main>
<h1>Connect to ReelForge</h1>
<section>
<h2>1 · Trust this computer (once per device)</h2>
<p class="muted">ReelForge uses a private certificate made on this computer, so the app can be installed and work offline.</p>
<a class="btn alt" href="/ca.crt" download="reelforge-ca.crt">Download certificate</a>
<details><summary>iPhone / iPad</summary><ol>
<li>Open this page in <b>Safari</b> and tap <b>Download certificate</b> → <b>Allow</b>.</li>
<li>Settings → <b>Profile Downloaded</b> → <b>Install</b>.</li>
<li>Settings → General → About → <b>Certificate Trust Settings</b> → turn on <b>ReelForge Local CA</b>.</li>
</ol></details>
<details><summary>Android</summary><ol>
<li>Tap <b>Download certificate</b>.</li>
<li>Settings → Security &amp; privacy → More security settings → Encryption &amp; credentials → <b>Install a certificate</b> → <b>CA certificate</b> → Install anyway.</li>
<li>Pick <b>reelforge-ca.crt</b> from Downloads.</li>
</ol></details>
<details><summary>Windows / macOS</summary><ol>
<li>Windows: open the file → Install Certificate → Local Machine → <b>Trusted Root Certification Authorities</b>.</li>
<li>macOS: open the file → Keychain Access → double-click it → Trust → <b>Always Trust</b>.</li>
</ol></details>
</section>
<section>
<h2>2 · Open the app</h2>
<a class="btn" href="${url}">Open ReelForge</a>
<p><small>Then use “Add to Home Screen” to install it. Address: <code>${url}</code></small></p>
<div class="qr" role="img" aria-label="QR code for ${url}">${opts.qrSvg}</div>
</section>
</main>
</body>
</html>`
}

/** Builds the plain-HTTP landing/redirect app. */
export const buildLandingApp = (deps: LandingDeps): FastifyInstance => {
  const app = Fastify({
    loggerInstance: deps.log,
    logController: new LogController({ disableRequestLogging: true }),
  }) as unknown as FastifyInstance
  const headers = Object.entries(securityHeaders(false))

  app.addHook('onRequest', async (_req, reply) => {
    for (const [k, v] of headers) reply.header(k, v)
  })

  const page = async (req: FastifyRequest): Promise<string> => {
    const host = requestHost(req, deps.fallbackHost())
    const code = (req.query as { code?: string }).code
    const appUrl = `${httpsBase(host, deps.httpsPort)}/${code && /^\d{6}$/.test(code) ? `pair?code=${code}` : ''}`
    const qrSvg = await QRCode.toString(appUrl, {
      type: 'svg',
      margin: 0,
      errorCorrectionLevel: 'M',
    })
    return landingPage({ appUrl, qrSvg })
  }
  for (const route of ['/', '/pair', '/setup'])
    app.get(route, async (req, reply) =>
      reply
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(await page(req)),
    )

  app.get('/ca.crt', async (_req, reply) =>
    reply
      .type('application/x-x509-ca-cert')
      .header('content-disposition', 'attachment; filename="reelforge-ca.crt"')
      .header('cache-control', 'no-cache')
      .send(deps.caDer()),
  )

  app.setNotFoundHandler(async (req, reply) => {
    const host = requestHost(req, deps.fallbackHost())
    return reply.redirect(`${httpsBase(host, deps.httpsPort)}${req.url}`, 308)
  })
  return app
}
