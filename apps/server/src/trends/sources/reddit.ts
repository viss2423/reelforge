/**
 * Reddit creator communities (top posts of the day). Reddit blocks anonymous JSON/RSS
 * access (HTTP 403/429 as of late 2026), so this uses the official Data API with an app-only
 * OAuth token: create a free "script" app at reddit.com/prefs/apps and set
 * REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET (free tier 100 requests/min; we make ~6 a day).
 */
import type { SourceItem, TrendSource } from '../types.ts'

export const SUBREDDITS = [
  'NewTubers',
  'TikTokCreators',
  'InstagramMarketing',
  'VideoEditing',
  'socialmedia',
]

interface Listing {
  data?: { children?: Array<{ data?: { title?: string; selftext?: string; score?: number } }> }
}

export const parseRedditListing = (json: string): SourceItem[] => {
  const posts = ((JSON.parse(json) as Listing).data?.children ?? []).flatMap((c) =>
    c.data?.title ? [c.data] : [],
  )
  const max = Math.max(1, ...posts.map((p) => p.score ?? 0))
  return posts.map((p) => ({
    kind: 'post' as const,
    title: p.title ?? '',
    text: (p.selftext ?? '').slice(0, 400),
    weight: Math.max(0.05, Math.log10(1 + Math.max(0, p.score ?? 0)) / Math.log10(1 + max)),
  }))
}

export const reddit: TrendSource = {
  id: 'reddit',
  name: 'Reddit creator communities',
  disabledReason: (ctx) =>
    ctx.keys.redditId && ctx.keys.redditSecret
      ? undefined
      : 'Set REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET (free) to enable',
  async fetch(ctx) {
    const { redditId, redditSecret } = ctx.keys
    if (!redditId || !redditSecret) return []
    const res = await ctx.fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${redditId}:${redditSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'ReelForge trend engine (self-hosted)',
      },
      body: 'grant_type=client_credentials',
      signal: ctx.signal,
    })
    if (!res.ok) throw new Error(`reddit token: HTTP ${res.status}`)
    const token = ((await res.json()) as { access_token?: string }).access_token
    if (!token) throw new Error('reddit token: none returned')
    const out: SourceItem[] = []
    for (const sub of SUBREDDITS) {
      // oxlint-disable-next-line no-await-in-loop
      const json = await ctx.get(
        `https://oauth.reddit.com/r/${sub}/top?t=day&limit=25&raw_json=1`,
        {
          ttlMs: 12 * 3_600_000,
          headers: { authorization: `Bearer ${token}` },
        },
      )
      out.push(...parseRedditListing(json))
    }
    return out
  },
}
