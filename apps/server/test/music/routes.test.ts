/** /api/music/* over the real app + queue (`music.suggest` job), fake source, real FFmpeg. */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { MusicSuggestResult, type Asset, type MusicImportResult } from '@reelforge/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { JobDefinition } from '../../src/contracts.ts'
import { MusicService, musicSuggestJob, setMusicService } from '../../src/music/index.ts'
import { assetFile } from '../../src/paths.ts'
import { FFMPEG_BIN, makeTempDir, NO_FFMPEG, skipBecause } from '../ai/helpers.ts'
import { makeApp, type Harness } from '../http/harness.ts'
import { FakeSource, scriptedFetch, sourceTrack, synthSong } from './helpers.ts'

/** Stand-in probe: the real one needs ffprobe on the stored file; here we only count it. */
const probed: string[] = []
const fakeProbe: JobDefinition = {
  kind: 'probe',
  resource: 'io',
  defaultPriority: 10,
  handler: async (ctx) => {
    probed.push((ctx.payload as { assetId: string }).assetId)
    return null
  },
}

describe.skipIf(skipBecause(NO_FFMPEG))('music routes', () => {
  let h: Harness
  let tmp: ReturnType<typeof makeTempDir>
  let source: FakeSource

  beforeAll(async () => {
    tmp = makeTempDir('rf-music-routes-')
    const song = readFileSync(synthSong(path.join(tmp.dir, 'song.mp3')))
    h = await makeApp({ definitions: [musicSuggestJob, fakeProbe] })
    source = new FakeSource('fake', [
      sourceTrack({ id: 'fake:1', title: 'Calm Thing', tags: ['calm'], instrumental: true }),
      sourceTrack({
        id: 'fake:2',
        title: 'Party Starter',
        tags: ['energetic', 'edm'],
        instrumental: true,
        licence: { code: 'by', name: 'CC BY 4.0', attributionRequired: true },
        attribution: '"Party Starter" by Artist · CC BY 4.0',
      }),
    ])
    const net = scriptedFetch({ 'https://cdn.example.org/': song })
    setMusicService(
      h.paths.root,
      new MusicService({
        dir: path.join(h.paths.root, 'music'),
        ffmpeg: FFMPEG_BIN,
        sources: [source],
        fetch: net.fetch,
      }),
    )
  })
  afterAll(async () => {
    setMusicService(h.paths.root, undefined)
    await h.cleanup()
    tmp.cleanup()
  })

  it('requires auth', async () => {
    expect((await h.app.inject({ url: '/api/music/sources' })).statusCode).toBe(401)
  })

  it('lists sources', async () => {
    const res = await h.app.inject({ url: '/api/music/sources', headers: h.headers })
    expect(res.json()).toEqual([
      { id: 'fake', name: 'fake', available: true, homepage: 'https://example.org' },
    ])
  })

  it('searches by mood without downloading anything', async () => {
    const res = await h.app.inject({
      url: '/api/music/search?mood=energetic&limit=5',
      headers: h.headers,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { tracks: Array<{ id: string; cached: boolean }> }
    expect(body.tracks[0]!.id).toBe('fake:2')
    expect(body.tracks.every((t) => !t.cached)).toBe(true)
    expect(res.body).not.toContain('cdn.example.org')
    expect(
      (await h.app.inject({ url: '/api/music/search?bpmMin=10', headers: h.headers })).statusCode,
    ).toBe(400)
  })

  it('suggests through the music.suggest job and analyses the top pick', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/music/suggest',
      headers: h.headers,
      payload: { mood: 'energetic', duration: 15_000_000, hasSpeech: true, analyze: 1 },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as MusicSuggestResult & { jobId: string }
    MusicSuggestResult.parse(body)
    const best = body.tracks[0]!
    expect(best).toMatchObject({ id: 'fake:2', analyzed: true, cached: true })
    expect(best.section!.end - best.section!.start).toBe(15_000_000)
    expect(best.bpm).toBeGreaterThan(100)
    expect(h.store.getJob(body.jobId)).toMatchObject({ kind: 'music.suggest', status: 'done' })
  })

  it('imports a pick as an audio asset with licence, beats and chorus', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/music/import',
      headers: h.headers,
      payload: { trackId: 'fake:2', length: 10_000_000 },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as MusicImportResult
    const asset = h.store.getAsset(body.asset.id) as Asset
    expect(asset).toMatchObject({
      kind: 'audio',
      name: 'Artist - Party Starter.mp3',
      mime: 'audio/mpeg',
    })
    expect(asset.music).toMatchObject({
      source: 'fake',
      trackId: 'fake:2',
      attribution: '"Party Starter" by Artist · CC BY 4.0',
      licence: { code: 'by' },
    })
    expect(asset.beats!.length).toBeGreaterThan(50)
    expect(body.section.end - body.section.start).toBe(10_000_000)
    expect(existsSync(assetFile(h.paths, asset, 'original'))).toBe(true)
    await expect.poll(() => probed).toContain(asset.id)
  })

  it('streams a cached 10 s preview with ranges', async () => {
    const res = await h.app.inject({ url: '/api/music/tracks/fake:2/preview', headers: h.headers })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('audio/mp4')
    const part = await h.app.inject({
      url: '/api/music/tracks/fake:2/preview',
      headers: { ...h.headers, range: 'bytes=0-99' },
    })
    expect(part.statusCode).toBe(206)
    expect(part.rawPayload.length).toBe(100)
  })

  it('404s unknown tracks and validates ids', async () => {
    expect(
      (await h.app.inject({ url: '/api/music/tracks/fake:nope', headers: h.headers })).statusCode,
    ).toBe(404)
    expect(
      (await h.app.inject({ url: '/api/music/tracks/..%2Fetc/preview', headers: h.headers }))
        .statusCode,
    ).toBe(400)
    const imp = await h.app.inject({
      method: 'POST',
      url: '/api/music/import',
      headers: h.headers,
      payload: { trackId: 'fake:nope' },
    })
    expect(imp.statusCode).toBe(404)
  })

  it('answers with warnings and no tracks when every source fails', async () => {
    source.fail = 'offline'
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/music/suggest',
      headers: h.headers,
      payload: { vibe: 'zzz unmatched vibe', analyze: 0 },
    })
    source.fail = undefined
    expect(res.statusCode).toBe(200)
    const body = res.json() as MusicSuggestResult
    expect(body.tracks).toEqual([])
    expect(body.warnings.join(' ')).toMatch(/offline/)
  })
})
