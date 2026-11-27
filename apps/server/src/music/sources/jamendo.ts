/**
 * Jamendo — 600k+ Creative Commons tracks with tempo/mood metadata. Its API needs a free
 * client id (https://devportal.jamendo.com), so the source is optional: set
 * `REELFORGE_JAMENDO_CLIENT_ID`. Without it, Jamendo's catalogue is still reachable through
 * Openverse. Only CC0/CC BY tracks whose download is allowed are kept (NC/ND/SA excluded).
 */
import { z } from 'zod'
import { creditLine, licenceFromUrl } from '../licence.ts'
import { type FetchLike, getJson, RateGate } from '../net.ts'
import type { MusicSource, SourceQuery, SourceTrack } from '../types.ts'

const API = 'https://api.jamendo.com/v3.0/tracks/'

const Track = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string().nullish(),
  duration: z.number().nullish(),
  artist_name: z.string().nullish(),
  license_ccurl: z.string().nullish(),
  audiodownload: z.string().nullish(),
  audiodownload_allowed: z.boolean().nullish(),
  shareurl: z.string().nullish(),
  musicinfo: z
    .object({
      vocalinstrumental: z.string().nullish(),
      speed: z.string().nullish(),
      tags: z
        .object({
          genres: z.array(z.string()).nullish(),
          instruments: z.array(z.string()).nullish(),
          vartags: z.array(z.string()).nullish(),
        })
        .partial()
        .nullish(),
    })
    .partial()
    .nullish(),
})
const Response = z.object({ results: z.array(z.unknown()).default([]) })

export const mapJamendo = (raw: unknown): SourceTrack | undefined => {
  const r = Track.safeParse(raw)
  if (!r.success) return undefined
  const t = r.data
  const licence = licenceFromUrl(t.license_ccurl ?? undefined)
  if (!licence || !t.audiodownload_allowed || !t.audiodownload) return undefined
  if (!t.duration || t.duration < 15) return undefined
  const info = t.musicinfo
  const tags = [
    ...(info?.tags?.vartags ?? []),
    ...(info?.tags?.instruments ?? []),
    ...(info?.speed ? [`speed_${info.speed}`] : []),
  ].map((s) => s.toLowerCase())
  const title = t.name?.trim() || 'Untitled'
  const artist = t.artist_name?.trim() ?? ''
  const pageUrl = t.shareurl ?? undefined
  return {
    id: `jamendo:${t.id}`,
    source: 'jamendo',
    title,
    artist,
    licence,
    ...(licence.attributionRequired
      ? { attribution: creditLine({ title, artist, pageUrl, licence }) }
      : {}),
    ...(pageUrl ? { pageUrl } : {}),
    duration: Math.round(t.duration * 1_000_000),
    tags,
    genres: (info?.tags?.genres ?? []).map((g) => g.toLowerCase()),
    ...(info?.vocalinstrumental ? { instrumental: info.vocalinstrumental === 'instrumental' } : {}),
    cached: false,
    analyzed: false,
    audioUrl: t.audiodownload,
  }
}

export class JamendoSource implements MusicSource {
  readonly id = 'jamendo'
  readonly name = 'Jamendo'
  readonly homepage = 'https://www.jamendo.com'
  readonly #clientId: string | undefined
  readonly #fetch: FetchLike
  readonly #gate: RateGate

  constructor(opts: { clientId?: string | undefined; fetch?: FetchLike; gate?: RateGate } = {}) {
    this.#clientId = opts.clientId
    this.#fetch = opts.fetch ?? fetch
    this.#gate = opts.gate ?? new RateGate(500)
  }

  unavailable(): string | undefined {
    if (!this.#clientId) return 'needs a free client id (REELFORGE_JAMENDO_CLIENT_ID)'
    return this.#gate.coolingMs > 0 ? 'rate limited' : undefined
  }

  async search(q: SourceQuery, signal?: AbortSignal): Promise<SourceTrack[]> {
    if (!this.#clientId) return []
    const params = new URLSearchParams({
      client_id: this.#clientId,
      format: 'json',
      limit: String(Math.min(50, Math.max(1, q.limit))),
      include: 'musicinfo licenses',
      audiodlformat: 'mp32',
      ccnc: 'false',
      ccnd: 'false',
      ccsa: 'false',
      order: 'popularity_total',
    })
    if (q.terms) params.set('search', q.terms)
    if (q.tags.length) params.set('fuzzytags', q.tags.slice(0, 4).join('+'))
    if (q.instrumental) params.set('vocalinstrumental', 'instrumental')
    const body = Response.parse(
      await getJson(
        this.#fetch,
        this.#gate,
        `${API}?${params.toString()}`,
        signal ? { signal } : {},
      ),
    )
    return body.results.map(mapJamendo).filter((t): t is SourceTrack => t !== undefined)
  }
}
