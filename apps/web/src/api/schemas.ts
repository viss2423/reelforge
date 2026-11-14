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
  disk: z.looseObject({ free: z.number(), total: z.number() }).optional(),
  urls: z.array(z.string()).optional(),
  tailscale: z
    .looseObject({ ip: z.string().optional(), hostname: z.string().optional() })
    .optional(),
})
export type SystemInfo = z.infer<typeof SystemInfo>

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
