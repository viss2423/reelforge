/**
 * Music library wire model, shared by the server (`apps/server/src/music`) and the web app:
 * royalty-free tracks found through the library sources, suggestion requests and results.
 */
import { z } from 'zod'
import { Asset, Us } from './schema.ts'

/** Vibes the editor offers as one-tap chips; each maps to search terms, tempo and energy. */
export const MusicMood = z.enum([
  'upbeat',
  'energetic',
  'chill',
  'emotional',
  'cinematic',
  'dark',
  'romantic',
  'funny',
  'inspiring',
  'lofi',
])
export type MusicMood = z.infer<typeof MusicMood>

export const MusicLicence = z.object({
  /** `cc0`, `pdm` (public domain mark), `by` (attribution), `generated`. */
  code: z.string(),
  /** Human name, e.g. `CC BY 4.0`. */
  name: z.string(),
  url: z.string().optional(),
  attributionRequired: z.boolean(),
})
export type MusicLicence = z.infer<typeof MusicLicence>

/** A track known to the host's music library (found by a source, possibly cached locally). */
export const LibraryTrack = z.object({
  /** `<source>:<foreign id>` */
  id: z.string(),
  source: z.string(),
  /** Catalogue the source got it from (e.g. Openverse → `jamendo`). */
  provider: z.string().optional(),
  title: z.string(),
  artist: z.string(),
  licence: MusicLicence,
  /** Credit line to add to the post caption (when the licence requires attribution). */
  attribution: z.string().optional(),
  pageUrl: z.string().optional(),
  duration: Us,
  bpm: z.number().optional(),
  key: z.string().optional(),
  tags: z.array(z.string()).default([]),
  genres: z.array(z.string()).default([]),
  instrumental: z.boolean().optional(),
  /** 0..1, from the host analysis. */
  energy: z.number().optional(),
  /** Most energetic section in source time (host analysis). */
  section: z.object({ start: Us, end: Us }).optional(),
  /** Audio is in the host cache (instant preview/import). */
  cached: z.boolean().default(false),
  /** BPM/energy/section come from the host analysis rather than the catalogue. */
  analyzed: z.boolean().default(false),
})
export type LibraryTrack = z.infer<typeof LibraryTrack>

export const MusicSearchQuery = z.object({
  /** Free text. */
  q: z.string().max(200).optional(),
  mood: MusicMood.optional(),
  genre: z.string().max(40).optional(),
  bpmMin: z.coerce.number().min(30).max(300).optional(),
  bpmMax: z.coerce.number().min(30).max(300).optional(),
  /** Restrict to one source id. */
  source: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
export type MusicSearchQuery = z.infer<typeof MusicSearchQuery>

/**
 * A sound that is trending today (from the trend engine: Deezer/Apple charts). Only its
 * metadata is used to find a similar royalty-free track; its audio is never stored.
 */
export const TrendSoundProfile = z.object({
  title: z.string().max(300),
  artist: z.string().max(300).optional(),
  bpm: z.number().min(0).max(400).optional(),
  genre: z.string().max(60).optional(),
  mood: MusicMood.optional(),
  /** 0..1 */
  energy: z.number().min(0).max(1).optional(),
  /** 0..1 chart strength (1 = top). */
  weight: z.number().min(0).max(1).default(1),
})
export type TrendSoundProfile = z.input<typeof TrendSoundProfile>

/** How suggestions are ordered: similarity to today's trending sounds (default) or relevance. */
export const MusicOrder = z.enum(['trend', 'relevance'])
export type MusicOrder = z.infer<typeof MusicOrder>

export const MusicSuggestRequest = z.object({
  /** Free-text vibe ("summer road trip", "gym motivation"). */
  vibe: z.string().max(200).optional(),
  mood: MusicMood.optional(),
  genre: z.string().max(40).optional(),
  targetBpm: z.number().min(30).max(300).optional(),
  /** 0..1 wanted energy. */
  energy: z.number().min(0).max(1).optional(),
  /** `trend` (default): rank by similarity to today's trending sounds as well as the vibe. */
  order: MusicOrder.default('trend'),
  /** Match this one trending sound ("Find similar free track") instead of today's top list. */
  sound: TrendSoundProfile.optional(),
  /** Length of the reel to fill. */
  duration: Us.default(30_000_000),
  /** The reel has speech: prefer instrumentals, duck under the voice. */
  hasSpeech: z.boolean().default(false),
  limit: z.number().int().min(1).max(20).default(6),
  /** How many of the best matches to download and analyse (BPM, energy, chorus). */
  analyze: z.number().int().min(0).max(6).default(2),
})
export type MusicSuggestRequest = z.input<typeof MusicSuggestRequest>

export const RankedTrack = LibraryTrack.extend({
  /** 0..1 */
  score: z.number(),
  /** Short human reasons ("instrumental", "128 BPM", "no credit needed"). */
  reasons: z.array(z.string()).default([]),
  /** The trending sound this track is most similar to (trend order only). */
  trendMatch: z
    .object({ title: z.string(), artist: z.string().optional(), similarity: z.number() })
    .optional(),
})
export type RankedTrack = z.infer<typeof RankedTrack>

export const MusicSuggestResult = z.object({
  tracks: z.array(RankedTrack),
  /** Search terms used. */
  terms: z.string(),
  /** Sources that failed or were skipped (offline, rate limited, no key). */
  warnings: z.array(z.string()).default([]),
  tookMs: z.number(),
})
export type MusicSuggestResult = z.infer<typeof MusicSuggestResult>

export const MusicSourceInfo = z.object({
  id: z.string(),
  name: z.string(),
  available: z.boolean(),
  /** Why the source is unavailable, or a note about its catalogue/licences. */
  note: z.string().optional(),
  homepage: z.string().optional(),
})
export type MusicSourceInfo = z.infer<typeof MusicSourceInfo>

/** Result of importing a library track as a project asset. */
export const MusicImportResult = z.object({
  /** The new audio asset (probe runs next; wait until it is placeable). */
  asset: Asset,
  bpm: z.number(),
  beats: z.array(Us),
  downbeats: z.array(Us),
  section: z.object({ start: Us, end: Us }),
})
export type MusicImportResult = z.infer<typeof MusicImportResult>
