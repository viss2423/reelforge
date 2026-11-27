/**
 * Apple Music "most played" chart from Apple's public marketing RSS generator
 * (rss.marketingtools.apple.com: JSON, no key, made for embedding). Song names become
 * `sound` signals; genres feed the tempo estimate when no measured BPM exists.
 */
import type { SourceItem, TrendSource } from '../types.ts'

interface AppleFeed {
  feed?: {
    results?: Array<{ name: string; artistName: string; genres?: Array<{ name: string }> }>
  }
}

export const parseAppleMusic = (json: string): SourceItem[] => {
  const results = (JSON.parse(json) as AppleFeed).feed?.results ?? []
  return results.map((r, i) => {
    const genre = r.genres?.map((g) => g.name).find((g) => g !== 'Music')
    return {
      kind: 'sound' as const,
      title: r.name,
      weight: 1 - i / Math.max(1, results.length),
      meta: { artist: r.artistName, ...(genre ? { genre } : {}) },
    }
  })
}

export const appleMusic: TrendSource = {
  id: 'apple-music',
  name: 'Apple Music most played',
  disabledReason: () => undefined,
  async fetch(ctx) {
    const cc = encodeURIComponent(ctx.region.toLowerCase())
    const json = await ctx.get(
      `https://rss.marketingtools.apple.com/api/v2/${cc}/music/most-played/25/songs.json`,
      { ttlMs: 12 * 3_600_000 },
    )
    return parseAppleMusic(json)
  },
}
