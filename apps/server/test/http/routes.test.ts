/**
 * Every REST endpoint via `inject`: status codes, validation, Range/conditional responses,
 * caching headers, compression and the SPA fallback.
 *
 * Project routes run the real core ops (createProject/insert*, applyTemplate, buildAss).
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { Asset, Job, JobKind, Project, ServerEvent } from '@reelforge/core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { JobDefinition } from '../../src/contracts.ts'
import { animationResolver } from '../../src/http/routes/projects.ts'
import { exportFile } from '../../src/paths.ts'
import { assetDir, assetFile } from '../../src/paths.ts'
import { delay, tempDir, waitFor } from '../helpers.ts'
import { makeApp, UPLOAD_CHUNK, type Harness } from './harness.ts'

/** A bundled pack tree with one manifest, a LUT and a font. */
const writeBundledPacks = async (dir: string): Promise<void> => {
  await mkdir(path.join(dir, 'trend-a', 'luts'), { recursive: true })
  await mkdir(path.join(dir, 'fonts', 'Inter'), { recursive: true })
  await writeFile(
    path.join(dir, 'index.json'),
    JSON.stringify({
      version: '2026.11.7',
      updatedAt: '2026-11-07T00:00:00Z',
      packs: [{ id: 'trend-a', version: '1.0.0', name: 'Trend A', curatedAt: '2026-11-01' }],
      fonts: [],
    }),
  )
  await writeFile(
    path.join(dir, 'trend-a', 'pack.json'),
    JSON.stringify({
      id: 'trend-a',
      version: '1.0.0',
      name: 'Trend A',
      curatedAt: '2026-11-01',
      animations: [
        {
          id: 'pop',
          name: 'Pop',
          kind: 'in',
          tracks: {
            scale: [
              { t: 0, value: 0.2 },
              { t: 1, value: 1, easing: 'easeOutBack' },
            ],
          },
        },
      ],
      templates: [{ id: 'quick', name: 'Quick', slots: [{ duration: 1_000_000 }] }],
    }),
  )
  await writeFile(path.join(dir, 'trend-a', 'luts', 'warm.cube'), 'LUT_3D_SIZE 2\n')
  await writeFile(path.join(dir, 'fonts', 'Inter', 'Inter-Regular.ttf'), randomBytes(2048))
}

/** Fake job handlers: an export that writes an MP4, and a probe that can be held open. */
const gates = new Map<string, () => void>()
const definitions: JobDefinition[] = [
  {
    kind: 'export',
    resource: 'gpu-encode',
    defaultPriority: 50,
    handler: async (ctx) => {
      await new Promise<void>((resolve) => gates.set(ctx.job.id, resolve))
      await writeFile(exportFile(ctx.paths, ctx.job.id), randomBytes(4096))
      return { bytes: 4096 }
    },
  },
  {
    kind: 'probe',
    resource: 'io',
    defaultPriority: 10,
    handler: (ctx) =>
      new Promise((resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason as Error))
        gates.set(ctx.job.id, () => resolve(undefined))
      }),
  },
]

