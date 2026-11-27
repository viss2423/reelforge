/** Shared fixtures for trend engine tests: recorded source responses, fake LLM, packs. */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PackManifest } from '@reelforge/core'
import { REPO_ROOT } from '../../src/config.ts'
import type { LlmPort } from '../../src/trends/llm-port.ts'
import { loadPackTree } from '../../src/packs/service.ts'
import type { SourceContext } from '../../src/trends/types.ts'

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
export const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8')
export const BUNDLED = path.join(REPO_ROOT, 'packs')

export const bundledPacks = async () => {
  const tree = await loadPackTree(BUNDLED)
  if (!tree) throw new Error('bundled packs missing')
  return tree
}

/** URL → recorded body. Unknown URLs fail like a 404. */
export const FIXTURE_URLS: Array<[RegExp, string]> = [
  [/trends\.google\.com\/trending\/rss/, 'google-trends-us.xml'],
  [/wikimedia\.org\/api\/rest_v1\/metrics\/pageviews\/top/, 'wikipedia-top.json'],
  [/rss\.marketingtools\.apple\.com/, 'apple-music.json'],
  [/api\.deezer\.com\/chart/, 'deezer-chart.json'],
  [/api\.deezer\.com\/track\/142706538/, 'deezer-track-142706538.json'],
  [/api\.deezer\.com\/track\/3818963601/, 'deezer-track-3818963601.json'],
  [/googleapis\.com\/youtube\/v3\/videos/, 'youtube-most-popular.json'],
  [/oauth\.reddit\.com\/r\//, 'reddit-top.json'],
]

/** A `fetch` that serves the recorded fixtures (and a reddit token). */
export const fixtureFetch = (calls: string[] = []): typeof fetch =>
  (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push(url)
    if (url.includes('reddit.com/api/v1/access_token'))
      return Response.json({ access_token: 'tok', token_type: 'bearer' })
    const hit = FIXTURE_URLS.find(([re]) => re.test(url))
    if (!hit) return new Response('not found', { status: 404 })
    return new Response(fixture(hit[1]), { status: 200 })
  }) as typeof fetch

/** SourceContext over fixtures (no network, no cache). */
export const fixtureCtx = (over: Partial<SourceContext> = {}): SourceContext => {
  const f = fixtureFetch()
  return {
    get: async (url) => {
      const res = await f(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.text()
    },
    fetch: f,
    signal: new AbortController().signal,
    now: new Date('2026-11-20T12:00:00Z'),
    region: 'US',
    keys: {},
    ...over,
  }
}

/**
 * Fake LLM: answers each prompt kind with canned JSON. `bad` mixes in invalid items to prove
 * they are filtered.
 */
export const fakeLlm = (
  opts: { available?: boolean; bad?: boolean; calls?: string[] } = {},
): LlmPort => ({
  available: async () => opts.available ?? true,
  complete: async (req) => {
    opts.calls?.push(req.prompt.split('\n').at(-1) ?? '')
    const p = req.prompt
    let items: unknown[] = []
    if (p.includes('caption styles'))
      items = [
        {
          name: 'Frosted Karaoke',
          tags: ['winter', 'karaoke'],
          font: 'poppins',
          weight: 850,
          uppercase: false,
          mode: 'karaoke',
          color: '#FFFFFF',
          activeColor: '#9BE7FF',
          keywordColor: '#FFD166',
          strokeWidth: 7,
          wordsPerLine: 3,
          position: 'lower',
        },
        ...(opts.bad ? [{ name: 'x', mode: 'nope' }] : []),
      ]
    else if (p.includes('hook text presets'))
      items = [
        {
          name: 'Cozy POV Hook',
          tags: ['pov', 'cozy'],
          sampleText: 'POV: the first snow day',
          font: 'Montserrat',
          weight: 900,
          size: 80,
          color: '#FFFFFF',
          strokeColor: '#000000',
          strokeWidth: 8,
          uppercase: false,
          animationIn: 'trending-2026-11/punch-in',
          animationOut: 'essentials/fade-out',
        },
        {
          name: 'Unknown Font Hook',
          tags: ['storytime'],
          sampleText: 'storytime: it went wrong',
          font: 'Comic Sans MS',
          weight: 700,
          size: 70,
          color: '#FFE400',
          strokeColor: '#000000',
          strokeWidth: 6,
          uppercase: true,
          animationIn: 'nope/nothing',
          animationOut: 'essentials/fade-out',
        },
      ]
    else if (p.includes('reel templates'))
      items = [
        {
          name: 'Snow Day Dump',
          description: 'Photo dump of a snowy day cut on every beat.',
          tags: ['photo-dump', 'winter'],
          sound: 'Dracula',
          bpm: 110,
          trend: 'photo dump',
          filter: 'trending-2026-11/winter-frost',
          captionStyle: 'trending-live/frosted-karaoke',
          hookText: 'snow day photo dump',
          hookPreset: 'trending-live/cozy-pov-hook',
          slots: [
            { beats: 4, kind: 'image', transition: 'cut' },
            { beats: 2, kind: 'image', transition: 'whip', effect: 'trending-2026-11/beat-punch' },
            { beats: 2, kind: 'image', transition: 'flash' },
            { beats: 2, kind: 'image', transition: 'whip' },
            { beats: 4, kind: 'video', transition: 'dissolve' },
          ],
        },
        // Valid spec whose compiled template is too short (validation drops it).
        {
          name: 'Way Too Short',
          description: 'two beats total',
          tags: [],
          bpm: 180,
          hookText: 'hi',
          hookPreset: 'essentials/title-bold',
          slots: [
            { beats: 1, transition: 'cut' },
            { beats: 1, transition: 'cut' },
          ],
        },
      ]
    else if (p.includes('Suggest 20 hashtags'))
      items = ['winterphotodump', 'cozyseason', '#Snow Day!']
    else if (p.includes('reel idea'))
      items = [
        {
          topic: 'oklahoma state basketball',
          title: 'Game night recap',
          hooks: ['POV: you were in the arena', 'Nobody saw this coming', 'Wait for the last shot'],
          shots: ['Crowd wide shot', 'Scoreboard close-up', 'Celebration'],
          caption: 'What a night 🏀',
          hashtags: ['#gameday', 'hoops'],
          template: 'essentials/countdown-list',
        },
      ]
    const json = { items }
    return { text: JSON.stringify(json), json, tokensPerSecond: 42 }
  },
})

export const findItem = (m: PackManifest, id: string) =>
  [
    ...m.templates,
    ...m.textPresets,
    ...m.captionStyles,
    ...m.filters,
    ...m.effects,
    ...m.animations,
    ...m.transitions,
    ...m.stickers,
  ].find((i) => i.id === id)
