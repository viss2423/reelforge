import { describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError, RevisionConflict } from '@/api/client.ts'
import { makeAsset, makeProject } from '../fixtures.ts'

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

/** Parses a captured request body (the client always sends JSON strings). */
const bodyOf = (init: RequestInit | undefined): unknown =>
  JSON.parse(typeof init?.body === 'string' ? init.body : 'null')

const setup = (
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
  token: string | null = 'tok',
) => {
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => respond(urlOf(url), init ?? {}))
  const onUnauthorized = vi.fn<() => void>()
  const client = new ApiClient({
    baseUrl: 'https://host:8443',
    fetch: fetchMock,
    getToken: () => token,
    onUnauthorized,
  })
  return { client, fetchMock, onUnauthorized }
}

describe('ApiClient.request', () => {
  it('sends JSON with bearer auth and cookies, and parses the response', async () => {
    const project = makeProject()
    const { client, fetchMock } = setup(() => json(200, project))
    const res = await client.createProject({ name: 'New' })
    expect(res.id).toBe(project.id)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://host:8443/api/projects')
    expect(init?.method).toBe('POST')
    expect(init?.credentials).toBe('include')
    expect(init?.body).toBe(JSON.stringify({ name: 'New' }))
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer tok',
      'content-type': 'application/json',
      accept: 'application/json',
    })
  })

  it('omits the Authorization header without a token', async () => {
    const { client, fetchMock } = setup(() => json(200, { ok: true, version: '1' }), null)
    await client.health()
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('authorization')
  })

  it('maps HTTP errors to ApiError with the server message', async () => {
    const { client } = setup(() => json(422, { message: 'name too long' }))
    const err = await client.createProject({ name: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 422, message: 'name too long', retryable: false })
  })

  it('falls back to a generic message for non-JSON errors', async () => {
    const { client } = setup(() => new Response('<html>oops</html>', { status: 502 }))
    const err = (await client.projects().catch((e: unknown) => e)) as ApiError
    expect(err.message).toBe('GET /api/projects failed (502)')
    expect(err.body).toBe('<html>oops</html>')
    expect(err.retryable).toBe(true)
  })

  it('maps network failures to status 0 (retryable) and keeps AbortError', async () => {
    const { client } = setup(() => {
      throw new TypeError('Failed to fetch')
    })
    await expect(client.projects()).rejects.toMatchObject({ status: 0, retryable: true })
    const aborting = setup(() => {
      throw new DOMException('aborted', 'AbortError')
    })
    await expect(aborting.client.projects()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('calls onUnauthorized on 401', async () => {
    const { client, onUnauthorized } = setup(() => json(401, { message: 'unpaired' }))
    await expect(client.projects()).rejects.toBeInstanceOf(ApiError)
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('validates responses against the schema in development', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { client } = setup(() => json(200, { nope: true }))
    await expect(client.project('p1')).rejects.toThrow('Unexpected response from /api/projects/p1')
    expect(errSpy).toHaveBeenCalled()
  })

  it('handles 204 No Content', async () => {
    const { client } = setup(() => new Response(null, { status: 204 }))
    await expect(client.deleteProject('p1')).resolves.toBeUndefined()
  })

  it('url-encodes path segments', async () => {
    const { client, fetchMock } = setup(() => new Response(null, { status: 204 }))
    await client.revokeDevice('a/b c')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://host:8443/api/devices/a%2Fb%20c')
  })
})

describe('saveProject', () => {
  it('PUTs project + expectedRevision + deviceId and returns the new revision', async () => {
    const p = makeProject({ revision: 3 })
    const { client, fetchMock } = setup(() => json(200, { revision: 4 }))
    await expect(client.saveProject(p, 3, 'dev')).resolves.toBe(4)
    const init = fetchMock.mock.calls[0]?.[1]
    expect(init?.method).toBe('PUT')
    expect(bodyOf(init)).toEqual({ project: p, expectedRevision: 3, deviceId: 'dev' })
  })

  it('throws RevisionConflict with the server project on 409', async () => {
    const server = makeProject({ revision: 9, name: 'server' })
    const { client } = setup(() => json(409, { project: server }))
    const err = await client.saveProject(makeProject(), 1, 'dev').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RevisionConflict)
    expect((err as RevisionConflict).project).toMatchObject({ name: 'server', revision: 9 })
  })

  it('rethrows a 409 without a usable project as ApiError', async () => {
    const { client } = setup(() => json(409, { message: 'locked' }))
    await expect(client.saveProject(makeProject(), 1, 'dev')).rejects.toBeInstanceOf(ApiError)
  })
})

describe('endpoints', () => {
  it('builds job filters as query params', async () => {
    const { client, fetchMock } = setup(() => json(200, []))
    await client.jobs({ active: true, projectId: 'p 1' })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://host:8443/api/jobs?active=1&projectId=p+1')
    await client.jobs()
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://host:8443/api/jobs')
  })

  it('exportProject posts an export job and validates settings', async () => {
    const job = { id: 'j1', kind: 'export', status: 'queued', createdAt: '2026-01-01T00:00:00Z' }
    const { client, fetchMock } = setup(() => json(200, job))
    const settings = {
      resolution: '1080p',
      codec: 'h264',
      encoder: 'auto',
      quality: 'high',
      loudnessTarget: -14,
      normalizeLoudness: true,
    } as const
    await client.exportProject('p1', settings)
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
      kind: 'export',
      payload: { projectId: 'p1', settings },
      projectId: 'p1',
    })
    expect(() => client.exportProject('p1', { ...settings, quality: 'ultra' as 'high' })).toThrow(
      /quality/,
    )
  })

  it('completeUpload returns the asset', async () => {
    const asset = makeAsset({ id: 'a9' })
    const { client } = setup(() => json(200, asset))
    await expect(client.completeUpload('u1')).resolves.toMatchObject({ id: 'a9' })
  })

  it('normalises packs manifests sent keyed by pack id', async () => {
    const index = { version: '7', updatedAt: '2026-01-01', packs: [], fonts: [] }
    const manifest = { id: 'core', version: '1', name: 'Core', curatedAt: '2026-01-01' }
    const { client } = setup(() => json(200, { index, manifests: { core: manifest } }))
    const packs = await client.packs()
    expect(packs.index.version).toBe('7')
    expect(packs.manifests.map((m) => m.id)).toEqual(['core'])
  })
})

