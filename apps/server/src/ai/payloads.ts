/**
 * Runtime validation of AI job payloads. Payloads arrive over HTTP, so every handler parses
 * them before touching the filesystem; extra optional knobs extend the server contracts.
 */
import { z } from 'zod'

const AssetId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'invalid assetId')
/** Microseconds, as everywhere in ReelForge. */
const UsValue = z.number().int().nonnegative()

export const TranscribePayloadSchema = z.object({
  assetId: AssetId,
  /** ISO 639-1 code or 'auto'. */
  language: z
    .string()
    .regex(/^(auto|[a-z]{2,3})$/)
    .optional(),
  /** Model id (`large-v3-turbo-q5_0`, `base`, ...) or ggml file name. */
  model: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .optional(),
  /** Extra filler words/phrases (lower-case) on top of the language defaults. */
  fillers: z.array(z.string().min(1).max(40)).max(200).optional(),
  /** Force a backend (default: fastest available with accurate word timing). */
  backend: z.enum(['auto', 'cli', 'hybrid']).optional(),
})
export type TranscribeOptions = z.infer<typeof TranscribePayloadSchema>

export const SilencePayloadSchema = z.object({
  assetId: AssetId,
  thresholdDb: z.number().min(-100).max(0).optional(),
  minSilence: UsValue.min(50_000).max(60_000_000).optional(),
  padding: UsValue.max(2_000_000).optional(),
})

export const BeatsPayloadSchema = z.object({
  assetId: AssetId,
  /** 'auto' (default): the neural model when installed, else the DSP tracker. */
  engine: z.enum(['auto', 'neural', 'dsp']).optional(),
})

export const ScenesPayloadSchema = z.object({
  assetId: AssetId,
  /** scdet threshold in percent (FFmpeg default 10). */
  threshold: z.number().min(1).max(100).optional(),
})

export const ReframePayloadSchema = z.object({
  assetId: AssetId,
  /** Sampling rate of the detector in frames per second. */
  fps: z.number().min(0.5).max(15).optional(),
  /** ONNX execution provider (default: fastest measured for this platform). */
  provider: z.enum(['auto', 'cpu', 'dml']).optional(),
  /** 'smart' (people, speaker, group framing; default when installed) or 'fast' (faces only). */
  mode: z.enum(['smart', 'fast']).optional(),
  /** Camera tracking strength: 0 calm to 1 tight (default 0.5). */
  strength: z.number().min(0).max(1).optional(),
})

export const MattePayloadSchema = z.object({
  assetId: AssetId,
  /** Matting model (`modnet`; BiRefNet was measured too slow for this host). */
  model: z.enum(['modnet']).optional(),
  /** ONNX execution provider (default: DirectML on Windows when it loads, else CPU). */
  provider: z.enum(['auto', 'cpu', 'dml']).optional(),
  /** Recompute even if a matte from the same model is cached. */
  force: z.boolean().optional(),
})

/** Parse a payload, turning zod issues into one readable error message. */
export const parsePayload = <T>(schema: z.ZodType<T>, payload: unknown): T => {
  const r = schema.safeParse(payload)
  if (r.success) return r.data
  const msg = r.error.issues.map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`).join('; ')
  throw new Error(`invalid payload — ${msg}`)
}
