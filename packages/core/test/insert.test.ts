import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STILL_DURATION,
  OpError,
  addTrack,
  insertAudioClip,
  insertMediaClip,
  insertStickerClip,
  insertTextClip,
  mainTrack,
  validateProject,
} from '../src/index.ts'
import { asset, project, projectWithMain } from './helpers.ts'

describe('insertMediaClip', () => {
  it('appends to the main track by default and ripples on index inserts', () => {
    const { p, clips, assets } = projectWithMain([1_000_000, 2_000_000])
    const a = asset()
    assets[a.id] = a
    const c = insertMediaClip(p, {
      trackId: mainTrack(p).id,
      asset: a,
      index: 1,
      duration: 500_000,
    })
    expect(mainTrack(p).clips.map((x) => x.id)).toEqual([clips[0]!.id, c.id, clips[1]!.id])
    expect(clips[1]!.start).toBe(1_500_000)
    expect(validateProject(p, assets)).toEqual([])
  })

  it('inserts at the boundary nearest to a playback time', () => {
    const { p, clips } = projectWithMain([1_000_000, 1_000_000])
    const a = asset()
    const c = insertMediaClip(p, { trackId: mainTrack(p).id, asset: a, at: 1_400_000 })
    expect(mainTrack(p).clips.map((x) => x.id)).toEqual([clips[0]!.id, c.id, clips[1]!.id])
    const d = insertMediaClip(p, { trackId: mainTrack(p).id, asset: a, at: 0 })
    expect(mainTrack(p).clips[0]!.id).toBe(d.id)
  })

  it('defaults to the full asset (video) or 3 s (image) and caps at the asset duration', () => {
    const p = project()
    const main = mainTrack(p).id
    expect(insertMediaClip(p, { trackId: main, asset: asset() }).duration).toBe(10_000_000)
    expect(
      insertMediaClip(p, { trackId: main, asset: asset(), duration: 99_000_000 }).duration,
    ).toBe(10_000_000)
    const img = insertMediaClip(p, { trackId: main, asset: asset({ kind: 'image' }) })
    expect(img.type).toBe('image')
    expect(img.duration).toBe(DEFAULT_STILL_DURATION)
  })

  it('places overlay clips at `at`, opening a new overlay track on collision', () => {
    const p = project()
    const overlay = addTrack(p, 'overlay')
    const a = insertMediaClip(p, {
      trackId: overlay.id,
      asset: asset(),
      at: 1_000_000,
      duration: 2_000_000,
    })
    const b = insertMediaClip(p, {
      trackId: overlay.id,
      asset: asset(),
      at: 2_000_000,
      duration: 2_000_000,
    })
    expect(a.start).toBe(1_000_000)
    expect(overlay.clips).toHaveLength(1)
    expect(p.tracks.filter((t) => t.kind === 'overlay')).toHaveLength(2)
    expect(b.start).toBe(2_000_000)
    expect(validateProject(p)).toEqual([])
  })

  it('rejects wrong tracks, audio assets, unprobed assets and sub-frame durations', () => {
    const p = project()
    const main = mainTrack(p).id
    const text = p.tracks[1]!.id
    expect(() => insertMediaClip(p, { trackId: text, asset: asset() })).toThrow(OpError)
    expect(() => insertMediaClip(p, { trackId: main, asset: asset({ kind: 'audio' }) })).toThrow(
      /insertAudioClip/,
    )
    expect(() =>
      insertMediaClip(p, { trackId: main, asset: asset({ duration: undefined }) }),
    ).toThrow(/no duration/)
    expect(() => insertMediaClip(p, { trackId: main, asset: asset(), duration: 10 })).toThrow(
      /one frame/,
    )
    expect(() => insertMediaClip(p, { trackId: 'nope', asset: asset() })).toThrow(OpError)
  })

  it('refuses to insert into a locked main track', () => {
    const p = project()
    mainTrack(p).locked = true
    expect(() => insertMediaClip(p, { trackId: mainTrack(p).id, asset: asset() })).toThrow(/locked/)
  })

  it('never shares default sub-objects between clips', () => {
    const { clips } = projectWithMain([1_000_000, 1_000_000])
    clips[0]!.transform.x.value = 1
    expect(clips[1]!.transform.x.value).toBe(540)
  })
})

describe('insertAudioClip', () => {
  it('places audio on the audio track, layering on collision', () => {
    const p = project()
    const music = asset({ kind: 'audio', duration: 5_000_000 })
    const a = insertAudioClip(p, { asset: music, at: 0 })
    const b = insertAudioClip(p, { asset: music, at: 1_000_000, role: 'voiceover' })
    expect(a.role).toBe('music')
    expect(b.role).toBe('voiceover')
    expect(p.tracks.filter((t) => t.kind === 'audio')).toHaveLength(2)
    expect(validateProject(p)).toEqual([])
  })

  it('accepts videos with audio and rejects images / silent videos / wrong tracks', () => {
    const p = project()
    expect(insertAudioClip(p, { asset: asset(), at: -5 }).start).toBe(0)
    expect(() => insertAudioClip(p, { asset: asset({ kind: 'image' }), at: 0 })).toThrow(OpError)
    expect(() => insertAudioClip(p, { asset: asset({ hasAudio: false }), at: 0 })).toThrow(OpError)
    expect(() =>
      insertAudioClip(p, { asset: asset({ kind: 'audio', duration: undefined }), at: 0 }),
    ).toThrow(/no duration/)
    expect(() =>
      insertAudioClip(p, { asset: asset({ kind: 'audio' }), at: 0, trackId: p.tracks[1]!.id }),
    ).toThrow(/expected audio/)
  })
})

describe('insertTextClip / insertStickerClip', () => {
  it('inserts text with style overrides and preset ref', () => {
    const p = project()
    const c = insertTextClip(p, {
      at: 1_000_000,
      text: 'Hi',
      style: { fontSize: 120, color: '#FF0000' },
      presetRef: 'trend/bold',
    })
    expect(c).toMatchObject({
      start: 1_000_000,
      duration: DEFAULT_STILL_DURATION,
      presetRef: 'trend/bold',
    })
    expect(c.style.fontSize).toBe(120)
    expect(c.style.fontFamily).toBe('Montserrat')
    expect(p.tracks[1]!.clips).toContain(c)
  })

  it('creates an overlay track for stickers when none exists', () => {
    const p = project()
    const s = insertStickerClip(p, { at: 0, ref: 'trend/fire' })
    expect(s.ref).toBe('trend/fire')
    expect(p.tracks.some((t) => t.kind === 'overlay' && t.clips.includes(s))).toBe(true)
    const u = insertStickerClip(p, { at: 0, assetId: 'img', duration: 500_000 })
    expect(u.assetId).toBe('img')
    expect(validateProject(p)).toEqual([])
  })

  it('requires a sticker source and a valid duration', () => {
    const p = project()
    expect(() => insertStickerClip(p, { at: 0 })).toThrow(/assetId or a pack ref/)
    expect(() => insertTextClip(p, { at: 0, text: 'x', duration: 0 })).toThrow(OpError)
  })
})
