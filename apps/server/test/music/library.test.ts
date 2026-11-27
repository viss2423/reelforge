/**
 * MusicLibrary with real FFmpeg on a synthetic song: search cache, single-flight downloads,
 * analysis (BPM, chorus) persisted across restarts, previews, LRU pruning and URL safety.
 */
import { existsSync, readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MusicLibrary } from '../../src/music/library.ts'
import { FFMPEG_BIN, FFPROBE, makeTempDir, NO_FFMPEG, skipBecause } from '../ai/helpers.ts'
import { execFileSync } from 'node:child_process'
import { FakeSource, scriptedFetch, SONG_BPM, sourceTrack, synthSong } from './helpers.ts'

const CDN = 'https://cdn.example.org/'

describe.skipIf(skipBecause(NO_FFMPEG))('MusicLibrary (FFmpeg)', () => {
  let tmp: ReturnType<typeof makeTempDir>
  let song: Buffer

  beforeAll(() => {
    tmp = makeTempDir('rf-music-')
    song = readFileSync(synthSong(path.join(tmp.dir, 'song.mp3')))
  })
  afterAll(() => tmp.cleanup())

  const setup = (name: string, opts: { now?: () => number; maxCacheBytes?: number } = {}) => {
    const source = new FakeSource('fake', [
      sourceTrack({ id: 'fake:1', title: 'Song One', tags: ['upbeat'] }),
      sourceTrack({ id: 'fake:2', title: 'Song Two' }),
    ])
    const net = scriptedFetch({ [CDN]: song })
    const lib = new MusicLibrary({
      dir: path.join(tmp.dir, name),
      ffmpeg: FFMPEG_BIN,
      sources: [source],
      fetch: net.fetch,
      ...opts,
    })
    return { source, net, lib }
  }
  const q = { terms: 'upbeat', tags: [], limit: 10 }

  it('caches searches for a day and falls back to the stale cache when a source fails', async () => {
    let now = 1_000_000
    const { source, lib } = setup('search', { now: () => now })
    const a = await lib.search(q)
    expect(a.tracks.map((t) => t.id)).toEqual(['fake:1', 'fake:2'])
    await lib.search(q)
    expect(source.calls).toHaveLength(1)
    expect(lib.stats.searchCacheHits).toBe(1)
    now += 25 * 3600 * 1000
    source.fail = 'HTTP 500'
    const stale = await lib.search(q)
    expect(source.calls).toHaveLength(2)
    expect(stale.tracks).toHaveLength(2)
    expect(stale.warnings).toEqual(['fake: HTTP 500'])
    expect(await lib.describe('fake:1')).toMatchObject({ cached: false, analyzed: false })
    expect(JSON.stringify(await lib.toWire(stale.tracks))).not.toContain('audioUrl')
  })

  it('downloads once, analyses once, survives a restart and renders a 10 s preview', async () => {
    const { lib, net } = setup('dl')
    await lib.search(q)
    const files = await Promise.all([1, 2, 3].map(() => lib.ensureAudio('fake:1')))
    expect(new Set(files).size).toBe(1)
    expect(lib.stats.downloads).toBe(1)
    expect(net.calls.filter((c) => c.startsWith(CDN))).toHaveLength(1)

    const a = await lib.analyze('fake:1')
    expect(Math.abs(a.bpm - SONG_BPM)).toBeLessThanOrEqual(2)
    expect(a.envelope.length).toBeGreaterThan(500)
    expect(a.downbeats.length).toBeGreaterThan(5)
    const chorus = MusicLibrary.section(a, 10_000_000)
    expect(chorus.start).toBeGreaterThanOrEqual(11_000_000)
    expect(chorus.start).toBeLessThanOrEqual(13_000_000)
    await lib.analyze('fake:1')
    expect(lib.stats.analyses).toBe(1)

    // A new process sees the cached audio + analysis without any network.
    const again = new MusicLibrary({
      dir: lib.dir,
      ffmpeg: FFMPEG_BIN,
      sources: [],
      fetch: net.fetch,
    })
    expect(await again.describe('fake:1')).toMatchObject({
      cached: true,
      analyzed: true,
      bpm: expect.any(Number),
    })
    expect((await again.searchCached(['upbeat'])).map((t) => t.id)).toEqual(['fake:1'])
    expect(await again.searchCached(['jazz'])).toEqual([])

    const preview = await again.preview('fake:1')
    expect(again.stats.analyses).toBe(0)
    expect(existsSync(preview)).toBe(true)
    const probe = FFPROBE ?? FFMPEG_BIN.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')
    const d = Number(
      execFileSync(probe, [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'csv=p=0',
        preview,
      ])
        .toString()
        .trim(),
    )
    expect(d).toBeGreaterThan(9.5)
    expect(d).toBeLessThan(10.5)
    expect(await again.preview('fake:1')).toBe(preview)
  })

  it('prunes the least recently used tracks beyond the budget', async () => {
    let now = 0
    const { lib } = setup('prune', { now: () => (now += 1000), maxCacheBytes: song.length * 1.5 })
    await lib.search(q)
    await lib.ensureAudio('fake:1')
    await lib.ensureAudio('fake:2')
    const r = await lib.prune()
    expect(r.removed).toBeGreaterThanOrEqual(1)
    expect(lib.isCached('fake:1')).toBe(false)
    expect(lib.isCached('fake:2')).toBe(true)
    expect(await readdir(path.join(lib.dir, 'tracks'))).toHaveLength(1)
  })

  it('refuses unsafe URLs, non-audio responses and unknown tracks', async () => {
    const { lib, source } = setup('unsafe')
    source.tracks = [
      sourceTrack({ id: 'fake:local', audioUrl: 'https://127.0.0.1/x.mp3' }),
      sourceTrack({ id: 'fake:html', audioUrl: 'https://html.example.org/x' }),
    ]
    const html = scriptedFetch({
      'https://html.example.org/': () =>
        new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    })
    const lib2 = new MusicLibrary({
      dir: lib.dir,
      ffmpeg: FFMPEG_BIN,
      sources: [source],
      fetch: html.fetch,
    })
    await lib2.search(q)
    await expect(lib2.ensureAudio('fake:local')).rejects.toThrow(/refusing/)
    await expect(lib2.ensureAudio('fake:html')).rejects.toThrow(/not an audio file/)
    await expect(lib2.ensureAudio('fake:missing')).rejects.toThrow(/unknown track/)
    expect(lib2.isCached('fake:html')).toBe(false)
  })
})
