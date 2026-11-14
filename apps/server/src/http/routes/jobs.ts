/** Job submission/listing/cancellation and export downloads. */
import { JobKind, type Job } from '@reelforge/core'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { exportFile } from '../../paths.ts'
import { type AppDeps, parse } from '../deps.ts'
import { HttpError, notFound } from '../errors.ts'
import { sendFile } from '../send.ts'

const IdParams = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) })
const ExportParams = z.object({ jobId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) })
const CreateJob = z.object({
  kind: JobKind,
  payload: z.unknown().default({}),
  projectId: z.string().min(1).max(64).optional(),
  assetId: z.string().min(1).max(64).optional(),
  priority: z.number().int().min(0).max(1000).optional(),
})
const ListQuery = z.object({
  active: z.enum(['0', '1', 'true', 'false']).optional(),
  projectId: z.string().max(64).optional(),
  assetId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
})
const DownloadQuery = z.object({ download: z.enum(['0', '1', 'true', 'false']).optional() })

// Control characters plus the characters Windows forbids in file names.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_FILE_CHARS = /[\u0000-\u001f<>:"/\\|?*]+/g

const safeFileName = (name: string): string =>
  name.replace(UNSAFE_FILE_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'reel'

export const jobRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  const { store, queue, paths } = deps

  /** Prefer the queue's live copy (fresher progress than the throttled persisted one). */
  const fresh = (job: Job): Job => queue.active(job.id) ?? job

  app.post('/api/jobs', async (req, reply) => {
    const body = parse(CreateJob, req.body)
    if (!queue.has(body.kind))
      throw new HttpError(400, 'unsupported_job', `job kind not available: ${body.kind}`)
    if (body.projectId && !store.getProject(body.projectId)) throw notFound('project')
    if (body.assetId && !store.getAsset(body.assetId)) throw notFound('asset')
    const job = queue.enqueue(body.kind, body.payload, {
      ...(body.projectId ? { projectId: body.projectId } : {}),
      ...(body.assetId ? { assetId: body.assetId } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
    })
    return reply.code(201).send(job)
  })

  app.get('/api/jobs', async (req) => {
    const q = parse(ListQuery, req.query)
    const active = q.active === undefined ? undefined : q.active === '1' || q.active === 'true'
    return store
      .listJobs({
        ...(q.projectId ? { projectId: q.projectId } : {}),
        ...(q.assetId ? { assetId: q.assetId } : {}),
        ...(active !== undefined ? { active } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
      })
      .map(fresh)
  })

  app.get('/api/jobs/:id', async (req) => {
    const { id } = parse(IdParams, req.params)
    const job = queue.active(id) ?? store.getJob(id)
    if (!job) throw notFound('job')
    return job
  })

  app.post('/api/jobs/:id/cancel', async (req) => {
    const { id } = parse(IdParams, req.params)
    const job = queue.cancel(id)
    if (!job) throw notFound('job')
    return job
  })

  app.get('/api/exports/:jobId/file', async (req, reply) => {
    const { jobId } = parse(ExportParams, req.params)
    const q = parse(DownloadQuery, req.query)
    const job = store.getJob(jobId)
    if (!job || job.kind !== 'export') throw notFound('export')
    if (job.status !== 'done') throw new HttpError(409, 'not_ready', `export is ${job.status}`)
    const project = job.projectId ? store.getProject(job.projectId) : undefined
    const download = q.download === '1' || q.download === 'true'
    return sendFile(req, reply, exportFile(paths, jobId), {
      cache: 'immutable',
      type: 'video/mp4',
      ...(download ? { downloadName: `${safeFileName(project?.name ?? 'reel')}.mp4` } : {}),
    })
  })
}
