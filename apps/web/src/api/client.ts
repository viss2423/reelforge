/**
 * Typed HTTP client for the ReelForge server (see docs/ARCHITECTURE.md → HTTP API).
 *
 * - Auth: same-origin cookie (`credentials: 'include'`) plus `Authorization: Bearer` when a
 *   token is stored, so both browser-managed and header-based auth work.
 * - Validation: responses are parsed with zod in development only (`import.meta.env.DEV &&
 *   Schema` lets the production build drop the schemas entirely).
 * - Errors: non-2xx → `ApiError` with status and parsed body; a 401 also notifies
 *   `onUnauthorized` so the app can return to pairing.
 */
import { Asset, ExportSettings, Job, JobKind, Project } from '@reelforge/core'
import { z, type ZodType } from 'zod'
import { auth } from './auth.ts'
import {
  ConflictBody,
  Device,
  Health,
  PacksWire,
  PairResult,
  ProjectSummary,
  SaveResult,
  SystemWire,
  toSystemInfo,
  type SystemInfo,
  UploadInit,
  UploadStatus,
  type Packs,
} from './schemas.ts'

/** Manifests may arrive as an array or keyed by pack id; the app always sees an array. */
const normalizePacks = (wire: PacksWire): Packs => ({
  index: wire.index,
  manifests: Array.isArray(wire.manifests) ? wire.manifests : Object.values(wire.manifests),
})

export class ApiError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
  /** Worth retrying: network-ish / overload statuses. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500
  }
}

/** Thrown by `saveProject` on 409: carries the server's current project for rebasing. */
export class RevisionConflict extends Error {
  readonly project: Project
  constructor(project: Project) {
    super(`revision conflict (server at ${project.revision})`)
    this.name = 'RevisionConflict'
    this.project = project
  }
}

type Schema<T> = ZodType<T> | false | undefined

export interface RequestOptions<T> {
  body?: unknown
  /** Raw body (e.g. Blob) sent as-is instead of JSON. */
  rawBody?: BodyInit
  schema?: Schema<T>
  signal?: AbortSignal
  headers?: Record<string, string>
}

export interface ApiClientOptions {
  /** Origin prefix, '' for same-origin (default). */
  baseUrl?: string
  fetch?: typeof fetch
  getToken?: () => string | null
  onUnauthorized?: () => void
}

export interface JobFilter {
  active?: boolean
  projectId?: string
  assetId?: string
}

export interface CreateProjectInput {
  name: string
  templateRef?: string
  assetIds?: string[]
}

const enc = encodeURIComponent

export class ApiClient {
  readonly baseUrl: string
  private readonly fetchImpl: () => typeof fetch
  private readonly getToken: () => string | null
  onUnauthorized: (() => void) | undefined

  constructor(opts: ApiClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? ''
    // Resolve lazily so tests (and polyfills) can replace globalThis.fetch after construction.
    this.fetchImpl = () => opts.fetch ?? globalThis.fetch
    this.getToken = opts.getToken ?? (() => auth.token)
    this.onUnauthorized = opts.onUnauthorized
  }

  /** Headers for requests made outside `request` (uploads via XHR). */
  authHeaders(): Record<string, string> {
    const token = this.getToken()
    return token ? { authorization: `Bearer ${token}` } : {}
  }

  url(path: string): string {
    return `${this.baseUrl}${path}`
  }

  async request<T>(method: string, path: string, opts: RequestOptions<T> = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json', ...this.authHeaders() }
    let body: BodyInit | undefined = opts.rawBody
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(opts.body)
    }
    Object.assign(headers, opts.headers)
    let res: Response
    try {
      res = await this.fetchImpl()(this.url(path), {
        method,
        headers,
        body: body ?? null,
        credentials: 'include',
        signal: opts.signal ?? null,
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err
      throw new ApiError(0, err instanceof Error ? err.message : 'Network error')
    }
    const text = res.status === 204 ? '' : await res.text()
    let data: unknown = undefined
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
    }
    if (!res.ok) {
      if (res.status === 401) this.onUnauthorized?.()
      const msg =
        (typeof data === 'object' && data && 'message' in data && typeof data.message === 'string'
          ? data.message
          : undefined) ?? `${method} ${path} failed (${res.status})`
      throw new ApiError(res.status, msg, data)
    }
    if (opts.schema) {
      const parsed = opts.schema.safeParse(data)
      if (!parsed.success) {
        console.error(`[api] ${method} ${path}: response does not match schema`, parsed.error)
        throw new ApiError(res.status, `Unexpected response from ${path}`, data)
      }
      return parsed.data
    }
    return data as T
  }

