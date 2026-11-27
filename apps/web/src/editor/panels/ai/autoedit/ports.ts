/**
 * Ports to the music library and the trends feed, which other host modules provide
 * (POST /api/music/suggest, POST /api/music/import, GET /api/trends). Auto Edit codes
 * against these small interfaces: tests inject fakes, and when the host does not offer an
 * endpoint (older host, feature off) the HTTP implementations degrade to "nothing found".
 */
import type { Asset, Us } from '@reelforge/core'
import { api, ApiError } from '@/api/index.ts'

export interface MusicTrack {
  id: string
  title: string
  artist?: string
  bpm?: number
  /** Where the energetic section starts (µs into the track). */
  startAt?: Us
  license?: string
  /** The trending sound this free track resembles (trend-matched ordering). */
  trendMatch?: { title: string; artist?: string }
}

/** A library track turned into a project asset, with the host's analysis. */
export interface ImportedMusic {
  asset: Asset
  beats?: Us[]
  downbeats?: Us[]
  /** Energetic section (chorus) in source time. */
  section?: { start: Us; end: Us }
}

export interface MusicSuggestRequest {
  mood: string
  targetBpm?: number
  /** Today's trending sound this pick should match (genre/mood/energy 0..1). */
  genre?: string
  energy?: number
  /** `trend` (host default): ranked by similarity to today's trending sounds. */
  order?: 'trend' | 'relevance'
  /** Match one trending sound instead of today's top list. */
  sound?: {
    title: string
    artist?: string
    bpm?: number
    genre?: string
    mood?: string
    energy?: number
  }
  /** Reel length the music must cover (µs). */
  duration: Us
  hasSpeech: boolean
}

export interface MusicPort {
  /** Ranked suggestions, best first (empty when the library is unavailable). */
  suggest(req: MusicSuggestRequest, signal?: AbortSignal): Promise<MusicTrack[]>
  /** Turns a suggestion into a project asset. */
  import(track: MusicTrack, signal?: AbortSignal): Promise<ImportedMusic>
}

/** A trend-feed item that maps to a pack-style ref, newest first. */
export interface TrendStyleRef {
  ref: string
  tags: string[]
  /** ISO time it was generated (newer wins among equal matches). */
  createdAt?: string
}

export interface TrendTemplate extends TrendStyleRef {
  name: string
  captionStyle?: string
  filter?: string
  transition?: string
  textPreset?: string
  musicHint?: { title: string; bpm?: number }
}

/** A currently trending sound (we never ship or generate it; creators add it when posting). */
export interface TrendingSound {
  name: string
  artist?: string
  bpm?: number
  genre?: string
  mood?: string
  /** 0..1 */
  energy?: number
}

export interface Trends {
  topics: { name: string; vibe?: string }[]
  templates: TrendTemplate[]
  sounds: TrendingSound[]
}