describe('REST API', () => {
  let h: Harness
  let packsDir: string
  let cleanupPacks: () => Promise<void>
  const events: ServerEvent[] = []

  beforeAll(async () => {
    ;({ dir: packsDir, cleanup: cleanupPacks } = await tempDir('rf-bundled-'))
    await writeBundledPacks(packsDir)
  })
  afterAll(() => cleanupPacks())
  beforeEach(async () => {
    h = await makeApp({ definitions, bundledPacks: packsDir })
    events.length = 0
    h.bus.subscribe((e) => events.push(e))
  })
  afterEach(async () => {
    for (const release of gates.values()) release()
    gates.clear()
    await h.cleanup()
  })

  const api = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD',
    url: string,
    payload?: unknown,
    headers = {},
  ) =>
    h.app.inject({
      method,
      url,
      headers: { ...h.headers, ...headers },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    })

  /** Registers an asset directly with an original file of `bytes`. */
  const addAsset = async (bytes: Buffer, over: Partial<Asset> = {}): Promise<Asset> => {
    const asset: Asset = {
      id: `a${Math.random().toString(36).slice(2, 10)}`,
      kind: 'video',
      name: 'clip.mp4',
      size: bytes.length,
      mime: 'video/mp4',
      createdAt: new Date().toISOString(),
      hasAudio: true,
      hasVideo: true,
      proxy: 'pending',
      thumbnails: 'pending',
      waveform: 'pending',
      ...over,
    }
    await mkdir(assetDir(h.paths, asset.id), { recursive: true })
    await writeFile(assetFile(h.paths, asset, 'original'), bytes)
    h.store.putAsset(asset)
    return asset
  }

  describe('projects', () => {
    it('creates, lists, reads, saves with revisions, duplicates and deletes', async () => {
      expect((await api('GET', '/api/projects')).json()).toEqual([])
      const audio = await addAsset(randomBytes(10), {
        kind: 'audio',
        mime: 'audio/mpeg',
        name: 'a.mp3',
        duration: 4_000_000,
      })
      const video = await addAsset(randomBytes(10), { duration: 2_000_000 })
      const created = await api('POST', '/api/projects', {
        name: 'My reel',
        assetIds: [video.id, audio.id],
      })
      expect(created.statusCode).toBe(201)
      const project = created.json() as Project
      expect(project).toMatchObject({ name: 'My reel', revision: 1 })
      const clipsOf = (kind: string) =>
        project.tracks.filter((t) => t.kind === kind).flatMap((t) => t.clips)
      expect(clipsOf('main')).toEqual([
        expect.objectContaining({ type: 'video', assetId: video.id, duration: 2_000_000 }),
      ])
      expect(clipsOf('audio')).toEqual([
        expect.objectContaining({ type: 'audio', assetId: audio.id, start: 0 }),
      ])

      const list = (await api('GET', '/api/projects')).json()
      expect(list).toEqual([
        // Core's projectDuration: the 4 s music bed outlasts the 2 s video.
        expect.objectContaining({ id: project.id, name: 'My reel', duration: 4_000_000 }),
      ])
      expect((await api('GET', `/api/projects/${project.id}`)).json()).toMatchObject({
        id: project.id,
      })
      expect((await api('GET', '/api/projects/p_missing')).statusCode).toBe(404)

      const saved = await api('PUT', `/api/projects/${project.id}`, {
        project: { ...project, name: 'Renamed' },
        expectedRevision: 1,
        deviceId: h.deviceId,
      })
      expect(saved.statusCode).toBe(200)
      expect(saved.json()).toEqual({ revision: 2 })
      expect(events).toContainEqual({
        type: 'project',
        projectId: project.id,
        revision: 2,
        origin: h.deviceId,
      })

      // A device saving against a stale revision gets the current document to rebase on.
      const stale = await api('PUT', `/api/projects/${project.id}`, {
        project: { ...project, name: 'Stale' },
        expectedRevision: 1,
        deviceId: 'other',
      })
      expect(stale.statusCode).toBe(409)
      expect(stale.json()).toMatchObject({
        error: { code: 'revision_conflict' },
        revision: 2,
        project: { name: 'Renamed', revision: 2 },
      })

      const mismatch = await api('PUT', `/api/projects/${project.id}`, {
        project: { ...project, id: 'p_other' },
        expectedRevision: 2,
        deviceId: 'x',
      })
      expect(mismatch.statusCode).toBe(400)
      expect(mismatch.json().error.code).toBe('id_mismatch')
      const invalid = await api('PUT', `/api/projects/${project.id}`, {
        project: { id: project.id },
      })
      expect(invalid.statusCode).toBe(400)
      expect(invalid.json().error.code).toBe('invalid_request')

      const dup = await api('POST', `/api/projects/${project.id}/duplicate`)
      expect(dup.statusCode).toBe(201)
      expect(dup.json()).toMatchObject({ name: 'Renamed (copy)', revision: 1 })
      expect(dup.json().id).not.toBe(project.id)
      expect((await api('POST', '/api/projects/p_missing/duplicate')).statusCode).toBe(404)

      expect((await api('DELETE', `/api/projects/${project.id}`)).statusCode).toBe(204)
      expect((await api('GET', `/api/projects/${project.id}`)).statusCode).toBe(404)
      expect((await api('DELETE', `/api/projects/${project.id}`)).statusCode).toBe(404)
    })

    it('validates creation input and applies pack templates', async () => {
      expect((await api('POST', '/api/projects', { name: '' })).statusCode).toBe(400)
      const missing = await api('POST', '/api/projects', { name: 'x', assetIds: ['a_nope'] })
      expect(missing.statusCode).toBe(404)
      // A video that has not been probed yet has no duration to place on the timeline.
      const unprobed = await addAsset(randomBytes(10))
      const notReady = await api('POST', '/api/projects', { name: 'x', assetIds: [unprobed.id] })
      expect(notReady.statusCode).toBe(400)
      expect(notReady.json().error.code).toBe('op_asset_not_ready')
      const noTemplate = await api('POST', '/api/projects', {
        name: 'x',
        templateRef: 'trend-a/nope',
      })
      expect(noTemplate.statusCode).toBe(404)
      const video = await addAsset(randomBytes(10), { duration: 5_000_000 })
      const res = await api('POST', '/api/projects', {
        name: 'From template',
        templateRef: 'trend-a/quick',
        assetIds: [video.id],
      })
      expect(res.statusCode).toBe(201)
      const project = res.json() as Project
      expect(project).toMatchObject({ name: 'From template', templateRef: 'trend-a/quick' })
      expect(project.tracks.find((t) => t.kind === 'main')?.clips).toEqual([
        expect.objectContaining({ assetId: video.id, duration: 1_000_000 }),
      ])
    })

    it('resolves builtin and pack animations', () => {
      const resolve = animationResolver(h.packs)
      expect(resolve('builtin/fade')).toMatchObject({ id: 'fade' })
      expect(resolve('trend-a/pop')).toMatchObject({ id: 'pop', kind: 'in' })
      expect(resolve('builtin/nope')).toBeUndefined()
      expect(resolve('trend-a/nope')).toBeUndefined()
      expect(resolve('nope')).toBeUndefined()
    })

    it('serves the preview .ass with revision ETags and resolves pack animations', async () => {
      const created = (await api('POST', '/api/projects', { name: 'Captions' })).json() as Project
      const title = {
        id: 'c_title',
        type: 'text',
        start: 0,
        duration: 2_000_000,
        text: 'Hello pop',
        animationIn: { ref: 'trend-a/pop', duration: 400_000 },
      }
      const plain = {
        id: 'c_plain',
        type: 'text',
        start: 2_000_000,
        duration: 1_000_000,
        text: 'Still',
      }
      const saved = await api('PUT', `/api/projects/${created.id}`, {
        project: {
          ...created,
          tracks: [...created.tracks, { id: 't_text', kind: 'text', clips: [title, plain] }],
        },
        expectedRevision: created.revision,
        deviceId: h.deviceId,
      })
      expect(saved.statusCode).toBe(200)
      const project = (await api('GET', `/api/projects/${created.id}`)).json() as Project

      const res = await api('GET', `/api/projects/${project.id}/ass`)
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8')
      expect(res.body).toContain('[Script Info]')
      expect(res.body).toContain('Title: Captions')
      const dialogue = res.body.split('\n').filter((l) => l.startsWith('Dialogue:'))
      const popped = dialogue.filter((l) => l.includes('Hello pop')).join('\n')
      const still = dialogue.filter((l) => l.includes('Still')).join('\n')
      expect(popped).not.toBe('')
      expect(still).not.toBe('')
      // The pack animation scales the title in; the un-animated clip has no scale tags.
      expect(popped).toMatch(/\\fsc[xy]\d/)
      expect(still).not.toMatch(/\\fsc[xy]\d/)
      const etag = res.headers.etag as string
      expect(etag).toContain(`-${project.revision}-2026.11.7`)
      expect(
        (await api('GET', `/api/projects/${project.id}/ass`, undefined, { 'if-none-match': etag }))
          .statusCode,
      ).toBe(304)
      expect((await api('GET', '/api/projects/p_missing/ass')).statusCode).toBe(404)
    })
  })

  describe('uploads and assets', () => {
    it('runs a full chunked upload with out-of-order and duplicate chunks', async () => {
      const data = randomBytes(UPLOAD_CHUNK * 2 + 300)
      const created = await api('POST', '/api/uploads', {
        name: 'Holiday.MP4',
        size: data.length,
        mime: 'video/mp4',
      })
      expect(created.statusCode).toBe(201)
      const { uploadId, chunkSize, chunks } = created.json()
      expect({ chunkSize, chunks }).toEqual({ chunkSize: UPLOAD_CHUNK, chunks: 3 })

      const put = (i: number, body: Buffer, contentType = 'application/octet-stream') =>
        api('PUT', `/api/uploads/${uploadId}/chunks/${i}`, body, { 'content-type': contentType })
      const part = (i: number) => data.subarray(i * UPLOAD_CHUNK, (i + 1) * UPLOAD_CHUNK)

      expect((await put(2, part(2))).json()).toEqual({ received: 1, chunks: 3 })
      // Any content type is streamed raw (some clients send none or a media type).
      expect((await put(0, part(0), 'video/mp4')).json()).toEqual({ received: 2, chunks: 3 })
      expect((await put(0, part(0))).json()).toEqual({ received: 2, chunks: 3 })
      const short = await put(1, part(1).subarray(10))
      expect(short.statusCode).toBe(400)
      expect(short.json().error.code).toBe('chunk_size_mismatch')
      expect((await api('GET', `/api/uploads/${uploadId}`)).json()).toMatchObject({
        received: [0, 2],
      })

      const early = await api('POST', `/api/uploads/${uploadId}/complete`)
      expect(early.statusCode).toBe(409)
      expect(early.json()).toMatchObject({
        error: { code: 'incomplete', details: { missing: [1] } },
      })

      await put(1, part(1))
      const done = await api('POST', `/api/uploads/${uploadId}/complete`)
      expect(done.statusCode).toBe(201)
      const asset = done.json() as Asset
      expect(asset).toMatchObject({ name: 'Holiday.MP4', kind: 'video', size: data.length })
      expect((await readFile(assetFile(h.paths, asset, 'original'))).equals(data)).toBe(true)
      // The probe job was enqueued for the new asset, and devices heard about it.
      await waitFor(() => h.store.listJobs({ assetId: asset.id }).length === 1)
      expect(h.store.listJobs({ assetId: asset.id })[0]).toMatchObject({ kind: 'probe' })
      expect(events.some((e) => e.type === 'asset' && e.asset.id === asset.id)).toBe(true)
      expect((await api('GET', `/api/uploads/${uploadId}`)).statusCode).toBe(404)
    })

    it('validates uploads and supports abort', async () => {
      expect(
        (await api('POST', '/api/uploads', { name: 'x.mp4', size: -1, mime: 'video/mp4' }))
          .statusCode,
      ).toBe(400)
      expect(
        (
          await api('POST', '/api/uploads', {
            name: 'x.exe',
            size: 10,
            mime: 'application/x-msdownload',
          })
        ).statusCode,
      ).toBe(415)
      expect(
        (
          await api('POST', '/api/uploads', {
            name: 'x.mp4',
            size: 2 * 1024 * 1024,
            mime: 'video/mp4',
          })
        ).statusCode,
      ).toBe(413)
      const { uploadId } = (
        await api('POST', '/api/uploads', { name: 'x.mp4', size: 10, mime: 'video/mp4' })
      ).json()
      expect(
        (await api('PUT', `/api/uploads/${uploadId}/chunks/5`, Buffer.alloc(10))).statusCode,
      ).toBe(400)
      expect(
        (await api('PUT', `/api/uploads/${uploadId}/chunks/abc`, Buffer.alloc(10))).statusCode,
      ).toBe(400)
      expect((await api('PUT', '/api/uploads/u_nope/chunks/0', Buffer.alloc(10))).statusCode).toBe(
        404,
      )
      expect((await api('DELETE', `/api/uploads/${uploadId}`)).statusCode).toBe(204)
      expect((await api('GET', `/api/uploads/${uploadId}`)).statusCode).toBe(404)
    })

    it('lists, reads and deletes assets (cancelling their jobs and removing files)', async () => {
      const asset = await addAsset(randomBytes(100))
      expect((await api('GET', '/api/assets')).json()).toEqual([
        expect.objectContaining({ id: asset.id }),
      ])
      expect((await api('GET', `/api/assets/${asset.id}`)).json()).toMatchObject({ id: asset.id })
      expect((await api('GET', '/api/assets/a_nope')).statusCode).toBe(404)
      expect((await api('GET', '/api/assets/bad..id')).statusCode).toBe(400)

      const job = h.queue.enqueue('probe', { assetId: asset.id }, { assetId: asset.id })
      await waitFor(() => gates.has(job.id))
      expect((await api('DELETE', `/api/assets/${asset.id}`)).statusCode).toBe(204)
      await h.queue.idle()
      expect(h.store.getJob(job.id)?.status).toBe('cancelled')
      expect(h.store.getAsset(asset.id)).toBeUndefined()
      expect((await api('GET', `/api/assets/${asset.id}/original`)).statusCode).toBe(404)
    })

    it('streams originals with Range, conditional requests and HEAD', async () => {
      const bytes = randomBytes(1000)
      const asset = await addAsset(bytes)
      const url = `/api/assets/${asset.id}/original`

      const full = await api('GET', url)
      expect(full.statusCode).toBe(200)
      expect(full.rawPayload.equals(bytes)).toBe(true)
      expect(full.headers).toMatchObject({
        'accept-ranges': 'bytes',
        'content-type': 'video/mp4',
        'content-length': '1000',
        'cache-control': 'private, max-age=31536000, immutable',
      })
      expect(full.headers['content-encoding']).toBeUndefined()
      const etag = full.headers.etag as string
      const lastModified = full.headers['last-modified'] as string
      expect(etag).toMatch(/^"[a-z0-9]+-[a-z0-9]+"$/)

      const cases: Array<[string, number, string | undefined, Buffer]> = [
        ['bytes=0-99', 206, 'bytes 0-99/1000', bytes.subarray(0, 100)],
        ['bytes=900-', 206, 'bytes 900-999/1000', bytes.subarray(900)],
        ['bytes=-100', 206, 'bytes 900-999/1000', bytes.subarray(900)],
        ['bytes=990-5000', 206, 'bytes 990-999/1000', bytes.subarray(990)],
        ['bytes=-5000', 206, 'bytes 0-999/1000', bytes],
        ['bytes=0-0', 206, 'bytes 0-0/1000', bytes.subarray(0, 1)],
        ['bytes=0-1,5-6', 200, undefined, bytes],
        ['items=0-1', 200, undefined, bytes],
        ['bytes=50-10', 200, undefined, bytes],
      ]
      for (const [range, status, contentRange, body] of cases) {
        const res = await api('GET', url, undefined, { range })
        expect({
          range,
          status: res.statusCode,
          contentRange: res.headers['content-range'],
          bodyMatches: res.rawPayload.equals(body),
        }).toEqual({ range, status, contentRange, bodyMatches: true })
        expect(res.headers['content-length']).toBe(String(body.length))
      }
      for (const range of ['bytes=1000-', 'bytes=5000-6000', 'bytes=-0']) {
        const res = await api('GET', url, undefined, { range })
        expect({ range, status: res.statusCode }).toEqual({ range, status: 416 })
        expect(res.headers['content-range']).toBe('bytes */1000')
        expect(res.json().error.code).toBe('range_not_satisfiable')
      }

      expect((await api('GET', url, undefined, { 'if-none-match': etag })).statusCode).toBe(304)
      expect(
        (await api('GET', url, undefined, { 'if-none-match': `"x", W/${etag}` })).statusCode,
      ).toBe(304)
      expect(
        (await api('GET', url, undefined, { 'if-modified-since': lastModified })).statusCode,
      ).toBe(304)
      expect((await api('GET', url, undefined, { 'if-none-match': '"other"' })).statusCode).toBe(
        200,
      )
      // If-Range: a stale validator turns the range request into a full response.
      const staleRange = await api('GET', url, undefined, {
        range: 'bytes=0-9',
        'if-range': '"stale"',
      })
      expect(staleRange.statusCode).toBe(200)
      const freshRange = await api('GET', url, undefined, { range: 'bytes=0-9', 'if-range': etag })
      expect(freshRange.statusCode).toBe(206)

      const head = await api('HEAD', url)
      expect(head.statusCode).toBe(200)
      expect(head.headers['content-length']).toBe('1000')
      expect(head.rawPayload.length).toBe(0)

      // Media works with the cookie alone (<video src> cannot send headers).
      const viaCookie = await h.app.inject({
        url,
        headers: { cookie: `rf_token=${h.token}`, range: 'bytes=0-1' },
      })
      expect(viaCookie.statusCode).toBe(206)
    })

    it('serves the proxy and derived files once ready', async () => {
      const asset = await addAsset(randomBytes(100))
      const notReady = await api('GET', `/api/assets/${asset.id}/proxy`)
      expect(notReady.statusCode).toBe(404)
      expect(notReady.json().error).toMatchObject({
        code: 'not_ready',
        message: 'proxy is pending',
      })
      expect(notReady.headers['cache-control']).toBe('no-store')

      await writeFile(assetFile(h.paths, asset, 'proxy'), randomBytes(500))
      h.store.patchAsset(asset.id, { proxy: 'ready' })
      const proxy = await api('GET', `/api/assets/${asset.id}/proxy`, undefined, {
        range: 'bytes=0-9',
      })
      expect(proxy.statusCode).toBe(206)
      expect(proxy.headers['content-type']).toBe('video/mp4')

      expect((await api('GET', `/api/assets/${asset.id}/thumbs.json`)).statusCode).toBe(404)
      const index = {
        interval: 500_000,
        columns: 2,
        rows: 1,
        tileWidth: 96,
        tileHeight: 170,
        count: 2,
      }
      await writeFile(assetFile(h.paths, asset, 'thumbsIndex'), JSON.stringify(index))
      await writeFile(assetFile(h.paths, asset, 'thumbs'), randomBytes(50))
      await writeFile(assetFile(h.paths, asset, 'poster'), randomBytes(50))
      await writeFile(
        assetFile(h.paths, asset, 'waveform'),
        '{"bucketUs":10000,"count":0,"peaks":[]}',
      )
      const thumbs = await api('GET', `/api/assets/${asset.id}/thumbs.json`)
      expect(thumbs.json()).toEqual(index)
      expect(thumbs.headers['cache-control']).toContain('immutable')
      expect((await api('GET', `/api/assets/${asset.id}/thumbs.jpg`)).headers['content-type']).toBe(
        'image/jpeg',
      )
      expect((await api('GET', `/api/assets/${asset.id}/poster.jpg`)).statusCode).toBe(200)
      expect((await api('GET', `/api/assets/${asset.id}/waveform.json`)).json()).toMatchObject({
        count: 0,
      })
      expect((await api('GET', `/api/assets/${asset.id}/probe.json`)).statusCode).toBe(404)
      expect(
        (await api('GET', `/api/assets/${asset.id}/..%2F..%2Freelforge.sqlite`)).statusCode,
      ).toBe(404)
    })
  })

  describe('jobs and exports', () => {
    it('submits, lists, reads and cancels jobs', async () => {
      const project = (await api('POST', '/api/projects', { name: 'P' })).json() as Project
      expect((await api('POST', '/api/jobs', { kind: 'nonsense' })).statusCode).toBe(400)
      const unsupported = await api('POST', '/api/jobs', {
        kind: 'transcribe' satisfies JobKind,
        payload: {},
      })
      expect(unsupported.statusCode).toBe(400)
      expect(unsupported.json().error.code).toBe('unsupported_job')
      expect(
        (await api('POST', '/api/jobs', { kind: 'export', projectId: 'p_nope' })).statusCode,
      ).toBe(404)
      expect(
        (await api('POST', '/api/jobs', { kind: 'probe', assetId: 'a_nope' })).statusCode,
      ).toBe(404)

      const created = await api('POST', '/api/jobs', {
        kind: 'export',
        projectId: project.id,
        payload: { q: 1 },
      })
      expect(created.statusCode).toBe(201)
      const job = created.json() as Job
      expect(job).toMatchObject({ kind: 'export', status: 'queued', projectId: project.id })
      await waitFor(() => gates.has(job.id))

      const active = (
        await api('GET', `/api/jobs?active=1&projectId=${project.id}`)
      ).json() as Job[]
      expect(active.map((j) => [j.id, j.status])).toEqual([[job.id, 'running']])
      expect((await api('GET', '/api/jobs?active=0')).json()).toEqual([])
      expect((await api('GET', '/api/jobs?active=maybe')).statusCode).toBe(400)
      expect((await api('GET', `/api/jobs/${job.id}`)).json()).toMatchObject({ status: 'running' })
      expect((await api('GET', '/api/jobs/j_nope')).statusCode).toBe(404)

      const cancelled = await api('POST', `/api/jobs/${job.id}/cancel`)
      expect(cancelled.statusCode).toBe(200)
      gates.get(job.id)!()
      await h.queue.idle()
      expect((await api('GET', `/api/jobs/${job.id}`)).json()).toMatchObject({
        status: 'cancelled',
      })
      expect((await api('POST', '/api/jobs/j_nope/cancel')).statusCode).toBe(404)
    })

    it('serves finished exports with Range and an optional download name', async () => {
      const project = (
        await api('POST', '/api/projects', { name: 'Summer: "best" reel' })
      ).json() as Project
      const job = (
        await api('POST', '/api/jobs', { kind: 'export', projectId: project.id })
      ).json() as Job
      await waitFor(() => gates.has(job.id))
      const early = await api('GET', `/api/exports/${job.id}/file`)
      expect(early.statusCode).toBe(409)
      expect(early.json().error.code).toBe('not_ready')

      gates.get(job.id)!()
      await h.queue.idle()
      const file = await api('GET', `/api/exports/${job.id}/file`)
      expect(file.statusCode).toBe(200)
      expect(file.headers['content-type']).toBe('video/mp4')
      expect(file.headers['content-disposition']).toBeUndefined()
      expect(file.rawPayload.length).toBe(4096)
      const ranged = await api('GET', `/api/exports/${job.id}/file`, undefined, {
        range: 'bytes=4000-',
      })
      expect(ranged.statusCode).toBe(206)
      expect(ranged.rawPayload.length).toBe(96)
      const download = await api('GET', `/api/exports/${job.id}/file?download=1`)
      expect(download.headers['content-disposition']).toBe(
        `attachment; filename="Summer best reel.mp4"; filename*=UTF-8''Summer%20best%20reel.mp4`,
      )

      const probe = h.queue.enqueue('probe', {})
      expect((await api('GET', `/api/exports/${probe.id}/file`)).statusCode).toBe(404)
      expect((await api('GET', '/api/exports/j_nope/file')).statusCode).toBe(404)
    })
  })

  describe('packs and system', () => {
    it('serves the manifest index with ETag revalidation', async () => {
      const res = await api('GET', '/api/packs')
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body).toMatchObject({
        version: '2026.11.7',
        source: 'bundled',
        index: { version: '2026.11.7' },
      })
      expect(body.manifests.map((m: { id: string }) => m.id)).toEqual(['trend-a'])
      expect(res.headers['cache-control']).toBe('no-cache')
      expect(
        (await api('GET', '/api/packs', undefined, { 'if-none-match': res.headers.etag as string }))
          .statusCode,
      ).toBe(304)
    })

    it('serves pack files immutably and blocks traversal', async () => {
      const lut = await api('GET', '/api/packs/files/trend-a/luts/warm.cube')
      expect(lut.statusCode).toBe(200)
      expect(lut.body).toBe('LUT_3D_SIZE 2\n')
      expect(lut.headers['cache-control']).toContain('immutable')
      const font = await api('GET', '/api/packs/files/fonts/Inter/Inter-Regular.ttf')
      expect(font.headers['content-type']).toBe('font/ttf')
      for (const url of [
        '/api/packs/files/../index.json',
        '/api/packs/files/trend-a/..%2F..%2Fsecret',
        '/api/packs/files/%2e%2e/%2e%2e/reelforge.sqlite',
        '/api/packs/files/trend-a/luts/missing.cube',
        '/api/packs/files/',
      ]) {
        const res = await api('GET', url)
        expect({ url, status: res.statusCode }).toEqual({ url, status: 404 })
      }
      expect(
        (await h.app.inject({ url: '/api/packs/files/trend-a/luts/warm.cube' })).statusCode,
      ).toBe(401)
    })

    it('reports sync failures as 502', async () => {
      const res = await api('POST', '/api/packs/sync')
      expect(res.statusCode).toBe(502)
      expect(res.json().error.code).toBe('sync_failed')
    })

    it('GET /api/system describes the host', async () => {
      const res = await api('GET', '/api/system')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        version: '0.1.0',
        node: process.versions.node,
        cpu: { threads: 4 },
        memory: { total: expect.any(Number) },
        disk: { free: expect.any(Number), total: expect.any(Number) },
        toolchain: { ffmpegVersion: '9.0.2', hwEncoders: {} },
        jobs: { kinds: ['export', 'probe'], classes: { 'gpu-encode': { limit: 1 } } },
        packs: { version: '2026.11.7', source: 'bundled' },
        urls: ['https://192.168.1.10:8443', 'https://localhost:8443'],
        tailscale: { installed: false },
      })
    })

    it('compresses JSON (not media) for clients that accept it', async () => {
      for (let i = 0; i < 30; i++)
        await addAsset(randomBytes(10), { name: `clip-${i}-${'x'.repeat(40)}.mp4` })
      const res = await api('GET', '/api/assets', undefined, { 'accept-encoding': 'gzip' })
      expect(res.headers['content-encoding']).toBe('gzip')
      expect(JSON.parse(gunzipSync(res.rawPayload).toString())).toHaveLength(30)
      const br = await api('GET', '/api/assets', undefined, { 'accept-encoding': 'br, gzip' })
      expect(br.headers['content-encoding']).toBe('br')
      const asset = h.store.listAssets()[0]!
      const media = await api('GET', `/api/assets/${asset.id}/original`, undefined, {
        'accept-encoding': 'gzip',
      })
      expect(media.headers['content-encoding']).toBeUndefined()
    })
  })

  it('unknown API routes are JSON 404s', async () => {
    const res = await api('GET', '/api/nope')
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } })
    expect((await api('POST', '/somewhere')).statusCode).toBe(404)
  })

  it('progress of a running job is visible through GET /api/jobs/:id', async () => {
    // Not throttled away: the live job object is returned between persisted writes.
    const def = definitions[1]!
    void def
    const job = h.queue.enqueue('probe', {})
    await waitFor(() => gates.has(job.id))
    await delay(5)
    expect((await api('GET', `/api/jobs/${job.id}`)).json().status).toBe('running')
  })
})

