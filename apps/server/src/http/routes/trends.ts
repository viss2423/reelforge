/**
 * Trend engine: Trending Now data, on-demand refresh, reel ideas, settings, and trending
 * sounds: a beat grid for "Match cuts" (always: the chart BPM) and — only when the host
 * opts in with TRENDS_SOUND_PREVIEW=1 — Deezer's official 30 s preview, streamed through
 * for playback only (never stored, never an asset, never exported) and analysed for beats.
 */
import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { analyzeSoundBeats } from '../../trends/sound-beats.ts'
import { type AppDeps, parse } from '../deps.ts'
import { HttpError } from '../errors.ts'

const IdeaBody = z.object({ topic: z.string().trim().min(2).max(80) })
const SettingsBody = z.object({ autoPublish: z.boolean() })
const SoundQuery = z.object({
  title: z.string().trim().min(1).max(300),
  artist: z.string().trim().max(300).optional(),
})
const SoundBeatsBody = SoundQuery.extend({ bpm: z.number().min(30).max(300).optional() })

const clientGone = (reply: FastifyReply): AbortSignal => {
  const ac = new AbortController()
  reply.raw.once('close', () => {
    if (!reply.raw.writableEnded) ac.abort()
  })
  return ac.signal
}

export const trendRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  const trends = (): NonNullable<AppDeps['trends']> => {
    if (!deps.trends) throw new HttpError(503, 'unavailable', 'trend engine is not running')
    return deps.trends
  }

  app.get('/api/trends', async (_req, reply) => {
    void reply.header('cache-control', 'no-cache')
    return trends().summary()
  })

  /** Starts (or joins) a refresh job; progress arrives as `job` events. */
  app.post('/api/trends/refresh', async (_req, reply) => {
    const id = trends().enqueue()
    if (!id) throw new HttpError(503, 'unavailable', 'job queue is not running')
    return reply.code(202).send({ jobId: id })
  })

  app.post('/api/trends/ideas', async (req) => {
    const { topic } = parse(IdeaBody, req.body)
    return trends().ideaFor(topic, AbortSignal.timeout(120_000))
  })

  app.put('/api/trends/settings', async (req) =>
    trends().setSettings(parse(SettingsBody, req.body)),
  )

  /** Whether a trending sound has an official preview clip (and from where). */
  app.get('/api/trends/sounds/preview-info', async (req) => {
    const q = parse(SoundQuery, req.query)
    if (!trends().soundPreview) return { available: false, disabled: true }
    const p = await trends().previews.resolve(q, AbortSignal.timeout(15_000))
    return p
      ? {
          available: true,
          source: p.source,
          duration: p.duration,
          ...(p.link ? { link: p.link } : {}),
        }
      : { available: false }
  })

  /** The official 30 s preview, piped from the provider's CDN (no disk, no cache). */
  app.get('/api/trends/sounds/preview', async (req, reply) => {
    const q = parse(SoundQuery, req.query)
    if (!trends().soundPreview)
      throw new HttpError(403, 'disabled', 'trending sound previews are off on this host')
    const signal = clientGone(reply)
    const p = await trends().previews.resolve(q, signal)
    if (!p) throw new HttpError(404, 'no_preview', 'this sound has no official preview')
    let res: Response
    try {
      res = await trends().previews.open(p, signal)
    } catch (err) {
      throw new HttpError(502, 'preview_failed', err instanceof Error ? err.message : String(err))
    }
    void reply
      .header('content-type', res.headers.get('content-type') ?? 'audio/mpeg')
      .header('cache-control', 'no-store')
      .header('x-preview-source', p.source)
    const len = res.headers.get('content-length')
    if (len) void reply.header('content-length', len)
    return reply.send(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream))
  })

  /** Beat grid of the preview clip (analysed from the stream), else a BPM grid. */
  app.post('/api/trends/sounds/beats', async (req, reply) => {
    const b = parse(SoundBeatsBody, req.body)
    const signal = clientGone(reply)
    const p = trends().soundPreview ? await trends().previews.resolve(b, signal) : undefined
    return analyzeSoundBeats({
      paths: deps.paths,
      ffmpeg: deps.tools.ffmpeg,
      url: p?.url,
      ...(b.bpm ? { bpm: b.bpm } : {}),
      signal,
    })
  })
}
