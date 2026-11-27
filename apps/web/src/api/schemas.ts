/**
 * Response schemas for endpoints whose payloads are not core model types. Core types
 * (Project, Asset, Job, PackIndex, PackManifest) are validated with the core zod schemas.
 * Objects are `looseObject` so additive server changes never break older clients.
 *
 * Only types and DEV-guarded validation may reference this module: production code paths
 * must not import values from it, so the whole module (and zod) stays out of the bundle.
 */
import { PackIndex, PackManifest, Project } from '@reelforge/core'
import { z } from 'zod'

export const Health = z.looseObject({ ok: z.boolean(), version: z.string() })
export type Health = z.infer<typeof Health>

export const PairResult = z.looseObject({ token: z.string().min(1), deviceId: z.string().min(1) })
export type PairResult = z.infer<typeof PairResult>

export const Device = z.looseObject({
  id: z.string(),
  name: z.string(),
  createdAt: z.string().optional(),
  lastSeenAt: z.string().optional(),
  /** True for the device making the request. */
  current: z.boolean().optional(),
})
export type Device = z.infer<typeof Device>

export const ProjectSummary = z.looseObject({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  thumbAssetId: z.string().optional(),
  duration: z.number(),
})
export type ProjectSummary = z.infer<typeof ProjectSummary>

const Encoders = z.looseObject({
  h264: z.string().optional(),
  hevc: z.string().optional(),
  av1: z.string().optional(),
})

/** `GET /api/system`. Every field optional except version: the UI shows "—" for gaps. */
export const SystemInfo = z.looseObject({
  version: z.string(),
  hostname: z.string().optional(),
  platform: z.string().optional(),
  cpu: z.looseObject({ model: z.string(), threads: z.number() }).optional(),
  memory: z.looseObject({ total: z.number(), free: z.number() }).optional(),
  gpu: z.string().optional(),
  ffmpegVersion: z.string().optional(),
  hwEncoders: Encoders.optional(),
  whisper: z.looseObject({ installed: z.boolean(), models: z.array(z.string()) }).optional(),
  /** Local language model (AI hooks, best moments, captions emphasis). */
  llm: z.looseObject({ installed: z.boolean(), model: z.string().nullish() }).optional(),
  disk: z.looseObject({ free: z.number(), total: z.number() }).optional(),
  urls: z.array(z.string()).optional(),
  tailscale: z
    .looseObject({ ip: z.string().optional(), hostname: z.string().optional() })
    .optional(),
})
export type SystemInfo = z.infer<typeof SystemInfo>

/** `GET /api/system` as the server sends it: tool details are nested under `toolchain`. */
export const SystemWire = z.looseObject({
  version: z.string(),
  hostname: z.string().optional(),
  platform: z.string().optional(),
  cpu: z.looseObject({ model: z.string(), threads: z.number() }).optional(),
  memory: z.looseObject({ total: z.number(), free: z.number() }).optional(),
  disk: z.looseObject({ free: z.number(), total: z.number() }).nullish(),
  toolchain: z
    .looseObject({
      ffmpegVersion: z.string().optional(),
      hwEncoders: Encoders.optional(),
      whisper: z.string().nullish(),
      whisperModels: z.array(z.string()).optional(),
      llm: z.looseObject({ installed: z.boolean(), model: z.string().nullish() }).optional(),
    })
    .optional(),
  urls: z.array(z.string()).optional(),
  tailscale: z
    .looseObject({
      running: z.boolean().optional(),
      dnsName: z.string().optional(),
      ips: z.array(z.string()).optional(),
    })
    .nullish(),
})
export type SystemWire = z.infer<typeof SystemWire>

/** `ggml-large-v3-turbo-q5_0.bin` → `large-v3-turbo-q5_0`. */
const modelName = (file: string): string => file.replace(/^ggml-/, '').replace(/\.bin$/, '')

/** Flattens the server's `/api/system` payload into what the UI shows. */
export const toSystemInfo = (w: SystemWire): SystemInfo => {
  const t = w.toolchain
  const ts = w.tailscale?.running ? w.tailscale : undefined
  return {
    version: w.version,
    ...(w.hostname !== undefined && { hostname: w.hostname }),
    ...(w.platform !== undefined && { platform: w.platform }),
    ...(w.cpu && { cpu: w.cpu }),
    ...(w.memory && { memory: w.memory }),
    ...(w.disk && { disk: w.disk }),
    ...(t?.ffmpegVersion !== undefined && { ffmpegVersion: t.ffmpegVersion }),
    ...(t?.hwEncoders && { hwEncoders: t.hwEncoders }),
    ...(t && {
      whisper: { installed: !!t.whisper, models: (t.whisperModels ?? []).map(modelName) },
    }),
    ...(t?.llm && { llm: t.llm }),
    ...(w.urls && { urls: w.urls }),
    ...(ts && {
      tailscale: {
        ...(ts.dnsName !== undefined && { hostname: ts.dnsName }),
        ...(ts.ips?.[0] !== undefined && { ip: ts.ips[0] }),
      },
    }),
  }
}

