/**
 * Google Trends "Trending now" RSS (`trends.google.com/trending/rss?geo=XX`): the day's
 * fastest-rising searches with approximate traffic and related headlines. Public feed, no
 * key; fetched at most every 3 h.
 */
import type { SourceItem, TrendSource } from '../types.ts'
import { blocks, child } from './xml.ts'

/** "200,000+" → 200000 */
const traffic = (s: string | undefined): number => Number((s ?? '').replace(/[^\d]/g, '')) || 0

export const parseGoogleTrends = (xml: string): SourceItem[] => {
  const items = blocks(xml, 'item')
    .map((item) => ({
      title: child(item, 'title') ?? '',
      traffic: traffic(child(item, 'ht:approx_traffic')),
      news: blocks(item, 'ht:news_item')
        .map((n) => child(n, 'ht:news_item_title') ?? '')
        .filter(Boolean),
    }))
    .filter((i) => i.title)
  const max = Math.max(1, ...items.map((i) => i.traffic))
  return items.map((i, rank) => ({
    kind: 'topic' as const,
    title: i.title.toLowerCase(),
    text: i.news.join(' · '),
    // Log traffic (500+ … 1M+) blended with feed order.
    weight: Math.min(
      1,
      0.5 * (Math.log10(1 + i.traffic) / Math.log10(1 + max)) + 0.5 * (1 - rank / items.length),
    ),
  }))
}

export const googleTrends: TrendSource = {
  id: 'google-trends',
  name: 'Google Trends (daily searches)',
  disabledReason: () => undefined,
  async fetch(ctx) {
    const geo = encodeURIComponent(ctx.region.toUpperCase())
    const xml = await ctx.get(`https://trends.google.com/trending/rss?geo=${geo}`, {
      ttlMs: 3 * 3_600_000,
    })
    return parseGoogleTrends(xml)
  },
}
