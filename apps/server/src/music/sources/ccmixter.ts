/**
 * ccMixter (ArtisTech Media) — Creative Commons remixes and instrumentals, many tagged with
 * BPM. Public query API, no key: https://ccmixter.org/query-api. Only CC BY uploads are
 * requested (`lic=by`) and the licence URL of every result is re-checked.
 */
import { z } from 'zod'
import { creditLine, licenceFromUrl } from '../licence.ts'
import { type FetchLike, getJson, RateGate } from '../net.ts'
import type { MusicSource, SourceQuery, SourceTrack } from '../types.ts'

const API = 'https://ccmixter.org/api/query'

const File = z.object({
  download_url: z.string().nullish(),
  file_name: z.string().nullish(),
  file_format_info: z
    .object({
      'media-type': z.string().nullish(),
      'default-ext': z.string().nullish(),
      ps: z.string().nullish(),
    })
    .partial()
    .nullish(),
})
const Upload = z.object({
  upload_id: z.union([z.number(), z.string()]),
  upload_name: z.string().nullish(),
  user_name: z.string().nullish(),
  user_real_name: z.string().nullish(),
  file_page_url: z.string().nullish(),
  license_url: z.string().nullish(),
  upload_tags: z.string().nullish(),
  upload_extra: z
    .object({ bpm: z.union([z.number(), z.string()]).nullish(), usertags: z.string().nullish() })
    .partial()
    .nullish(),
  files: z.array(File).default([]),
})

/** "2:45" / "1:02:03" → microseconds. */
export const parsePlaytime = (ps: string | null | undefined): number | undefined => {
  if (!ps) return undefined
  const parts = ps.trim().split(':').map(Number)
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n) || n < 0)) return undefined
  return Math.round(parts.reduce((acc, n) => acc * 60 + n, 0) * 1_000_000)
}

const GENERIC_TAGS = new Set([
  'media',
  'remix',
  'trackback',
  'audio',
  'mp3',
  'stereo',
  'vbr',
  'cbr',
  'attribution',
  'ccplus',
  '44k',
  '48k',
  'in_video',
  'in_podcast',
  'in_web',
  'in_remix',
  'in_album',
  'editorial_pick',
  'sample',
  'acappella',
])

export const mapCcmixter = (raw: unknown): SourceTrack | undefined => {
  const r = Upload.safeParse(raw)
  if (!r.success) return undefined
  const u = r.data
  const licence = licenceFromUrl(u.license_url ?? undefined)
  if (!licence) return undefined
  const file = u.files.find(
    (f) =>
      f.download_url &&
      f.file_format_info?.['media-type'] === 'audio' &&
      f.file_format_info['default-ext'] === 'mp3',
  )
  if (!file?.download_url) return undefined
  const duration = parsePlaytime(file.file_format_info?.ps)
  if (!duration || duration < 15_000_000) return undefined
  const tags = [
    ...new Set(
      (u.upload_tags ?? '')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t && !GENERIC_TAGS.has(t) && !t.startsWith('bpm_')),
    ),
  ]
  const bpm = Number(u.upload_extra?.bpm)
  const title = u.upload_name?.trim() || 'Untitled'
  const artist = u.user_real_name?.trim() || u.user_name?.trim() || ''
  const pageUrl = u.file_page_url ?? undefined
  return {
    id: `ccmixter:${u.upload_id}`,
    source: 'ccmixter',
    title,
    artist,
    licence,
    ...(licence.attributionRequired
      ? { attribution: creditLine({ title, artist, pageUrl, licence }) }
      : {}),
    ...(pageUrl ? { pageUrl } : {}),
    duration,
    ...(Number.isFinite(bpm) && bpm >= 40 && bpm <= 250 ? { bpm } : {}),
    tags,
    genres: [],
    ...(tags.includes('instrumental') ? { instrumental: true } : {}),
    cached: false,
    analyzed: false,
    audioUrl: file.download_url,
  }
}

export class CcmixterSource implements MusicSource {
  readonly id = 'ccmixter'
  readonly name = 'ccMixter'
  readonly homepage = 'https://ccmixter.org'
  readonly #fetch: FetchLike
  readonly #gate: RateGate

  constructor(opts: { fetch?: FetchLike; gate?: RateGate } = {}) {
    this.#fetch = opts.fetch ?? fetch
    this.#gate = opts.gate ?? new RateGate(1_000)
  }

  unavailable(): string | undefined {
    return this.#gate.coolingMs > 0 ? 'rate limited' : undefined
  }

  async search(q: SourceQuery, signal?: AbortSignal): Promise<SourceTrack[]> {
    const params = new URLSearchParams({
      f: 'json',
      lic: 'by',
      sort: 'rank',
      limit: String(Math.min(30, Math.max(1, q.limit))),
    })
    if (q.instrumental) params.set('tags', 'instrumental')
    if (q.terms) {
      params.set('search', q.terms)
      params.set('search_type', 'any')
    }
    const body = await getJson(
      this.#fetch,
      this.#gate,
      `${API}?${params.toString()}`,
      signal ? { signal } : {},
    )
    if (!Array.isArray(body)) return []
    return body.map(mapCcmixter).filter((t): t is SourceTrack => t !== undefined)
  }
}