export const UploadInit = z.looseObject({
  uploadId: z.string().min(1),
  chunkSize: z.number().int().positive(),
})
export type UploadInit = z.infer<typeof UploadInit>

export const UploadStatus = z.looseObject({ received: z.array(z.number().int().nonnegative()) })
export type UploadStatus = z.infer<typeof UploadStatus>

export const SaveResult = z.looseObject({ revision: z.number().int().nonnegative() })
export type SaveResult = z.infer<typeof SaveResult>

export const ConflictBody = z.looseObject({ project: Project })

/** `GET /api/packs` as sent. Manifests may arrive as an array or keyed by pack id. */
export const PacksWire = z.looseObject({
  index: PackIndex,
  manifests: z.union([z.array(PackManifest), z.record(z.string(), PackManifest)]),
})
export type PacksWire = z.infer<typeof PacksWire>

/** Normalised packs payload used by the app. */
export interface Packs {
  index: PackIndex
  manifests: PackManifest[]
}

/* ------------------------------------------------------------------ trends */

const TrendSignalWire = z.looseObject({
  text: z.string(),
  weight: z.number(),
  sources: z.array(z.string()),
})
export type TrendSignalWire = z.infer<typeof TrendSignalWire>

export const ReelIdea = z.looseObject({
  topic: z.string(),
  title: z.string(),
  hooks: z.array(z.string()),
  shots: z.array(z.string()),
  caption: z.string(),
  hashtags: z.array(z.string()),
  /** `<packId>/<templateId>` or '' */
  template: z.string(),
})
export type ReelIdea = z.infer<typeof ReelIdea>

/** `GET /api/trends`: the trend engine's latest results (Trending Now, Settings → Trends). */
export const Trends = z.looseObject({
  enabled: z.boolean(),
  generatedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  stale: z.boolean(),
  running: z.boolean(),
  nextRunAt: z.string().nullable(),
  sources: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      state: z.enum(['ok', 'error', 'disabled']),
      items: z.number(),
      error: z.string().optional(),
    }),
  ),
  topics: z.array(TrendSignalWire),
  hashtags: z.array(z.string()),
  formats: z.array(TrendSignalWire),
  aesthetics: z.array(TrendSignalWire),
  sounds: z.array(
    z.looseObject({
      title: z.string(),
      artist: z.string().optional(),
      bpm: z.number(),
      measured: z.boolean(),
      sources: z.array(z.string()),
      link: z.string(),
      genre: z.string().optional(),
      mood: z.string().optional(),
      energy: z.number().optional(),
      firstSeen: z.string().optional(),
      fresh: z.boolean().optional(),
    }),
  ),
  items: z.array(
    z.looseObject({
      ref: z.string(),
      collection: z.string(),
      name: z.string(),
      trend: z.string(),
      createdAt: z.string(),
      fresh: z.boolean(),
    }),
  ),
  ideas: z.array(ReelIdea),
  llm: z.looseObject({ used: z.boolean() }),
  settings: z.looseObject({ autoPublish: z.boolean() }),
  publishAvailable: z.boolean(),
  /** Synced trending-sound previews are enabled on the host (TRENDS_SOUND_PREVIEW=1). */
  soundPreview: z.boolean().optional(),
  publish: z
    .looseObject({ at: z.string(), status: z.string(), url: z.string().optional() })
    .nullable(),
})
export type Trends = z.infer<typeof Trends>

/** `GET /api/trends/sounds/preview-info` */
export const SoundPreviewInfo = z.looseObject({
  available: z.boolean(),
  source: z.string().optional(),
  duration: z.number().optional(),
  link: z.string().optional(),
})
export type SoundPreviewInfo = z.infer<typeof SoundPreviewInfo>

/** `POST /api/trends/sounds/beats` */
export const SoundBeats = z.looseObject({
  bpm: z.number(),
  beats: z.array(z.number()),
  downbeats: z.array(z.number()),
  duration: z.number(),
  engine: z.string(),
})
export type SoundBeats = z.infer<typeof SoundBeats>