export interface TrendsPort {
  get(signal?: AbortSignal): Promise<Trends | undefined>
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const tags = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []

/** Lenient parse of suggestion payloads (`{ tracks: [...] }` or a bare array). */
export const parseTracks = (data: unknown): MusicTrack[] => {
  const list = Array.isArray(data)
    ? data
    : isObj(data) && Array.isArray(data.tracks)
      ? data.tracks
      : []
  const out: MusicTrack[] = []
  for (const t of list) {
    if (!isObj(t)) continue
    const id = str(t.id)
    if (!id) continue
    const bpm = num(t.bpm)
    const startAt =
      num(t.startAt) ??
      num(t.energyStart) ??
      num(t.start) ??
      (isObj(t.section) ? num(t.section.start) : undefined)
    const artist = str(t.artist)
    const license = str(t.license) ?? (isObj(t.licence) ? str(t.licence.name) : undefined)
    const tm = isObj(t.trendMatch) ? t.trendMatch : undefined
    const tmTitle = tm ? str(tm.title) : undefined
    const tmArtist = tm ? str(tm.artist) : undefined
    out.push({
      id,
      title: str(t.title) ?? str(t.name) ?? 'Track',
      ...(artist ? { artist } : {}),
      ...(bpm ? { bpm } : {}),
      ...(startAt !== undefined && startAt >= 0 ? { startAt: Math.round(startAt) } : {}),
      ...(license ? { license } : {}),
      ...(tmTitle
        ? { trendMatch: { title: tmTitle, ...(tmArtist ? { artist: tmArtist } : {}) } }
        : {}),
    })
  }
  return out
}

/** Lenient parse of `GET /api/trends`. */
export const parseTrends = (data: unknown): Trends | undefined => {
  if (!isObj(data)) return undefined
  const topics = (Array.isArray(data.topics) ? data.topics : [])
    .map((t) => {
      if (typeof t === 'string') return { name: t }
      if (!isObj(t)) return undefined
      const name = str(t.name) ?? str(t.title)
      const vibe = str(t.vibe)
      return name ? { name, ...(vibe ? { vibe } : {}) } : undefined
    })
    .filter((t) => t !== undefined)
  const templates: TrendTemplate[] = []
  // The trends host module lists generated templates as `items` ({ ref, trend, fresh }).
  const listed = Array.isArray(data.templates)
    ? data.templates
    : Array.isArray(data.items)
      ? data.items
      : []
  for (const t of listed) {
    if (!isObj(t)) continue
    const ref = str(t.ref) ?? str(t.id)
    if (!ref) continue
    const hint = isObj(t.musicHint) && str(t.musicHint.title) ? t.musicHint : undefined
    const createdAt = str(t.createdAt) ?? str(t.generatedAt) ?? str(t.fresh)
    const pick = (k: string) => str(t[k])
    const bpm = hint ? num(hint.bpm) : undefined
    templates.push({
      ref,
      name: str(t.name) ?? ref,
      tags: tags(t.tags),
      ...(createdAt ? { createdAt } : {}),
      ...(pick('captionStyle') ? { captionStyle: pick('captionStyle')! } : {}),
      ...(pick('filter') ? { filter: pick('filter')! } : {}),
      ...(pick('transition') ? { transition: pick('transition')! } : {}),
      ...(pick('textPreset') ? { textPreset: pick('textPreset')! } : {}),
      ...(hint ? { musicHint: { title: String(hint.title), ...(bpm ? { bpm } : {}) } } : {}),
    })
  }
  const sounds: TrendingSound[] = []
  for (const x of Array.isArray(data.sounds) ? data.sounds : []) {
    if (!isObj(x)) continue
    const name = str(x.name) ?? str(x.title)
    if (!name) continue
    const artist = str(x.artist)
    const bpm = num(x.bpm)
    const genre = str(x.genre)
    const mood = str(x.mood)
    const energy = num(x.energy)
    sounds.push({
      name,
      ...(artist ? { artist } : {}),
      ...(bpm ? { bpm } : {}),
      ...(genre ? { genre } : {}),
      ...(mood ? { mood } : {}),
      ...(energy !== undefined ? { energy: Math.min(1, Math.max(0, energy)) } : {}),
    })
  }
  return { topics, templates, sounds }
}

/** 404/501 → the host does not offer the feature. */
const missing = (err: unknown): boolean =>
  err instanceof ApiError && (err.status === 404 || err.status === 501)

export const httpMusic: MusicPort = {
  async suggest(req, signal) {
    try {
      return parseTracks(
        await api.request('POST', '/api/music/suggest', {
          body: req,
          ...(signal ? { signal } : {}),
        }),
      )
    } catch (err) {
      if (missing(err)) return []
      throw err
    }
  },
  async import(track, signal) {
    const data = await api.request<unknown>('POST', '/api/music/import', {
      body: { trackId: track.id },
      ...(signal ? { signal } : {}),
    })
    const asset = isObj(data) && isObj(data.asset) ? data.asset : data
    if (!isObj(asset) || typeof asset.id !== 'string')
      throw new Error('The host returned no asset for the music')
    const us = (v: unknown): Us[] | undefined =>
      Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : undefined
    const beats = isObj(data) ? us(data.beats) : undefined
    const downbeats = isObj(data) ? us(data.downbeats) : undefined
    const sec = isObj(data) && isObj(data.section) ? data.section : undefined
    const start = sec ? num(sec.start) : undefined
    const end = sec ? num(sec.end) : undefined
    return {
      asset: asset as unknown as Asset,
      ...(beats?.length ? { beats } : {}),
      ...(downbeats?.length ? { downbeats } : {}),
      ...(start !== undefined && end !== undefined ? { section: { start, end } } : {}),
    }
  },
}

export const httpTrends: TrendsPort = {
  async get(signal) {
    try {
      return parseTrends(await api.request('GET', '/api/trends', signal ? { signal } : {}))
    } catch (err) {
      if (missing(err)) return undefined
      throw err
    }
  },
}
