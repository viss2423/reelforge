/** Source adapters against recorded API responses (no network). */
import { describe, expect, it } from 'vitest'
import { creditLine, licenceFromCode, licenceFromUrl } from '../../src/music/licence.ts'
import {
  assertPublicHttps,
  getJson,
  RateGate,
  SourceUnavailableError,
} from '../../src/music/net.ts'
import { CcmixterSource, mapCcmixter, parsePlaytime } from '../../src/music/sources/ccmixter.ts'
import { JamendoSource } from '../../src/music/sources/jamendo.ts'
import { mapOpenverse, OpenverseSource } from '../../src/music/sources/openverse.ts'
import { fixture, scriptedFetch } from './helpers.ts'

const query = { terms: 'upbeat happy', tags: ['upbeat'], limit: 10 }

describe('licence policy', () => {
  it('accepts CC0, PD mark and CC BY; rejects NC, ND and SA', () => {
    expect(licenceFromUrl('http://creativecommons.org/publicdomain/zero/1.0/')).toMatchObject({
      code: 'cc0',
      attributionRequired: false,
    })
    expect(licenceFromUrl('https://creativecommons.org/publicdomain/mark/1.0/')).toMatchObject({
      code: 'pdm',
    })
    expect(licenceFromUrl('http://creativecommons.org/licenses/by/3.0/')).toEqual({
      code: 'by',
      name: 'CC BY 3.0',
      url: 'https://creativecommons.org/licenses/by/3.0/',
      attributionRequired: true,
    })
    for (const bad of ['by-nc', 'by-sa', 'by-nd', 'by-nc-sa', 'by-nc-nd'])
      expect(licenceFromUrl(`https://creativecommons.org/licenses/${bad}/4.0/`)).toBeUndefined()
    expect(licenceFromUrl('https://example.org/my-licence')).toBeUndefined()
    expect(licenceFromCode('sampling+')).toBeUndefined()
    expect(licenceFromCode('by')!.url).toBe('https://creativecommons.org/licenses/by/4.0/')
  })

  it('formats TASL credit lines', () => {
    const licence = licenceFromCode('by', '4.0')!
    expect(creditLine({ title: 'A', artist: 'B', pageUrl: 'https://x.org/1', licence })).toBe(
      '"A" by B (https://x.org/1) · CC BY 4.0',
    )
  })
})

describe('OpenverseSource', () => {
  it('maps the recorded search response', async () => {
    const f = scriptedFetch({ 'https://api.openverse.org/v1/audio/': fixture('openverse-search') })
    const src = new OpenverseSource({ fetch: f.fetch, gate: new RateGate(0) })
    const tracks = await src.search(query)
    expect(tracks.length).toBe(5)
    const t = tracks[0]!
    expect(t).toMatchObject({
      source: 'openverse',
      provider: 'jamendo',
      title: 'Think About You',
      licence: { code: 'by', attributionRequired: true },
      duration: 176_000_000,
    })
    expect(t.id).toMatch(/^openverse:[0-9a-f-]{36}$/)
    expect(t.audioUrl).toMatch(/^https:\/\/prod-1\.storage\.jamendo\.com\//)
    expect(t.attribution).toContain('Think About You')
    expect(tracks.find((x) => x.title.includes('Instrumental'))!.instrumental).toBe(true)
    const url = new URL(f.calls[0]!)
    expect(url.searchParams.get('license')).toBe('cc0,pdm,by')
    expect(url.searchParams.get('category')).toBe('music')
    expect(url.searchParams.get('q')).toBe('upbeat happy')
  })

  it('drops non-music, short, mature and unacceptable licences', () => {
    const base = {
      id: 'x',
      title: 'T',
      url: 'https://a.org/x.mp3',
      license: 'by',
      duration: 60_000,
    }
    expect(mapOpenverse(base)).toBeDefined()
    expect(mapOpenverse({ ...base, license: 'by-nc' })).toBeUndefined()
    expect(mapOpenverse({ ...base, duration: 5_000 })).toBeUndefined()
    expect(mapOpenverse({ ...base, category: 'sound_effect' })).toBeUndefined()
    expect(mapOpenverse({ ...base, mature: true })).toBeUndefined()
    expect(mapOpenverse({ ...base, url: null })).toBeUndefined()
    expect(mapOpenverse({ ...base, license: 'cc0' })!.attribution).toBeUndefined()
  })

  it('backs off after HTTP 429 using Retry-After', async () => {
    let now = 0
    const gate = new RateGate(0, () => now)
    const f = scriptedFetch({
      'https://api.openverse.org/': () =>
        new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }),
    })
    const src = new OpenverseSource({ fetch: f.fetch, gate })
    await expect(src.search(query)).rejects.toBeInstanceOf(SourceUnavailableError)
    expect(src.unavailable()).toMatch(/rate limited/)
    await expect(src.search(query)).rejects.toThrow(/rate limited/)
    expect(f.calls).toHaveLength(1) // the second search never hit the network
    now += 121_000
    expect(src.unavailable()).toBeUndefined()
  })
})

