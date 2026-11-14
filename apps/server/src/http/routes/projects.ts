/** Project CRUD, optimistic-concurrency saves, duplication and the preview `.ass`. */
import {
  applyTemplate,
  buildAss,
  createProject,
  insertAudioClip,
  insertMediaClip,
  newId,
  Project,
  resolveBuiltinAnimation,
  type AnimationPreset,
  type Asset,
} from '@reelforge/core'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { RevisionConflictError } from '../../contracts.ts'
import type { PacksService } from '../../packs/service.ts'
import { type AppDeps, parse } from '../deps.ts'
import { HttpError, notFound } from '../errors.ts'

const IdParams = z.object({ id: z.string().min(1).max(64) })
const CreateBody = z.object({
  name: z.string().trim().min(1).max(200),
  templateRef: z.string().min(3).max(200).optional(),
  assetIds: z.array(z.string().min(1).max(64)).max(500).optional(),
})
const SaveBody = z.object({
  project: Project,
  expectedRevision: z.number().int().nonnegative(),
  deviceId: z.string().min(1).max(64),
})

/** Animation resolver over core's builtins (`builtin/<id>`) + installed packs (for buildAss). */
export const animationResolver =
  (packs: PacksService) =>
  (ref: string): AnimationPreset | undefined =>
    resolveBuiltinAnimation(ref) ?? packs.findAnimation(ref)

const loadAssets = (deps: AppDeps, ids: readonly string[]): Asset[] =>
  ids.map((id) => {
    const asset = deps.store.getAsset(id)
    if (!asset) throw new HttpError(404, 'not_found', `asset not found: ${id}`)
    return asset
  })

export const projectRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  const { store, packs, bus } = deps

  const getProject = (id: string): Project => {
    const project = store.getProject(id)
    if (!project) throw notFound('project')
    return project
  }

  app.get('/api/projects', async () => store.listProjects())

  app.post('/api/projects', async (req, reply) => {
    const body = parse(CreateBody, req.body)
    const assets = loadAssets(deps, body.assetIds ?? [])
    let project: Project
    if (body.templateRef) {
      const template = packs.findTemplate(body.templateRef)
      if (!template)
        throw new HttpError(404, 'not_found', `template not found: ${body.templateRef}`)
      project = applyTemplate(template, assets, {
        packs: packs.snapshot.manifests,
        name: body.name,
      })
    } else {
      project = createProject({ name: body.name })
      const main = project.tracks.find((t) => t.kind === 'main')
      for (const asset of assets) {
        if (asset.kind === 'audio') insertAudioClip(project, { asset, at: 0 })
        else if (main) insertMediaClip(project, { trackId: main.id, asset })
      }
    }
    const revision = store.saveProject(project, 0)
    return reply.code(201).send({ ...project, revision })
  })

  app.get('/api/projects/:id', async (req) => getProject(parse(IdParams, req.params).id))

  app.put('/api/projects/:id', { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
    const { id } = parse(IdParams, req.params)
    const body = parse(SaveBody, req.body)
    if (body.project.id !== id)
      throw new HttpError(400, 'id_mismatch', 'project id does not match URL')
    const doc: Project = { ...body.project, updatedAt: new Date().toISOString() }
    let revision: number
    try {
      revision = store.saveProject(doc, body.expectedRevision)
    } catch (err) {
      if (!(err instanceof RevisionConflictError)) throw err
      // The client rebases its pending patches onto the current document.
      return reply.code(409).send({
        error: { code: 'revision_conflict', message: err.message },
        revision: err.current,
        project: store.getProject(id) ?? null,
      })
    }
    bus.emit({ type: 'project', projectId: id, revision, origin: body.deviceId })
    return { revision }
  })

  app.delete('/api/projects/:id', async (req, reply) => {
    const { id } = parse(IdParams, req.params)
    getProject(id)
    store.deleteProject(id)
    return reply.code(204).send()
  })

  app.post('/api/projects/:id/duplicate', async (req, reply) => {
    const source = getProject(parse(IdParams, req.params).id)
    const now = new Date().toISOString()
    const copy: Project = {
      ...structuredClone(source),
      id: newId('p'),
      name: `${source.name} (copy)`.slice(0, 200),
      createdAt: now,
      updatedAt: now,
      revision: 0,
    }
    const revision = store.saveProject(copy, 0)
    return reply.code(201).send({ ...copy, revision })
  })

  app.get('/api/projects/:id/ass', async (req, reply) => {
    const project = getProject(parse(IdParams, req.params).id)
    // The document only changes with the project revision or the installed packs.
    const etag = `"${project.id}-${project.revision}-${packs.version ?? 'none'}"`
    void reply.header('etag', etag).header('cache-control', 'no-cache')
    if (req.headers['if-none-match'] === etag) return reply.code(304).send()
    const ass = buildAss(project, { resolveAnimation: animationResolver(packs) })
    return reply.type('text/plain; charset=utf-8').send(ass)
  })
}
