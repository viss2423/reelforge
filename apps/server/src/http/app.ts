/**
 * Fastify application factory. `buildApp(deps)` wires plugins, the auth hook and all routes
 * without listening, so tests drive it with `app.inject()` / `app.injectWS()` and `index.ts`
 * passes TLS material to serve it over HTTPS.
 */
import { constants as zlib } from 'node:zlib'
import compress from '@fastify/compress'
import websocket from '@fastify/websocket'
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { tokenFromRequest } from '../auth/index.ts'
import type { AppDeps } from './deps.ts'
import { errorHandler } from './errors.ts'
import { authRoutes } from './routes/auth.ts'
import { eventRoutes } from './routes/events.ts'
import { jobRoutes } from './routes/jobs.ts'
import { mediaRoutes } from './routes/media.ts'
import { musicRoutes } from './routes/music.ts'
import { packRoutes } from './routes/packs.ts'
import { projectRoutes } from './routes/projects.ts'
import { systemRoutes } from './routes/system.ts'
import { trendRoutes } from './routes/trends.ts'
import { webRoutes } from './routes/web.ts'
import { securityHeaders } from './security.ts'

export type { AppDeps } from './deps.ts'

const EVENTS_ROUTE = '/api/events'

const queryToken = (query: unknown): string | undefined =>
  typeof query === 'object' && query !== null && 'token' in query && typeof query.token === 'string'
    ? query.token
    : undefined

/** Compress text-like responses only; media is already compressed and served with ranges. */
const COMPRESSIBLE =
  /^(?:text\/|application\/(?:json|javascript|manifest\+json|xml)|image\/svg\+xml)/

export const buildApp = async (deps: AppDeps): Promise<FastifyInstance> => {
  const options: FastifyServerOptions & { https?: import('node:tls').SecureContextOptions } = {
    loggerInstance: deps.log,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1024 * 1024,
    // Phones on flaky Wi-Fi: keep idle connections a while so chunk uploads reuse them.
    keepAliveTimeout: 65_000,
    requestTimeout: 0,
    return503OnClosing: true,
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: 512 },
    ...(deps.https ? { https: { ...deps.https, minVersion: 'TLSv1.2' } } : {}),
  }
  const app = Fastify(options) as unknown as FastifyInstance
  app.decorateRequest('device', null)
  app.setErrorHandler(errorHandler)

  const headers = Object.entries(securityHeaders(Boolean(deps.https)))
  app.addHook('onRequest', async (req, reply) => {
    for (const [k, v] of headers) reply.header(k, v)
    // Decide on the matched route pattern, not the raw URL: the router decodes and
    // normalises paths, so `/%61pi/projects` reaches `/api/projects` too.
    const route = req.routeOptions.url
    if (route === undefined || !route.startsWith('/api/') || req.routeOptions.config.public) return
    // Browsers cannot set headers on a WebSocket, so the event socket also takes ?token=.
    // Only there: tokens in other URLs would end up in history and proxy logs.
    const device = deps.auth.authenticate(
      tokenFromRequest(req.headers) ?? (route === EVENTS_ROUTE ? queryToken(req.query) : undefined),
    )
    if (!device)
      return reply
        .code(401)
        .header('cache-control', 'no-store')
        .send({ error: { code: 'unauthorized', message: 'pair this device first' } })
    req.device = device
  })

  await app.register(compress, {
    global: true,
    threshold: 1024,
    encodings: ['br', 'gzip'],
    customTypes: COMPRESSIBLE,
    globalDecompression: false,
    // Brotli's default (11) costs ~100x more CPU than level 5 for a few % smaller JSON.
    brotliOptions: { params: { [zlib.BROTLI_PARAM_QUALITY]: 5 } },
  })
  await app.register(websocket, {
    options: { maxPayload: 64 * 1024 },
    // 1001 "going away" (instead of the plugin's code-less close) tells the PWA the server is
    // restarting, so it reconnects with backoff rather than treating it as an error. Not
    // waiting for close handshakes keeps shutdown fast when phones are unreachable.
    preClose(done) {
      for (const client of this.websocketServer.clients) client.close(1001, 'server shutting down')
      this.websocketServer.close()
      done()
    },
  })

  authRoutes(app, deps)
  systemRoutes(app, deps)
  projectRoutes(app, deps)
  mediaRoutes(app, deps)
  jobRoutes(app, deps)
  packRoutes(app, deps)
  musicRoutes(app, deps)
  trendRoutes(app, deps)
  // WebSocket routes must be registered after @fastify/websocket is ready.
  await app.register(async (scope) => eventRoutes(scope, deps))
  webRoutes(app, deps)
  return app
}
