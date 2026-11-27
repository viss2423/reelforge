/**
 * Wikimedia pageviews API: yesterday's most-read English Wikipedia articles, an openly
 * licensed proxy for what people are paying attention to (films, games, people, events).
 * Free, no key; Wikimedia asks for a descriptive User-Agent, which we send.
 */
import type { SourceItem, TrendSource } from '../types.ts'

/** Pages that are always on top and say nothing about trends. */
const NOISE =
  /^(Main_Page|Special:|Wikipedia:|Portal:|File:|Help:|Talk:|Category:|Template:|User:|Deaths_in_|List_of_)/i

export const parseWikipediaTop = (json: string, limit = 40): SourceItem[] => {
  const data = JSON.parse(json) as {
    items?: Array<{ articles?: Array<{ article: string; views: number }> }>
  }
  const top = (data.items?.[0]?.articles ?? [])
    .filter((a) => !NOISE.test(a.article))
    .slice(0, limit)
  return top.map((a, i) => ({
    kind: 'topic' as const,
    title: a.article.replaceAll('_', ' ').toLowerCase(),
    weight: 1 - i / Math.max(1, top.length),
  }))
}

const ymd = (d: Date): string =>
  `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`

export const wikipedia: TrendSource = {
  id: 'wikipedia',
  name: 'Wikipedia most read',
  disabledReason: () => undefined,
  async fetch(ctx) {
    // Yesterday's (UTC) list lands a few hours after midnight; fall back one more day.
    let lastErr: unknown
    for (const back of [1, 2]) {
      const day = new Date(ctx.now.getTime() - back * 86_400_000)
      try {
        const json = await ctx.get(
          `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${ymd(day)}`,
          { ttlMs: 24 * 3_600_000 },
        )
        return parseWikipediaTop(json)
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('wikipedia unavailable')
  },
}
