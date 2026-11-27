/**
 * Trending sounds for the editor: a musical profile per chart sound (tempo, genre, mood,
 * energy) that the music library ranks royalty-free tracks against, and — only when the
 * host opts in (TRENDS_SOUND_PREVIEW=1) — Deezer's official 30 s `preview` clip of a sound
 * so the owner can hear the reel with the real sound before posting.
 *
 * Preview audio is only ever streamed through to the editor for playback: it is never
 * written to disk, never becomes a project asset and never reaches an export. Apple's
 * iTunes Search API previews are deliberately not used (Apple's terms forbid previews
 * "synchronized with video"). See music/README.md ("Trending sounds") for the terms review.
 */
import type { MusicMood, TrendSoundProfile } from '@reelforge/core'

/** One sound as listed by `GET /api/trends`. */
export interface TrendSound {
  title: string
  artist?: string | undefined
  bpm: number
  measured: boolean
  weight: number
  genre?: string | undefined
}

interface GenreFeel {
  re: RegExp
  mood: MusicMood
  energy: number
}

/** Typical feel of a chart genre (first match wins; pop last because it is the catch-all). */
const GENRE_FEEL: readonly GenreFeel[] = [
  { re: /hip.?hop|rap|trap|drill/i, mood: 'energetic', energy: 0.75 },
  { re: /dance|electronic|edm|house|techno/i, mood: 'energetic', energy: 0.85 },
  { re: /reggaeton|latin|afro/i, mood: 'upbeat', energy: 0.75 },
  { re: /rock|metal|punk/i, mood: 'energetic', energy: 0.8 },
  { re: /k-?pop/i, mood: 'upbeat', energy: 0.75 },
  { re: /r&b|soul/i, mood: 'romantic', energy: 0.5 },
  { re: /alternative|indie/i, mood: 'inspiring', energy: 0.6 },
  { re: /country/i, mood: 'upbeat', energy: 0.6 },
  { re: /singer|songwriter|folk|acoustic/i, mood: 'emotional', energy: 0.4 },
  { re: /holiday|christmas/i, mood: 'upbeat', energy: 0.6 },
  { re: /jazz|blues/i, mood: 'chill', energy: 0.4 },
  { re: /soundtrack|classical|ambient|score/i, mood: 'cinematic', energy: 0.45 },
  { re: /lo-?fi/i, mood: 'lofi', energy: 0.3 },
  { re: /pop/i, mood: 'upbeat', energy: 0.65 },
]

/** Tempo-based fallback when the genre says nothing. */
const tempoFeel = (bpm: number): { mood: MusicMood; energy: number } =>
  bpm >= 125
    ? { mood: 'energetic', energy: 0.8 }
    : bpm >= 100
      ? { mood: 'upbeat', energy: 0.65 }
      : bpm >= 85
        ? { mood: 'inspiring', energy: 0.5 }
        : { mood: 'chill', energy: 0.35 }

/** Mood and energy of a sound from its genre (else its tempo). */
export const soundFeel = (
  s: Pick<TrendSound, 'bpm' | 'genre'>,
): { mood: MusicMood; energy: number } => {
  const g = s.genre ? GENRE_FEEL.find((f) => f.re.test(s.genre!)) : undefined
  if (g) {
    // Fast songs of a calm genre still feel livelier (and vice versa).
    const nudge = s.bpm >= 128 ? 0.1 : s.bpm <= 80 ? -0.1 : 0
    return { mood: g.mood, energy: Math.min(1, Math.max(0, g.energy + nudge)) }
  }
  return tempoFeel(s.bpm)
}

/** The profile the music library ranks against. */
export const soundProfile = (s: TrendSound): TrendSoundProfile => {
  const feel = soundFeel(s)
  return {
    title: s.title.slice(0, 300),
    ...(s.artist ? { artist: s.artist.slice(0, 300) } : {}),
    ...(s.bpm > 0 ? { bpm: s.bpm } : {}),
    ...(s.genre ? { genre: s.genre.slice(0, 60) } : {}),
    mood: feel.mood,
    energy: feel.energy,
    weight: Math.min(1, Math.max(0, s.weight)),
  }
}

/* ------------------------------------------------------------------ official previews */

