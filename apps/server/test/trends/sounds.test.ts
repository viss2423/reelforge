import { describe, expect, it } from 'vitest'
import { bpmGrid } from '../../src/trends/sound-beats.ts'
import {
  SoundPreviews,
  isPreviewHost,
  sameSong,
  soundFeel,
  soundProfile,
} from '../../src/trends/sounds.ts'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Fake provider APIs: Deezer search, iTunes search and the preview CDN. */
const fakeFetch = (opts: { deezer?: unknown; itunes?: unknown; calls?: string[] } = {}) =>
  (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    opts.calls?.push(url)
    if (url.startsWith('https://api.deezer.com/search')) return json(opts.deezer ?? { data: [] })
    if (url.startsWith('https://itunes.apple.com/search'))
      return json(opts.itunes ?? { results: [] })
    if (url.includes('dzcdn.net') || url.includes('itunes.apple.com/itunes-assets'))
      return new Response(new Uint8Array([0xff, 0xfb, 1, 2, 3]), {
        headers: { 'content-type': 'audio/mpeg' },
      })
    return new Response('nope', { status: 404 })
  }) as typeof fetch

describe('trending sound profile', () => {
  it('derives mood and energy from genre, else tempo', () => {
    expect(soundFeel({ bpm: 92, genre: 'Hip-Hop/Rap' })).toEqual({
      mood: 'energetic',
      energy: 0.75,
    })
    expect(soundFeel({ bpm: 70, genre: 'Singer/Songwriter' }).mood).toBe('emotional')
    expect(soundFeel({ bpm: 132 })).toEqual({ mood: 'energetic', energy: 0.8 })
    expect(soundFeel({ bpm: 75 }).mood).toBe('chill')
    expect(
      soundProfile({
        title: 'Song',
        artist: 'A',
        bpm: 124,
        measured: true,
        weight: 0.9,
        genre: 'Dance',
      }),
    ).toMatchObject({
      title: 'Song',
      artist: 'A',
      bpm: 124,
      genre: 'Dance',
      mood: 'energetic',
      weight: 0.9,
    })
  })
})

describe('official previews', () => {
  it('only proxies Deezer/Apple CDN hosts over https', () => {
    expect(isPreviewHost('https://cdnt-preview.dzcdn.net/api/1/1/a/b/c.mp3?hdnea=x')).toBe(true)
    // Apple previews are never used: Apple forbids previews synchronised with video.
    expect(isPreviewHost('https://audio-ssl.itunes.apple.com/itunes-assets/x.m4a')).toBe(false)
    expect(isPreviewHost('http://cdnt-preview.dzcdn.net/x.mp3')).toBe(false)
    expect(isPreviewHost('https://evil.example/x.mp3')).toBe(false)
    expect(isPreviewHost('https://dzcdn.net.evil.example/x.mp3')).toBe(false)
    expect(isPreviewHost('not a url')).toBe(false)
  })

  it('matches songs loosely but never an unrelated one', () => {
    expect(
      sameSong(
        { title: 'Espresso', artist: 'Sabrina Carpenter' },
        { title: 'Espresso (Remix)', artist: 'Sabrina Carpenter' },
      ),
    ).toBe(true)
    expect(
      sameSong(
        { title: 'Espresso', artist: 'Sabrina Carpenter' },
        { title: 'Espresso', artist: 'Someone Else' },
      ),
    ).toBe(false)
    expect(sameSong({ title: 'Espresso' }, { title: 'Latte' })).toBe(false)
  })

  it('resolves the Deezer preview of the same song only, and memoises', async () => {
    const calls: string[] = []
    const p = new SoundPreviews({
      userAgent: 'test',
      fetch: fakeFetch({
        deezer: {
          data: [
            {
              title: 'Other',
              preview: 'https://cdnt-preview.dzcdn.net/o.mp3',
              artist: { name: 'X' },
            },
            {
              title: 'Song',
              preview: 'https://cdnt-preview.dzcdn.net/s.mp3',
              artist: { name: 'Band' },
              link: 'https://www.deezer.com/track/1',
            },
          ],
        },
        calls,
      }),
    })
    const r = await p.resolve({ title: 'Song', artist: 'Band' })
    expect(r).toEqual({
      url: 'https://cdnt-preview.dzcdn.net/s.mp3',
      source: 'deezer',
      duration: 30,
      link: 'https://www.deezer.com/track/1',
    })
    await p.resolve({ title: 'Song', artist: 'Band' })
    expect(calls.filter((c) => c.includes('/search')).length).toBe(1)
    expect(calls.some((c) => c.includes('itunes'))).toBe(false)
    const res = await p.open(r!)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    await expect(
      p.open({ url: 'https://evil.example/x.mp3', source: 'deezer', duration: 30 }),
    ).rejects.toThrow(/not allowed/)
  })

  it('reports no preview when neither provider has the song', async () => {
    const p = new SoundPreviews({ userAgent: 'test', fetch: fakeFetch() })
    expect(await p.resolve({ title: 'Nothing', artist: 'Nobody' })).toBeUndefined()
  })
})

describe('sound beat grid', () => {
  it('builds a 4/4 grid at the chart BPM when the preview cannot be analysed', () => {
    const g = bpmGrid(120)
    expect(g.engine).toBe('grid')
    expect(g.beats.slice(0, 3)).toEqual([0, 500_000, 1_000_000])
    expect(g.beats.length).toBe(60)
    expect(g.downbeats.length).toBe(15)
    expect(g.duration).toBe(30_000_000)
  })
})