  /* ---------------------------------------------------------------- system & auth */

  health(signal?: AbortSignal): Promise<Health> {
    return this.request('GET', '/api/health', { schema: import.meta.env.DEV && Health, signal })
  }
  pair(code: string, deviceName: string): Promise<PairResult> {
    return this.request('POST', '/api/pair', {
      body: { code, deviceName },
      schema: import.meta.env.DEV && PairResult,
    })
  }
  pairLocal(): Promise<PairResult> {
    return this.request('POST', '/api/pair/local', { schema: import.meta.env.DEV && PairResult })
  }
  devices(signal?: AbortSignal): Promise<Device[]> {
    return this.request('GET', '/api/devices', {
      schema: import.meta.env.DEV && z.array(Device),
      signal,
    })
  }
  revokeDevice(id: string): Promise<void> {
    return this.request('DELETE', `/api/devices/${enc(id)}`)
  }
  async system(signal?: AbortSignal): Promise<SystemInfo> {
    const wire = await this.request<SystemWire>('GET', '/api/system', {
      schema: import.meta.env.DEV && SystemWire,
      signal,
    })
    return toSystemInfo(wire)
  }

  /* ---------------------------------------------------------------- projects */

  projects(signal?: AbortSignal): Promise<ProjectSummary[]> {
    return this.request('GET', '/api/projects', {
      schema: import.meta.env.DEV && z.array(ProjectSummary),
      signal,
    })
  }
  project(id: string, signal?: AbortSignal): Promise<Project> {
    return this.request('GET', `/api/projects/${enc(id)}`, {
      schema: import.meta.env.DEV && Project,
      signal,
    })
  }
  createProject(input: CreateProjectInput): Promise<Project> {
    return this.request('POST', '/api/projects', {
      body: input,
      schema: import.meta.env.DEV && Project,
    })
  }
  /**
   * Optimistic-concurrency save. Resolves with the new revision; throws `RevisionConflict`
   * (with the server's project) when someone else saved first.
   */
  async saveProject(
    project: Project,
    expectedRevision: number,
    deviceId: string,
    signal?: AbortSignal,
  ): Promise<number> {
    try {
      const res = await this.request<SaveResult>('PUT', `/api/projects/${enc(project.id)}`, {
        body: { project, expectedRevision, deviceId },
        schema: import.meta.env.DEV && SaveResult,
        signal,
      })
      return res.revision
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const body = import.meta.env.DEV ? ConflictBody.safeParse(err.body) : undefined
        if (body && !body.success) throw err
        const server = (err.body as { project?: Project } | undefined)?.project
        if (server) throw new RevisionConflict(server)
      }
      throw err
    }
  }
  deleteProject(id: string): Promise<void> {
    return this.request('DELETE', `/api/projects/${enc(id)}`)
  }
  duplicateProject(id: string): Promise<Project> {
    return this.request('POST', `/api/projects/${enc(id)}/duplicate`, {
      schema: import.meta.env.DEV && Project,
    })
  }

  /* ---------------------------------------------------------------- uploads & assets */

  initUpload(file: { name: string; size: number; mime: string }): Promise<UploadInit> {
    return this.request('POST', '/api/uploads', {
      body: file,
      schema: import.meta.env.DEV && UploadInit,
    })
  }
  uploadStatus(uploadId: string, signal?: AbortSignal): Promise<UploadStatus> {
    return this.request('GET', `/api/uploads/${enc(uploadId)}`, {
      schema: import.meta.env.DEV && UploadStatus,
      signal,
    })
  }
  chunkUrl(uploadId: string, index: number): string {
    return this.url(`/api/uploads/${enc(uploadId)}/chunks/${index}`)
  }
  completeUpload(uploadId: string, signal?: AbortSignal): Promise<Asset> {
    return this.request('POST', `/api/uploads/${enc(uploadId)}/complete`, {
      schema: import.meta.env.DEV && Asset,
      signal,
    })
  }
  assets(signal?: AbortSignal): Promise<Asset[]> {
    return this.request('GET', '/api/assets', {
      schema: import.meta.env.DEV && z.array(Asset),
      signal,
    })
  }
  asset(id: string, signal?: AbortSignal): Promise<Asset> {
    return this.request('GET', `/api/assets/${enc(id)}`, {
      schema: import.meta.env.DEV && Asset,
      signal,
    })
  }
  deleteAsset(id: string): Promise<void> {
    return this.request('DELETE', `/api/assets/${enc(id)}`)
  }

  /* ---------------------------------------------------------------- jobs & exports */

  createJob(input: {
    kind: JobKind
    payload: unknown
    projectId?: string
    assetId?: string
  }): Promise<Job> {
    if (import.meta.env.DEV) JobKind.parse(input.kind)
    return this.request('POST', '/api/jobs', { body: input, schema: import.meta.env.DEV && Job })
  }
  /** Starts an export job for a project. */
  exportProject(projectId: string, settings: ExportSettings): Promise<Job> {
    if (import.meta.env.DEV) ExportSettings.parse(settings)
    return this.createJob({ kind: 'export', payload: { projectId, settings }, projectId })
  }
  jobs(filter: JobFilter = {}, signal?: AbortSignal): Promise<Job[]> {
    const q = new URLSearchParams()
    if (filter.active) q.set('active', '1')
    if (filter.projectId) q.set('projectId', filter.projectId)
    if (filter.assetId) q.set('assetId', filter.assetId)
    const qs = q.size ? `?${q.toString()}` : ''
    return this.request('GET', `/api/jobs${qs}`, {
      schema: import.meta.env.DEV && z.array(Job),
      signal,
    })
  }
  job(id: string, signal?: AbortSignal): Promise<Job> {
    return this.request('GET', `/api/jobs/${enc(id)}`, {
      schema: import.meta.env.DEV && Job,
      signal,
    })
  }
  cancelJob(id: string): Promise<void> {
    return this.request('POST', `/api/jobs/${enc(id)}/cancel`)
  }

  /* ---------------------------------------------------------------- packs */

  async packs(signal?: AbortSignal): Promise<Packs> {
    const wire = await this.request<PacksWire>('GET', '/api/packs', {
      schema: import.meta.env.DEV && PacksWire,
      signal,
    })
    return normalizePacks(wire)
  }
  syncPacks(): Promise<void> {
    return this.request('POST', '/api/packs/sync')
  }

  /* ---------------------------------------------------------------- URLs for media elements */

  mediaUrl(assetId: string, variant: 'proxy' | 'original'): string {
    return this.url(`/api/assets/${enc(assetId)}/${variant}`)
  }
  posterUrl(assetId: string): string {
    return this.url(`/api/assets/${enc(assetId)}/poster.jpg`)
  }
  thumbsUrl(assetId: string): string {
    return this.url(`/api/assets/${enc(assetId)}/thumbs.jpg`)
  }
  thumbsIndexUrl(assetId: string): string {
    return this.url(`/api/assets/${enc(assetId)}/thumbs.json`)
  }
  waveformUrl(assetId: string): string {
    return this.url(`/api/assets/${enc(assetId)}/waveform.json`)
  }
  exportFileUrl(jobId: string, download = false): string {
    return this.url(`/api/exports/${enc(jobId)}/file${download ? '?download=1' : ''}`)
  }
  /** `.ass` subtitle document for the preview; revision busts the HTTP cache. */
  assUrl(projectId: string, revision: number): string {
    return this.url(`/api/projects/${enc(projectId)}/ass?rev=${revision}`)
  }
  packFileUrl(path: string): string {
    return this.url(`/api/packs/files/${path.split('/').map(enc).join('/')}`)
  }
  /** WebSocket URL; carries the token as a query param because WS cannot send headers. */
  eventsUrl(origin: { protocol: string; host: string } = location): string {
    const base = this.baseUrl || `${origin.protocol}//${origin.host}`
    const url = new URL('/api/events', base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const token = this.getToken()
    if (token) url.searchParams.set('token', token)
    return url.toString()
  }
}
