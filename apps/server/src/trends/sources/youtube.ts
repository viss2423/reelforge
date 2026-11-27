/**
 * YouTube Data API v3 "most popular" chart. Needs a free API key (YOUTUBE_API_KEY); one call
 * costs 1 of the 10 000 daily quota units and we make about two a day. Titles, tags and
 * descriptions carry hashtags and edit formats. Disabled without a key.
 */
import type { SourceItem, TrendSource } from '../types.ts'

interface YtList {
  items?: Array<{ snippet?: { title?: string; description?: string; tags?: string[] } }>
}

export const parseYoutube = (json: string): SourceItem[] => {
  const items = ((JSON.parse(json) as YtList).items ?? []).flatMap((v) =>
    v.snippet?.title ? [v.snippet] : [],
  )
  return items.map((s, i) => ({
    kind: 'video' as const,
    title: s.title ?? '',
    text: (s.description ?? '').slice(0, 400),
    weight: 1 - i / Math.max(1, items.length),
    meta: { tags: (s.tags ?? []).slice(0, 15) },
  }))
}

export const youtube: TrendSource = {
  id: 'youtube',
  name: 'YouTube most popular',
  disabledReason: (ctx) => (ctx.keys.youtube ? undefined : 'Set YOUTUBE_API_KEY (free) to enable'),
  async fetch(ctx) {
    const key = ctx.keys.youtube
    if (!key) return []
    const region = encodeURIComponent(ctx.region.toUpperCase())
    const base = `https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&maxResults=50&regionCode=${region}`
    const json = await ctx.get(`${base}&key=${encodeURIComponent(key)}`, {
      ttlMs: 12 * 3_600_000,
      cacheKey: base,
    })
    return parseYoutube(json)
  },
}
