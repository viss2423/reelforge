/**
 * Openverse (WordPress Foundation) — openly licensed audio aggregated from Jamendo,
 * Freesound, ccMixter and Wikimedia. Documented public API, no key needed:
 * https://api.openverse.org/v1/ (anonymous limits: 20 requests/min, 200/day — searches are
 * cached for a day by the library, and requests are spaced 4 s apart).
 *
 * Only CC0, Public Domain Mark and CC BY results are requested (`license=cc0,pdm,by`).
 */
import { z } from 'zod'
import { creditLine, licenceFromCode } from '../licence.ts'
import { type FetchLike, getJson, RateGate } from '../net.ts'
import type { MusicSource, SourceQuery, SourceTrack } from '../types.ts'

const API = 'https://api.openverse.org/v1/audio/'

const Result = z.object({
  id: z.string(),
  title: z.string().nullish(),
  url: z.string().nullish(),
  foreign_landing_url: z.string().nullish(),
  creator: z.string().nullish(),
  license: z.string(),
  license_version: z.string().nullish(),
  license_url: z.string().nullish(),
  provider: z.string().nullish(),
  category: z.string().nullish(),
  genres: z.array(z.string()).nullish(),
  tags: z.array(z.object({ name: z.string() })).nullish(),
  attribution: z.string().nullish(),
  duration: z.number().nullish(),
  mature: z.boolean().nullish(),
})
const Response = z.object({ results: z.array(z.unknown()) })

/** Shortest track worth offering as a reel bed. */
const MIN_DURATION_MS = 15_000

export const mapOpenverse = (raw: unknown): SourceTrack | undefined => {
  const r = Result.safeParse(raw)
  if (!r.success) return undefined
  const v = r.data
  if (!v.url || (v.category && v.category !== 'music') || v.mature) return undefined
  if (!v.duration || v.duration < MIN_DURATION_MS) return undefined
  const licence = licenceFromCode(
    v.license,
    v.license_version ?? undefined,
    v.license_url ?? undefined,
  )
  if (!licence) return undefined
  const tags = (v.tags ?? []).map((t) => t.name.toLowerCase())
  const title = v.title?.trim() || 'Untitled'
  const artist = v.creator?.trim() ?? ''
  const pageUrl = v.foreign_landing_url ?? undefined
  return {
    id: `openverse:${v.id}`,
    source: 'openverse',
    ...(v.provider ? { provider: v.provider } : {}),
    title,
    artist,
    licence,
    ...(licence.attributionRequired
      ? { attribution: creditLine({ title, artist, pageUrl, licence }) }
      : {}),
    ...(pageUrl ? { pageUrl } : {}),
    duration: Math.round(v.duration * 1000),
    tags,
    genres: (v.genres ?? []).map((g) => g.toLowerCase()),
    ...(tags.includes('instrumental') || /instrumental/i.test(title) ? { instrumental: true } : {}),
    cached: false,
    analyzed: false,
    audioUrl: v.url,
  }
}

export class OpenverseSource implements MusicSource {
  readonly id = 'openverse'
  readonly name = 'Openverse'
  readonly homepage = 'https://openverse.org'
  readonly #fetch: FetchLike
  readonly #gate: RateGate

  constructor(opts: { fetch?: FetchLike; gate?: RateGate } = {}) {
    this.#fetch = opts.fetch ?? fetch
    this.#gate = opts.gate ?? new RateGate(4_000)
  }

  unavailable(): string | undefined {
    const ms = this.#gate.coolingMs
    return ms > 0 ? `rate limited, retry in ${Math.ceil(ms / 60_000)} min` : undefined
  }

  async search(q: SourceQuery, signal?: AbortSignal): Promise<SourceTrack[]> {
    const terms = [q.terms, q.instrumental ? 'instrumental' : ''].filter(Boolean).join(' ')
    const params = new URLSearchParams({
      q: terms || 'music',
      license: 'cc0,pdm,by',
      category: 'music',
      page_size: String(Math.min(20, Math.max(1, q.limit))),
      mature: 'false',
    })
    const body = Response.parse(
      await getJson(
        this.#fetch,
        this.#gate,
        `${API}?${params.toString()}`,
        signal ? { signal } : {},
      ),
    )
    return body.results.map(mapOpenverse).filter((t): t is SourceTrack => t !== undefined)
  }
}
