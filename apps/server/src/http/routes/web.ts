/**
 * Serves the built PWA (apps/web/dist) with SPA fallback.
 * Cache policy: Vite's hashed files under /assets/ are immutable; the HTML shell, service
 * worker, manifest and any other unhashed root file revalidate every time (cheap 304s), so a
 * new deploy is picked up on the next load and the service worker can update itself.
 */
import path from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { resolveInside } from '../../packs/files.ts'
import type { AppDeps } from '../deps.ts'
import { notFound } from '../errors.ts'
import { sendFile, type CachePolicy } from '../send.ts'

const PLACEHOLDER = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>ReelForge</title>
<body style="font-family:system-ui;background:#0b0b0f;color:#e5e7eb;display:grid;place-items:center;min-height:100vh;margin:0">
<main style="max-width:32rem;padding:1.5rem"><h1>ReelForge server is running</h1>
<p>The web app has not been built yet. Run <code>pnpm --filter @reelforge/web build</code> and reload.</p></main></body></html>`

/** Cache policy for a file of the web build. */
export const webCachePolicy = (rel: string): CachePolicy =>
  rel.startsWith('assets/') ? 'immutable' : 'revalidate'

const wantsHtml = (req: FastifyRequest): boolean => {
  const accept = req.headers.accept ?? ''
  return accept.includes('text/html') || accept === '' || accept === '*/*'
}

export const webRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  const dist = deps.webDist

  // Anything that is not a route (other methods, unknown /api paths) is a JSON 404.
  app.setNotFoundHandler(async () => {
    throw notFound('route')
  })

  // A real catch-all route (not the 404 handler) so compression, HEAD and hooks apply.
  app.get('/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url.split('?')[0] ?? '/'
    if (url.startsWith('/api/') || url === '/api') throw notFound('route')
    if (!dist) {
      if (!wantsHtml(req)) throw notFound('file')
      return reply
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-cache')
        .send(PLACEHOLDER)
    }
    let rel: string
    try {
      rel = decodeURIComponent(url).replace(/^\/+/, '')
    } catch {
      throw notFound('file')
    }
    if (rel !== '' && !rel.endsWith('/')) {
      const file = resolveInside(dist, rel)
      if (file) {
        try {
          return await sendFile(req, reply, file, { cache: webCachePolicy(rel) })
        } catch {
          // not a file of the build: fall through to the SPA shell / 404
        }
      }
    }
    // Client-side routes (/editor/abc) get the app shell; missing assets stay 404.
    if (path.extname(rel) !== '' || !wantsHtml(req)) throw notFound('file')
    return sendFile(req, reply, path.join(dist, 'index.html'), { cache: 'revalidate' })
  })
}
