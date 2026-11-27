import { describe, expect, it } from 'vitest'
import { appleMusic, parseAppleMusic } from '../../src/trends/sources/apple-music.ts'
import { deezer, saneBpm } from '../../src/trends/sources/deezer.ts'
import { googleTrends, parseGoogleTrends } from '../../src/trends/sources/google-trends.ts'
import { ALL_SOURCES } from '../../src/trends/sources/index.ts'
import { reddit } from '../../src/trends/sources/reddit.ts'
import { parseWikipediaTop, wikipedia } from '../../src/trends/sources/wikipedia.ts'
import { decodeXml } from '../../src/trends/sources/xml.ts'
import { youtube } from '../../src/trends/sources/youtube.ts'
import { fixture, fixtureCtx } from './helpers.ts'

describe('trend sources (recorded fixtures)', () => {
  it('Google Trends RSS: topics with traffic-weighted ranks and headlines', async () => {
    const items = await googleTrends.fetch(fixtureCtx())
    expect(items.length).toBeGreaterThan(5)
    expect(items[0]).toMatchObject({ kind: 'topic', title: 'oklahoma state basketball' })
    expect(items[0]!.text).toContain('Oklahoma State')
    for (const i of items) {
      expect(i.weight).toBeGreaterThan(0)
      expect(i.weight).toBeLessThanOrEqual(1)
      expect(i.title).toBe(i.title.toLowerCase())
    }
    expect(parseGoogleTrends('<rss><channel></channel></rss>')).toEqual([])
  })

  it('decodes XML entities and CDATA', () => {
    expect(decodeXml('Men&apos;s &amp; <![CDATA[a<b]]> &#233;&#x41;')).toBe("Men's & a<b éA")
  })

  it('Wikipedia: drops evergreen/meta pages', async () => {
    const items = await wikipedia.fetch(fixtureCtx())
    const titles = items.map((i) => i.title)
    expect(titles).not.toContain('main page')
    expect(titles.some((t) => t.startsWith('special:'))).toBe(false)
    expect(titles[0]).toBe('grand theft auto vi')
    expect(parseWikipediaTop('{}')).toEqual([])
  })

  it('Apple Music: songs with artist and genre', async () => {
    const items = await appleMusic.fetch(fixtureCtx())
    expect(items[0]).toMatchObject({
      kind: 'sound',
      title: "Choosin' Texas",
      meta: { artist: 'Ella Langley', genre: 'Country' },
    })
    expect(parseAppleMusic('{"feed":{}}')).toEqual([])
  })

  it('Deezer: chart songs, tempo only where Deezer knows it (no audio download)', async () => {
    const urls: string[] = []
    const ctx = fixtureCtx()
    const get = ctx.get.bind(ctx)
    const items = await deezer.fetch({ ...ctx, get: (u, o) => (urls.push(u), get(u, o)) })
    expect(items[0]).toMatchObject({ kind: 'sound', title: 'Dracula (with JENNIE)' })
    expect(items[0]!.meta?.bpm).toBeUndefined() // Deezer reports 0
    const coldplay = items.find((i) => i.title === 'Something Just Like This')
    expect(coldplay?.meta?.bpm).toBe(102.9)
    expect(urls.every((u) => u.startsWith('https://api.deezer.com/'))).toBe(true)
    expect(urls.filter((u) => u.includes('/track/')).length).toBeLessThanOrEqual(10)
    expect([saneBpm(0), saneBpm(300), saneBpm(128)]).toEqual([undefined, undefined, 128])
  })

  it('YouTube and Reddit are disabled without free keys and work with them', async () => {
    expect(youtube.disabledReason({ keys: {} })).toMatch(/YOUTUBE_API_KEY/)
    expect(reddit.disabledReason({ keys: {} })).toMatch(/REDDIT_CLIENT_ID/)
    const yt = await youtube.fetch(fixtureCtx({ keys: { youtube: 'k' } }))
    expect(yt).toHaveLength(3)
    expect(yt[0]!.meta?.tags).toContain('photo dump')
    const rd = await reddit.fetch(fixtureCtx({ keys: { redditId: 'a', redditSecret: 'b' } }))
    // Five subreddits served the same fixture; the untitled post is skipped.
    expect(rd).toHaveLength(15)
    expect(rd[0]!.weight).toBe(1)
  })

  it('the API key never reaches the cache key', async () => {
    const keys: Array<string | undefined> = []
    const ctx = fixtureCtx({ keys: { youtube: 'SECRET' } })
    const get = ctx.get.bind(ctx)
    await youtube.fetch({ ...ctx, get: (u, o) => (keys.push(o?.cacheKey), get(u, o)) })
    expect(keys[0]).toBeDefined()
    expect(keys[0]).not.toContain('SECRET')
  })

  it('every source has a unique id', () => {
    const ids = ALL_SOURCES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(fixture('google-trends-us.xml')).toContain('<rss')
  })
})

describe.skipIf(!process.env.RF_LIVE_TRENDS)('live smoke (RF_LIVE_TRENDS=1)', () => {
  it('keyless sources answer and parse', async () => {
    const signal = AbortSignal.timeout(60_000)
    const ctx = {
      get: async (url: string) => {
        const res = await fetch(url, { headers: { 'user-agent': 'ReelForge test' }, signal })
        if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
        return res.text()
      },
      fetch,
      signal,
      now: new Date(),
      region: 'US',
      keys: {},
    }
    for (const src of [googleTrends, wikipedia, appleMusic, deezer]) {
      const items = await src.fetch(ctx)
      console.warn(`${src.id}: ${items.length} items, e.g. ${items[0]?.title}`)
      expect(items.length).toBeGreaterThan(3)
    }
  })
})