describe('URLs', () => {
  const client = new ApiClient({ baseUrl: '', getToken: () => 'se cret' })
  it('media URLs', () => {
    expect(client.mediaUrl('a1', 'proxy')).toBe('/api/assets/a1/proxy')
    expect(client.posterUrl('a1')).toBe('/api/assets/a1/poster.jpg')
    expect(client.waveformUrl('a1')).toBe('/api/assets/a1/waveform.json')
    expect(client.thumbsUrl('a1')).toBe('/api/assets/a1/thumbs.jpg')
    expect(client.thumbsIndexUrl('a1')).toBe('/api/assets/a1/thumbs.json')
    expect(client.exportFileUrl('j1')).toBe('/api/exports/j1/file')
    expect(client.exportFileUrl('j1', true)).toBe('/api/exports/j1/file?download=1')
    expect(client.assUrl('p1', 7)).toBe('/api/projects/p1/ass?rev=7')
    expect(client.chunkUrl('u1', 3)).toBe('/api/uploads/u1/chunks/3')
  })

  it('pack file URLs keep slashes but encode segments', () => {
    expect(client.packFileUrl('fonts/Bebas Neue/BebasNeue-Regular.ttf')).toBe(
      '/api/packs/files/fonts/Bebas%20Neue/BebasNeue-Regular.ttf',
    )
  })

  it('events URL switches to ws(s) and carries the token', () => {
    expect(client.eventsUrl({ protocol: 'https:', host: 'box.local:8443' })).toBe(
      'wss://box.local:8443/api/events?token=se+cret',
    )
    expect(client.eventsUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe(
      'ws://localhost:5173/api/events?token=se+cret',
    )
  })
})
