import { describe, expect, it } from 'vitest'
import {
  MUSIC_FADE_IN,
  MUSIC_FADE_OUT_MAX,
  OpError,
  createProject,
  insertAudioClip,
  insertMusicClip,
  musicCredits,
  reelLength,
  sec,
  validateProject,
  type Asset,
  type AudioClip,
  type MusicMeta,
} from '../src/index.ts'
import { NOW, asset, projectWithMain } from './helpers.ts'

const meta = (over: Partial<MusicMeta> = {}): MusicMeta => ({
  source: 'ccmixter',
  trackId: 'ccmixter:1',
  title: 'Night Drive',
  artist: 'Someone',
  licence: { code: 'by', name: 'CC BY 4.0', attributionRequired: true },
  ...over,
})

const musicAsset = (over: Partial<Asset> = {}): Asset =>
  asset({ kind: 'audio', duration: sec(120), hasVideo: false, ...over })

const audioClips = (p: ReturnType<typeof projectWithMain>['p']): AudioClip[] =>
  p.tracks.flatMap((t) => t.clips.filter((c): c is AudioClip => c.type === 'audio'))

describe('insertMusicClip', () => {
  it('fills the reel from the chorus with fades, duck and beat markers', () => {
    const { p, assets } = projectWithMain([sec(10), sec(5)])
    const beats = Array.from({ length: 200 }, (_, i) => i * 500_000) // 120 BPM grid
    const a = musicAsset({
      beats,
      music: meta({
        section: { start: sec(40), end: sec(70) },
        downbeats: beats.filter((_, i) => i % 4 === 0),
      }),
    })
    assets[a.id] = a
    const clip = insertMusicClip(p, { asset: a, duck: true })
    expect(reelLength(p)).toBe(sec(15))
    expect(clip).toMatchObject({
      start: 0,
      duration: sec(15),
      in: sec(40),
      role: 'music',
      duckUnderVoice: true,
      name: 'Night Drive',
    })
    expect(clip.audio.fadeIn).toBe(MUSIC_FADE_IN)
    expect(clip.audio.fadeOut).toBe(MUSIC_FADE_OUT_MAX)
    const markers = p.markers.filter((m) => m.kind === 'beat')
    expect(markers).toHaveLength(30)
    expect(markers[0]).toMatchObject({ t: 0, label: 'bar' })
    expect(markers[1]!.label).toBeUndefined()
    expect(markers.at(-1)!.t).toBe(sec(14.5))
    expect(validateProject(p, assets)).toEqual([])
  })

  it('starts earlier when the rest of the track is shorter than the reel', () => {
    const { p, assets } = projectWithMain([sec(10), sec(10)])
    const a = musicAsset({
      duration: sec(30),
      music: meta({ section: { start: sec(25), end: sec(30) } }),
    })
    assets[a.id] = a
    const clip = insertMusicClip(p, { asset: a })
    expect(clip.in).toBe(sec(10))
    expect(clip.duration).toBe(sec(20))
  })

  it('uses the whole track (no fade-in) when it is shorter than the reel', () => {
    const { p, assets } = projectWithMain([sec(10), sec(10)])
    const a = musicAsset({ duration: sec(8) })
    assets[a.id] = a
    const clip = insertMusicClip(p, { asset: a, sourceStart: sec(3) })
    expect(clip).toMatchObject({ in: 0, duration: sec(8) })
    expect(clip.audio.fadeIn).toBe(0)
    expect(clip.audio.fadeOut).toBe(MUSIC_FADE_OUT_MAX)
  })

  it('replaces previous music but keeps voiceovers and sfx', () => {
    const { p, assets } = projectWithMain([sec(10)])
    const old = musicAsset()
    const vo = musicAsset({ duration: sec(3) })
    assets[old.id] = old
    assets[vo.id] = vo
    insertAudioClip(p, { asset: old, at: 0, role: 'music' })
    insertAudioClip(p, { asset: vo, at: 0, role: 'voiceover' })
    const a = musicAsset()
    assets[a.id] = a
    const clip = insertMusicClip(p, { asset: a })
    const roles = audioClips(p).map((c) => [c.assetId, c.role])
    expect(roles).toContainEqual([vo.id, 'voiceover'])
    expect(roles).toContainEqual([a.id, 'music'])
    expect(roles).not.toContainEqual([old.id, 'music'])
    expect(clip.start).toBe(0)
    expect(validateProject(p, assets)).toEqual([])
  })

  it('keeps existing music when asked and avoids overlaps', () => {
    const { p, assets } = projectWithMain([sec(10)])
    const old = musicAsset()
    assets[old.id] = old
    insertAudioClip(p, { asset: old, at: 0, role: 'music' })
    const a = musicAsset()
    assets[a.id] = a
    insertMusicClip(p, { asset: a, replaceExisting: false })
    expect(audioClips(p)).toHaveLength(2)
    expect(validateProject(p, assets)).toEqual([])
  })

  it('replaces beat markers but keeps user markers; markers:false leaves them', () => {
    const { p, assets } = projectWithMain([sec(4)])
    p.markers.push({ id: 'u1', t: sec(1), kind: 'user' }, { id: 'b1', t: 123, kind: 'beat' })
    const a = musicAsset({ beats: [sec(1), sec(2)] })
    assets[a.id] = a
    insertMusicClip(p, { asset: a })
    expect(p.markers.map((m) => [m.kind, m.t])).toEqual([
      ['user', sec(1)],
      ['beat', sec(1)],
      ['beat', sec(2)],
    ])
    const before = structuredClone(p.markers)
    insertMusicClip(p, { asset: a, markers: false, beats: [sec(3)] })
    expect(p.markers).toEqual(before)
  })

  it('uses 30 s when there is no video and rejects unusable assets', () => {
    const p = createProject({ name: 't', id: 'p', now: NOW })
    const a = musicAsset()
    expect(insertMusicClip(p, { asset: a }).duration).toBe(sec(30))
    expect(() => insertMusicClip(p, { asset: asset({ kind: 'image' }) })).toThrow(OpError)
    expect(() => insertMusicClip(p, { asset: musicAsset({ duration: undefined }) })).toThrow(
      OpError,
    )
  })
})

