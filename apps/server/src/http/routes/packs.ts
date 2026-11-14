/** Trend packs: manifests, pack files (LUTs, stickers, thumbs, fonts) and manual sync. */
import type { FastifyInstance } from 'fastify'
import { PackSyncError } from '../../packs/service.ts'
import type { AppDeps } from '../deps.ts'
import { HttpError, notFound } from '../errors.ts'
import { sendFile } from '../send.ts'

export const packRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  const { packs } = deps

  app.get('/api/packs', async (req, reply) => {
    const snap = packs.snapshot
    const etag = `"packs-${snap.source}-${snap.index?.version ?? 'none'}"`
    void reply.header('etag', etag).header('cache-control', 'no-cache')
    if (req.headers['if-none-match'] === etag) return reply.code(304).send()
    return {
      version: snap.index?.version ?? null,
      source: snap.source,
      index: snap.index ?? null,
      manifests: snap.manifests,
    }
  })

  app.get('/api/packs/files/*', async (req, reply) => {
    const rel = (req.params as { '*': string })['*']
    const file = packs.resolveFile(rel)
    if (!file) throw notFound('pack file')
    // Pack file paths are content-stable within a pack version; clients add ?v=<packs version>.
    return sendFile(req, reply, file, { cache: 'immutable' })
  })

  app.post('/api/packs/sync', async () => {
    try {
      return await packs.sync()
    } catch (err) {
      if (
        err instanceof PackSyncError ||
        err instanceof TypeError ||
        (err as Error).name === 'TimeoutError'
      )
        throw new HttpError(502, 'sync_failed', (err as Error).message)
      throw err
    }
  })
}
