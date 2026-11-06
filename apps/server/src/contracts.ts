/**
 * Internal server contracts. These interfaces are the seam between the HTTP/platform layer
 * (src/http, src/db, src/media, src/jobs, src/packs, src/net, src/auth) and the
 * render/AI layer (src/render, src/ai). Change only with care — both sides depend on them.
 */
import type { Asset, Job, JobKind, Project, ServerEvent } from '@reelforge/core'

/** Absolute filesystem layout of the data directory (default: ~/.reelforge, env REELFORGE_DATA). */
export interface DataPaths {
  root: string
  db: string // <root>/reelforge.sqlite
  media: string // <root>/media/<assetId>/{original.<ext>,proxy.mp4,thumbs.jpg,thumbs.json,waveform.json}
  exports: string // <root>/exports/<jobId>.mp4
  packs: string // <root>/packs (synced trend packs; falls back to repo ./packs in dev)
  models: string // <root>/models (whisper ggml, onnx)
  bin: string // <root>/bin (whisper.cpp binaries etc.)
  certs: string // <root>/certs (local CA + server cert)
  tmp: string // <root>/tmp
}

/** Resolved external tool locations + capabilities, detected once at startup. */
export interface Toolchain {
  ffmpeg: string
  ffprobe: string
  ffmpegVersion: string
  /** Hardware encoders that passed a real test encode at startup. */
  hwEncoders: { h264?: string; hevc?: string; av1?: string }
  /** whisper.cpp CLI path if installed (scripts/setup.mjs). */
  whisper?: string
  whisperModels: string[]
  cpuThreads: number
}

export interface Logger {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
  debug(obj: unknown, msg?: string): void
}

/** Persistence API (implemented by src/db). Synchronous: better-sqlite3. */
export interface Store {
  getProject(id: string): Project | undefined
  listProjects(): Array<
    Pick<Project, 'id' | 'name' | 'updatedAt' | 'createdAt'> & {
      thumbAssetId?: string
      duration: number
    }
  >
  /** Throws RevisionConflictError if `expectedRevision` != stored revision. Returns new revision. */
  saveProject(project: Project, expectedRevision: number): number
  deleteProject(id: string): void
  getAsset(id: string): Asset | undefined
  listAssets(): Asset[]
  putAsset(asset: Asset): void
  patchAsset(id: string, patch: Partial<Asset>): Asset
  deleteAsset(id: string): void
  getJob(id: string): Job | undefined
  listJobs(filter?: { projectId?: string; assetId?: string; active?: boolean }): Job[]
  putJob(job: Job): void
  getSetting<T>(key: string): T | undefined
  setSetting<T>(key: string, value: T): void
}

export class RevisionConflictError extends Error {
  readonly current: number
  constructor(current: number) {
    super(`revision conflict (current ${current})`)
    this.current = current
  }
}

/** Passed to every job handler. */
export interface JobContext<P = unknown> {
  job: Job
  payload: P
  signal: AbortSignal
  /** Report progress 0..1, an optional status line and ETA (microseconds). Throttled by the queue. */
  progress(p: number, message?: string, eta?: number): void
  paths: DataPaths
  tools: Toolchain
  store: Store
  log: Logger
  /** Enqueue a follow-up job (e.g. probe -> proxy/thumbnails/waveform). */
  enqueue<Q>(
    kind: JobKind,
    payload: Q,
    opts?: { projectId?: string; assetId?: string; priority?: number },
  ): Job
  emit(event: ServerEvent): void
}

/** Returned value is stored as `job.result`. Throwing marks the job failed. Must honour `signal`. */
export type JobHandler<P = unknown> = (ctx: JobContext<P>) => Promise<unknown>

/**
 * Resource classes for scheduling: the queue runs at most N jobs per class concurrently so
 * an export never starves interactive proxy generation, and GPU encodes don't oversubscribe.
 */
export type ResourceClass = 'io' | 'cpu' | 'gpu-encode' | 'ai'

export interface JobDefinition<P = unknown> {
  kind: JobKind
  resource: ResourceClass
  /** Lower = sooner. Interactive work (proxy, preview) < export < background AI. */
  defaultPriority: number
  handler: JobHandler<P>
}

/** Payloads */
export interface ProbePayload {
  assetId: string
}
export interface AssetDerivePayload {
  assetId: string
}
export interface ExportPayload {
  projectId: string
  settings: import('@reelforge/core').ExportSettings
}
export interface PreviewPayload {
  projectId: string
  start: number
  end: number
}
export interface TranscribePayload {
  assetId: string
  language?: string
  model?: string
}
export interface SilencePayload {
  assetId: string
  thresholdDb?: number
  minSilence?: number
}
export interface BeatsPayload {
  assetId: string
}
export interface ScenesPayload {
  assetId: string
  threshold?: number
}
export interface ReframePayload {
  assetId: string
}
