/** Chunked uploads, the asset library and asset file streaming. */
import { rm } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import type { Asset } from '@reelforge/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { assetDir, assetFile, type AssetVariant } from '../../paths.ts'
import { type AppDeps, deviceOf, parse } from '../deps.ts'
import { HttpError, notFound } from '../errors.ts'
import { sendFile } from '../send.ts'

const IdParams = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) })
const ChunkParams = IdParams.extend({ index: z.coerce.number().int().nonnegative() })
const CreateUpload = z.object({
  name: z.string().min(1).max(1000),
  size: z.number().int().positive(),
  mime: z.string().max(200).default(''),
})

const FILES: Record<string, { variant: AssetVariant; type?: string }> = {
  'thumbs.jpg': { variant: 'thumbs', type: 'image/jpeg' },
  'thumbs.json': { variant: 'thumbsIndex', type: 'application/json; charset=utf-8' },
  'poster.jpg': { variant: 'poster', type: 'image/jpeg' },
  'waveform.json': { variant: 'waveform', type: 'application/json; charset=utf-8' },
}

export const mediaRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  const { store, uploads, queue, bus, paths } = deps

  const getAsset = (id: string): Asset => {
    const asset = store.getAsset(id)
    if (!asset) throw notFound('asset')
    return asset
  }

  /* ------------------------------------------------------------ uploads */

  app.post('/api/uploads', async (req, reply) => {
    const body = parse(CreateUpload, req.body)
    const status = await uploads.create(body, deviceOf(req).id)
    return reply.code(201).send(status)
  })

  app.get('/api/uploads/:id', async (req) => uploads.status(parse(IdParams, req.params).id))

  // Chunk bodies are streamed straight to disk: register a pass-through parser for any
  // content type in this encapsulated scope so Fastify never buffers 8 MiB per request.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('*', (_req, payload, done) => done(null, payload))
    scope.put('/api/uploads/:id/chunks/:index', async (req: FastifyRequest) => {
      const { id, index } = parse(ChunkParams, req.params)
      const header = req.headers['content-length']
      const length = header === undefined ? undefined : Number(header)
      const body = (req.body ?? req.raw) as Readable
      const result = await uploads.writeChunk(id, index, body, length)
      return { received: result.received, chunks: result.chunks }
    })
  })

  app.post('/api/uploads/:id/complete', async (req, reply) => {
    const asset = await uploads.complete(parse(IdParams, req.params).id)
    bus.emit({ type: 'asset', asset })
    queue.enqueue('probe', { assetId: asset.id }, { assetId: asset.id })
    return reply.code(201).send(asset)
  })

  app.delete('/api/uploads/:id', async (req, reply) => {
    await uploads.abort(parse(IdParams, req.params).id)
    return reply.code(204).send()
  })

  /* ------------------------------------------------------------ assets */

  app.get('/api/assets', async () => store.listAssets())

  app.get('/api/assets/:id', async (req) => getAsset(parse(IdParams, req.params).id))

  app.delete('/api/assets/:id', async (req, reply) => {
    const asset = getAsset(parse(IdParams, req.params).id)
    queue.cancelWhere((job) => job.assetId === asset.id)
    store.deleteAsset(asset.id)
    // Cancelled FFmpeg processes may hold files open for a moment (Windows): retry briefly.
    await rm(assetDir(paths, asset.id), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
    return reply.code(204).send()
  })

  const stream =
    (variant: 'original' | 'proxy') => async (req: FastifyRequest, reply: FastifyReply) => {
      const asset = getAsset(parse(IdParams, req.params).id)
      if (variant === 'proxy' && asset.proxy !== 'ready')
        throw new HttpError(404, 'not_ready', `proxy is ${asset.proxy}`)
      return sendFile(req, reply, assetFile(paths, asset, variant), {
        cache: 'immutable',
        type: variant === 'proxy' ? 'video/mp4' : asset.mime || 'application/octet-stream',
      })
    }
  app.get('/api/assets/:id/original', stream('original'))
  app.get('/api/assets/:id/proxy', stream('proxy'))

  app.get('/api/assets/:id/:file', async (req, reply) => {
    const params = parse(IdParams.extend({ file: z.string() }), req.params)
    const spec = FILES[params.file]
    if (!spec) throw notFound('file')
    const asset = getAsset(params.id)
    return sendFile(req, reply, assetFile(paths, asset, spec.variant), {
      cache: 'immutable',
      ...(spec.type ? { type: spec.type } : {}),
    })
  })
}