export interface SoundPreview {
  /** Direct URL of the 30 s clip on the provider's CDN (short-lived for Deezer). */
  url: string
  source: 'deezer'
  /** Seconds (Deezer serves 30 s clips). */
  duration: number
  /** Track page on the provider (attribution / "listen on"). */
  link?: string | undefined
}

/** CDN hosts preview audio may be proxied from (anything else is refused). */
const PREVIEW_HOSTS = [/\.dzcdn\.net$/i]

export const isPreviewHost = (url: string): boolean => {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && PREVIEW_HOSTS.some((re) => re.test(u.hostname))
  } catch {
    return false
  }
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** Loose title/artist check so a search never returns an unrelated song's preview. */
export const sameSong = (
  want: { title: string; artist?: string | undefined },
  got: { title: string; artist?: string | undefined },
): boolean => {
  const wt = norm(want.title)
  const gt = norm(got.title)
  if (!wt || !gt || !(gt.includes(wt) || wt.includes(gt))) return false
  if (!want.artist || !got.artist) return true
  const wa = norm(want.artist).split(' ')[0] ?? ''
  return norm(got.artist).includes(wa)
}

type Fetch = typeof fetch

interface DeezerSearch {
  data?: Array<{ title: string; preview?: string; link?: string; artist?: { name: string } }>
}

/** Resolves sound → official preview (memoised for 10 minutes: Deezer URLs expire). */
export class SoundPreviews {
  readonly #fetch: Fetch
  readonly #ua: string
  readonly #now: () => number
  readonly #cache = new Map<string, { at: number; value: SoundPreview | undefined }>()

  constructor(opts: { fetch?: Fetch; userAgent: string; now?: () => number }) {
    this.#fetch = opts.fetch ?? fetch
    this.#ua = opts.userAgent
    this.#now = opts.now ?? Date.now
  }

  async #json<T>(url: string, signal?: AbortSignal): Promise<T | undefined> {
    try {
      const res = await this.#fetch(url, {
        headers: { 'user-agent': this.#ua, accept: 'application/json' },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
          : AbortSignal.timeout(8000),
      })
      return res.ok ? ((await res.json()) as T) : undefined
    } catch (err) {
      if (signal?.aborted) throw err
      return undefined
    }
  }

  async resolve(
    sound: { title: string; artist?: string | undefined },
    signal?: AbortSignal,
  ): Promise<SoundPreview | undefined> {
    const key = `${norm(sound.title)}|${norm(sound.artist ?? '')}`
    const hit = this.#cache.get(key)
    if (hit && this.#now() - hit.at < 10 * 60_000) return hit.value
    const value = await this.#deezer(sound, signal)
    this.#cache.set(key, { at: this.#now(), value })
    if (this.#cache.size > 200) this.#cache.delete(this.#cache.keys().next().value!)
    return value
  }

  async #deezer(
    s: { title: string; artist?: string | undefined },
    signal?: AbortSignal,
  ): Promise<SoundPreview | undefined> {
    const q = s.artist ? `artist:"${s.artist}" track:"${s.title}"` : s.title
    const r = await this.#json<DeezerSearch>(
      `https://api.deezer.com/search?limit=5&q=${encodeURIComponent(q)}`,
      signal,
    )
    const hit = r?.data?.find(
      (t) =>
        t.preview &&
        isPreviewHost(t.preview) &&
        sameSong(s, { title: t.title, artist: t.artist?.name }),
    )
    return hit?.preview
      ? { url: hit.preview, source: 'deezer', duration: 30, link: hit.link }
      : undefined
  }

  /** Opens the preview audio for streaming (no caching, no disk). */
  async open(preview: SoundPreview, signal?: AbortSignal): Promise<Response> {
    if (!isPreviewHost(preview.url)) throw new Error('preview host not allowed')
    const res = await this.#fetch(preview.url, {
      headers: { 'user-agent': this.#ua },
      redirect: 'follow',
      ...(signal ? { signal } : {}),
    })
    if (!res.ok || !res.body) throw new Error(`preview unavailable (${res.status})`)
    if (res.url && !isPreviewHost(res.url)) throw new Error('preview redirected off the CDN')
    return res
  }
}
