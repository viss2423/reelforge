/**
 * Music library: sources, search/browse, suggestions (runs the `music.suggest` job and
 * waits for it), 10 s chorus previews streamed from the host, and import as an asset.
 */
import type { Job } from '@reelforge/core'
import { MusicSearchQuery, MusicSuggestRequest } from '@reelforge/core'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { musicServiceFor } from '../../music/index.ts'
import { type AppDeps, parse } from '../deps.ts'
import { HttpError, notFound } from '../errors.ts'
import { sendFile } from '../send.ts'

const TrackParams = z.object({ id: z.string().regex(/^[a-z0-9]{1,20}:[A-Za-z0-9._-]{1,120}$/) })
const ImportBody = z.object({
  trackId: z.string().min(3).max(160),
  /** Reel length (µs) the chorus section is chosen for. */
  length: z.number().int().min(1_000_000).max(600_000_000).optional(),
})
const SuggestBody = MusicSuggestRequest.extend({ projectId: z.string().max(64).optional() })

const SUGGEST_TIMEOUT_MS = 180_000

/** Fires when the client disconnects before the response was sent. */
const clientGone = (reply: FastifyReply): AbortSignal => {
  const ac = new AbortController()
  reply.raw.once('close', () => {
    if (!reply.raw.writableEnded) ac.abort()
  })
  return ac.signal
}

const isFinal = (j: Job) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled'

/** Resolves with the job once it finished (events, with the store as the source of truth). */
const waitForJob = (deps: AppDeps, id: string, signal: AbortSignal): Promise<Job> =>
  new Promise((resolve, reject) => {
    const finish = (fn: () => void) => {
      off()
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      fn()
    }
    const off = deps.bus.subscribe((e) => {
      if (e.type === 'job' && e.job.id === id && isFinal(e.job)) finish(() => resolve(e.job))
    })
    const timer = setTimeout(() => {
      deps.queue.cancel(id)
      finish(() => reject(new HttpError(504, 'timeout', 'music suggestion took too long')))
    }, SUGGEST_TIMEOUT_MS)
    const onAbort = () => {
      deps.queue.cancel(id)
      finish(() => reject(new HttpError(499, 'aborted', 'client went away')))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const now = deps.store.getJob(id)
    if (now && isFinal(now)) finish(() => resolve(now))
  })

export const musicRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  const music = () => musicServiceFor(deps.paths, deps.tools)

  app.get('/api/music/sources', async () => music().sources())

  app.get('/api/music/search', async (req, reply) => {
    const q = parse(MusicSearchQuery, req.query)
    return music().search(q, clientGone(reply))
  })

  app.post('/api/music/suggest', async (req, reply) => {
    const { projectId, ...body } = parse(SuggestBody, req.body)
    if (!deps.queue.has('music.suggest'))
      throw new HttpError(400, 'unsupported_job', 'music suggestions are not available')
    if (projectId && !deps.store.getProject(projectId)) throw notFound('project')
    const job = deps.queue.enqueue('music.suggest', body, projectId ? { projectId } : {})
    const done = await waitForJob(deps, job.id, clientGone(reply))
    if (done.status !== 'done')
      throw new HttpError(502, 'music_failed', done.error ?? `music suggestion ${done.status}`)
    return { jobId: done.id, ...(done.result as object) }
  })

  app.post('/api/music/import', async (req, reply) => {
    const body = parse(ImportBody, req.body)
    const svc = music()
    if (!(await svc.library.get(body.trackId))) throw notFound('track')
    const result = await svc.import(
      {
        paths: deps.paths,
        store: deps.store,
        emit: (e) => deps.bus.emit(e),
        enqueue: (kind, payload, opts) => deps.queue.enqueue(kind, payload, opts ?? {}),
      },
      body.trackId,
      body.length !== undefined ? { length: body.length } : {},
    )
    return reply.code(201).send(result)
  })

  app.get('/api/music/tracks/:id', async (req) => {
    const { id } = parse(TrackParams, req.params)
    const t = await music().library.describe(id)
    if (!t) throw notFound('track')
    return t
  })

  app.get('/api/music/tracks/:id/preview', async (req, reply) => {
    const { id } = parse(TrackParams, req.params)
    const svc = music()
    if (!(await svc.library.get(id))) throw notFound('track')
    let file: string
    try {
      file = await svc.library.preview(id, clientGone(reply))
    } catch (err) {
      throw new HttpError(502, 'preview_failed', err instanceof Error ? err.message : String(err))
    }
    return sendFile(req, reply, file, { cache: 'immutable', type: 'audio/mp4' })
  })
}