describe('web app serving', () => {
  let h: Harness
  let dist: string
  let cleanupDist: () => Promise<void>

  beforeAll(async () => {
    ;({ dir: dist, cleanup: cleanupDist } = await tempDir('rf-dist-'))
    await mkdir(path.join(dist, 'assets'))
    await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>ReelForge</title>')
    await writeFile(path.join(dist, 'sw.js'), 'self.addEventListener("fetch",()=>{})')
    await writeFile(path.join(dist, 'manifest.webmanifest'), '{"name":"ReelForge"}')
    await writeFile(
      path.join(dist, 'assets', 'index-abc123.js'),
      `console.log(${'1+'.repeat(800)}1)`,
    )
  })
  afterAll(() => cleanupDist())
  afterEach(() => h.cleanup())

  it('serves the build with SPA fallback and the right cache policy', async () => {
    h = await makeApp({ webDist: dist })
    const html = { accept: 'text/html,application/xhtml+xml' }
    const index = await h.app.inject({ url: '/', headers: html })
    expect(index.statusCode).toBe(200)
    expect(index.body).toContain('<title>ReelForge</title>')
    expect(index.headers['cache-control']).toBe('no-cache')
    expect(index.headers['content-security-policy']).toContain("'wasm-unsafe-eval'")

    const route = await h.app.inject({ url: '/editor/p_123?tab=text', headers: html })
    expect(route.statusCode).toBe(200)
    expect(route.body).toContain('<title>ReelForge</title>')

    const asset = await h.app.inject({
      url: '/assets/index-abc123.js',
      headers: { 'accept-encoding': 'gzip' },
    })
    expect(asset.statusCode).toBe(200)
    expect(asset.headers['cache-control']).toBe('private, max-age=31536000, immutable')
    expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(asset.headers['content-encoding']).toBe('gzip')

    const sw = await h.app.inject({ url: '/sw.js' })
    expect(sw.headers['cache-control']).toBe('no-cache')
    const manifest = await h.app.inject({ url: '/manifest.webmanifest' })
    expect(manifest.headers['content-type']).toBe('application/manifest+json; charset=utf-8')

    expect((await h.app.inject({ url: '/assets/missing-123.js' })).statusCode).toBe(404)
    expect((await h.app.inject({ url: '/../package.json', headers: html })).statusCode).toBe(404)
    const head = await h.app.inject({ method: 'HEAD', url: '/assets/index-abc123.js' })
    expect(head.statusCode).toBe(200)
    expect(head.rawPayload.length).toBe(0)
    expect((await h.app.inject({ url: '/%2e%2e/%2e%2e/secret.txt' })).statusCode).toBe(404)
    // Malformed percent-encoding is rejected by the router itself.
    expect((await h.app.inject({ url: '/%E0%A4%A' })).statusCode).toBe(400)
    expect((await h.app.inject({ url: '/api/nope', headers: html })).statusCode).toBe(404)
  })

  it('shows a placeholder page when the web app has not been built', async () => {
    h = await makeApp()
    const res = await h.app.inject({ url: '/', headers: { accept: 'text/html' } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('has not been built yet')
    expect(
      (await h.app.inject({ url: '/app.js', headers: { accept: 'application/javascript' } }))
        .statusCode,
    ).toBe(404)
  })
})