describe('CcmixterSource', () => {
  it('maps the recorded query response with BPM and mp3 files only', async () => {
    const f = scriptedFetch({ 'https://ccmixter.org/api/query': fixture('ccmixter-query') })
    const tracks = await new CcmixterSource({ fetch: f.fetch, gate: new RateGate(0) }).search({
      ...query,
      instrumental: true,
    })
    expect(tracks.length).toBeGreaterThanOrEqual(3)
    for (const t of tracks) {
      expect(t.licence.code).toBe('by')
      expect(t.audioUrl).toMatch(/^https:\/\/ccmixter\.org\/content\/.+\.mp3$/)
      expect(t.attribution).toMatch(/ccmixter\.org/)
      expect(t.tags).not.toContain('mp3')
    }
    expect(tracks.some((t) => t.bpm !== undefined)).toBe(true)
    const url = new URL(f.calls[0]!)
    expect(url.searchParams.get('lic')).toBe('by')
    expect(url.searchParams.get('tags')).toBe('instrumental')
    expect(url.searchParams.get('f')).toBe('json')
  })

  it('parses play times and rejects non-BY uploads', () => {
    expect(parsePlaytime('2:45')).toBe(165_000_000)
    expect(parsePlaytime('1:00:01')).toBe(3_601_000_000)
    expect(parsePlaytime('abc')).toBeUndefined()
    const raw = (fixture('ccmixter-query') as unknown[])[0] as Record<string, unknown>
    expect(
      mapCcmixter({ ...raw, license_url: 'http://creativecommons.org/licenses/by-nc/3.0/' }),
    ).toBeUndefined()
  })
})

describe('JamendoSource', () => {
  it('is unavailable without a client id and never calls the API', async () => {
    const f = scriptedFetch({})
    const src = new JamendoSource({ fetch: f.fetch })
    expect(src.unavailable()).toMatch(/client id/)
    expect(await src.search(query)).toEqual([])
    expect(f.calls).toHaveLength(0)
  })

  it('maps tracks, keeping only downloadable CC0/BY ones', async () => {
    const f = scriptedFetch({ 'https://api.jamendo.com/v3.0/tracks/': fixture('jamendo-tracks') })
    const src = new JamendoSource({ clientId: 'abc', fetch: f.fetch, gate: new RateGate(0) })
    const tracks = await src.search({ ...query, instrumental: true })
    expect(tracks.map((t) => t.id)).toEqual(['jamendo:1670486'])
    expect(tracks[0]).toMatchObject({
      instrumental: true,
      genres: ['corporate', 'indie'],
      duration: 100_000_000,
    })
    expect(tracks[0]!.tags).toContain('speed_high')
    const url = new URL(f.calls[0]!)
    expect(url.searchParams.get('ccnc')).toBe('false')
    expect(url.searchParams.get('ccnd')).toBe('false')
    expect(url.searchParams.get('vocalinstrumental')).toBe('instrumental')
  })
})

describe('net', () => {
  it('only fetches public https URLs', () => {
    expect(() => assertPublicHttps('https://cdn.example.org/a.mp3')).not.toThrow()
    for (const bad of [
      'http://cdn.example.org/a.mp3',
      'https://127.0.0.1/a.mp3',
      'https://[::1]/a',
      'https://localhost/a',
      'https://nas.local/a',
      'https://intranet/a',
      'file:///etc/passwd',
      'not a url',
    ])
      expect(() => assertPublicHttps(bad)).toThrow(/refusing|invalid URL/)
  })

  it('spaces requests through the gate', async () => {
    const gate = new RateGate(50)
    const f = scriptedFetch({ 'https://a.example.org/': { ok: true } })
    const t0 = performance.now()
    await Promise.all([1, 2, 3].map(() => getJson(f.fetch, gate, 'https://a.example.org/x')))
    expect(performance.now() - t0).toBeGreaterThanOrEqual(95)
  })

  it('reports offline as unavailable', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof globalThis.fetch
    await expect(getJson(fetch, new RateGate(0), 'https://a.example.org/x')).rejects.toThrow(
      /offline/,
    )
  })
})