describe('musicCredits', () => {
  it('lists required attributions once, in timeline order, skipping muted and CC0', () => {
    const { p, assets } = projectWithMain([sec(30)])
    const by = musicAsset({ music: meta({ attribution: '"Night Drive" by Someone, CC BY 4.0' }) })
    const by2 = musicAsset({ music: meta({ title: 'B', artist: 'C', trackId: 'x:2' }) })
    const cc0 = musicAsset({
      music: meta({ licence: { code: 'cc0', name: 'CC0', attributionRequired: false } }),
    })
    const plain = musicAsset()
    for (const a of [by, by2, cc0, plain]) assets[a.id] = a
    insertAudioClip(p, { asset: by2, at: sec(20), role: 'sfx' })
    insertAudioClip(p, { asset: by, at: 0 })
    insertAudioClip(p, { asset: by, at: sec(12) })
    insertAudioClip(p, { asset: cc0, at: 0 })
    insertAudioClip(p, { asset: plain, at: 0 })
    expect(musicCredits(p, assets)).toEqual([
      '"Night Drive" by Someone, CC BY 4.0',
      '"B" by C (CC BY 4.0)',
    ])
    for (const c of audioClips(p)) c.audio.muted = true
    expect(musicCredits(p, assets)).toEqual([])
  })
})

describe('withoutMusic', () => {
  it('drops only music-role clips and leaves the original untouched', async () => {
    const { projectWithMain, asset } = await import('./helpers.ts')
    const { insertAudioClip, withoutMusic } = await import('../src/index.ts')
    const { p } = projectWithMain([5_000_000])
    const song = asset({ kind: 'audio', duration: 20_000_000, hasVideo: false })
    const vo = asset({ kind: 'audio', duration: 3_000_000, hasVideo: false })
    insertAudioClip(p, { asset: song, at: 0, role: 'music' })
    insertAudioClip(p, { asset: vo, at: 0, role: 'voiceover' })
    const out = withoutMusic(p)
    const roles = (q: typeof p) =>
      q.tracks.flatMap((t) => t.clips).flatMap((c) => (c.type === 'audio' ? [c.role] : []))
    expect(roles(out)).toEqual(['voiceover'])
    expect(roles(p).toSorted()).toEqual(['music', 'voiceover'])
  })
})
