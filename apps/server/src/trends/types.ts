/** Shared types of the trend engine. */

/** What a signal describes; drives how it is matched and what the generator does with it. */
export type SignalKind =
  | 'topic' // a subject people search/watch right now ("oklahoma state basketball")
  | 'hashtag' // "#photodump"
  | 'sound' // a song/sound that is trending (meta: artist, bpm, genre)
  | 'format' // an edit format ("pov", "photo dump", "grwm")
  | 'aesthetic' // a look / colour word ("y2k", "pastel", "neon")
  | 'caption' // a caption-style cue ("lowercase", "word by word", "karaoke")

export interface TrendSignal {
  kind: SignalKind
  /** Normalised lower-case text ("photo dump", "#fyp" → "fyp"). */
  text: string
  /** 0..1 strength within its source (rank-based). */
  weight: number
  /** Source ids that reported it (filled by aggregation). */
  sources: string[]
  meta?: { artist?: string; bpm?: number; genre?: string }
}

/** Raw observation from one source before extraction. */
export interface SourceItem {
  /** Title / name (a search term, a video title, a post title, a song). */
  title: string
  /** Extra text that may contain hashtags or format words (description, snippet). */
  text?: string
  /** 0..1 rank strength (1 = top of the chart). */
  weight: number
  kind: 'topic' | 'video' | 'post' | 'sound'
  meta?: { artist?: string; bpm?: number; genre?: string; tags?: string[] }
}

export interface SourceContext {
  /** Polite, cached GET (see http.ts). `cacheKey` keeps secrets out of cache files. */
  get(
    url: string,
    opts?: { headers?: Record<string, string>; ttlMs?: number; cacheKey?: string },
  ): Promise<string>
  /** Raw fetch for the rare non-GET call (OAuth token requests). */
  fetch: typeof fetch
  signal: AbortSignal
  now: Date
  region: string
  /** Optional credentials from config (never logged). */
  keys: {
    youtube?: string | undefined
    redditId?: string | undefined
    redditSecret?: string | undefined
  }
}

/** A pluggable signal source. */
export interface TrendSource {
  id: string
  name: string
  /** Why it is off (missing key…), or undefined when usable. */
  disabledReason(ctx: Pick<SourceContext, 'keys'>): string | undefined
  fetch(ctx: SourceContext): Promise<SourceItem[]>
}

export interface SourceStatus {
  id: string
  name: string
  state: 'ok' | 'error' | 'disabled'
  items: number
  ms?: number
  error?: string
  checkedAt?: string
}
