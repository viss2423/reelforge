import { describe, expect, it } from 'vitest'
import {
  addTrack,
  buildCaptions,
  insertAudioClip,
  insertMediaClip,
  insertStickerClip,
  insertTextClip,
  mainTrack,
  validateProject,
  type IssueCode,
  type MediaClip,
  type Project,
} from '../src/index.ts'
import { asset, captionStyle, project, projectWithMain, textClip, words } from './helpers.ts'

const SEC = 1_000_000
const codes = (p: Project, assets?: Parameters<typeof validateProject>[1]): IssueCode[] =>
  validateProject(p, assets).map((i) => i.code)

describe('validateProject', () => {
  it('accepts a rich valid project', () => {
    const { p, clips, assets } = projectWithMain([2 * SEC, 2 * SEC])
    clips[1]!.transitionIn = { type: 'fade', duration: SEC }
    const overlay = addTrack(p, 'overlay')
    const img = asset({ kind: 'image' })
    const music = asset({ kind: 'audio' })
    assets[img.id] = img
    assets[music.id] = music
    insertMediaClip(p, { trackId: overlay.id, asset: img, at: SEC })
    insertStickerClip(p, { at: 0, assetId: img.id })
    insertAudioClip(p, { asset: music, at: 0 })
    insertTextClip(p, { at: 0, text: 'hi' })
    buildCaptions(p, { [clips[0]!.assetId]: words(4) }, captionStyle())
    expect(validateProject(p, assets)).toEqual([])
  })

  it('reports schema violations and stops there', () => {
    const p = project() as unknown as { name: string }
    p.name = ''
    const issues = validateProject(p as unknown as Project)
    expect(issues[0]!.code).toBe('schema')
    expect(issues[0]!.message).toContain('name')
  })

  it('reports main-track count, clip type, gaps, overlaps, short clips and duplicate ids', () => {
    const { p, clips } = projectWithMain([SEC, SEC])
    clips[1]!.start = SEC + 5
    clips[0]!.duration = 1000
    clips[1]!.id = clips[0]!.id
    mainTrack(p).clips.push(textClip({ id: 'tx', start: 2 * SEC }) as never)
    const text = p.tracks.find((t) => t.kind === 'text')!
    text.clips.push(textClip({ id: 'x1', start: 0 }), textClip({ id: 'x2', start: SEC }))
    text.clips.push({ ...structuredClone(clips[0]!), id: 'vid-on-text' } as never)
    p.tracks.push({ ...structuredClone(mainTrack(p)), id: 'main2', clips: [] })
    p.markers.push({ id: 'x1', t: 0, kind: 'user' })
    const found = codes(p)
    for (const code of [
      'main_track_count',
      'main_track_clip_type',
      'main_track_gap',
      'clip_overlap',
      'clip_too_short',
      'duplicate_id',
      'track_clip_kind',
    ] as const) {
      expect(found).toContain(code)
    }
  })

  it('reports keyframe, ramp, transition and effect problems', () => {
    const { p, clips } = projectWithMain([SEC, SEC])
    const [a, b] = clips as [MediaClip, MediaClip]
    a.transform.x.keyframes = [
      { t: 10, value: 0, easing: 'linear' },
      { t: 10, value: 1, easing: 'linear' },
    ]
    a.speedRamp = [{ t: 0, value: 0, easing: 'linear' }]
    a.transitionIn = { type: 'fade', duration: 100_000 }
    b.transitionIn = { type: 'fade', duration: 600_000 }
    b.effects = [{ id: 'e', ref: 'p/x', start: 900_000, duration: 200_000, intensity: 1 }]
    expect(codes(p)).toEqual(
      expect.arrayContaining([
        'keyframes_unsorted',
        'speed_ramp_invalid',
        'transition_on_first',
        'transition_too_long',
        'effect_out_of_range',
      ]),
    )
    b.transitionIn = { type: 'fade', duration: 50_000 }
    b.effects = [{ id: 'e', ref: 'p/x', start: SEC, intensity: 1 }]
    expect(codes(p)).toContain('effect_out_of_range')
  })

  it('rejects speed ramps that an overshooting easing pulls to zero or below', () => {
    const { p, clips } = projectWithMain([SEC])
    const c = clips[0]!
    c.speedRamp = [
      { t: 0, value: 4, easing: 'linear' },
      { t: SEC, value: 0.2, easing: 'easeOutBack' },
    ]
    expect(codes(p)).toEqual(['speed_ramp_invalid'])
    c.speedRamp[1]!.value = 1
    expect(codes(p)).toEqual([])
    c.speedRamp[1] = { t: SEC, value: 1, easing: 'easeOutElastic' }
    c.speedRamp[0]!.value = 8
    expect(codes(p)).toEqual(['speed_ramp_invalid'])
  })

  it('flags transitions on non-main clips', () => {
    const p = project()
    const overlay = addTrack(p, 'overlay')
    const c = insertMediaClip(p, { trackId: overlay.id, asset: asset(), at: 0, duration: SEC })
    c.transitionIn = { type: 'fade', duration: 100_000 }
    expect(codes(p)).toEqual(['transition_on_first'])
  })

  it('checks assets when given: missing, kind mismatch and source range', () => {
    const { p, clips, assets } = projectWithMain([SEC, SEC])
    clips[0]!.assetId = 'gone'
    const audioAsset = asset({ kind: 'audio' })
    assets[audioAsset.id] = audioAsset
    clips[1]!.assetId = audioAsset.id
    expect(codes(p, assets)).toEqual(['asset_missing', 'asset_kind_mismatch'])

    const ok = projectWithMain([SEC])
    ok.clips[0]!.in = 9_500_000
    expect(codes(ok.p, ok.assets)).toEqual(['source_out_of_range'])
    // Without assets no asset checks run.
    expect(codes(ok.p)).toEqual([])
  })

  it('checks audio and sticker asset kinds', () => {
    const p = project()
    const silent = asset({ hasAudio: false })
    const vid = asset()
    const au = insertAudioClip(p, { asset: vid, at: 0 })
    au.assetId = silent.id
    insertStickerClip(p, { at: 0, assetId: vid.id })
    expect(codes(p, { [silent.id]: silent, [vid.id]: vid })).toEqual([
      'asset_kind_mismatch',
      'asset_kind_mismatch',
    ])
  })

  it('reports unsorted or inverted caption words once', () => {
    const { p, clips } = projectWithMain([5 * SEC])
    buildCaptions(p, { [clips[0]!.assetId]: words(3) }, captionStyle())
    p.captions!.words.reverse()
    expect(codes(p)).toEqual(['caption_word_invalid'])
    p.captions!.words = [{ ...p.captions!.words[0]!, start: 10, end: 5 }]
    expect(codes(p)).toEqual(['caption_word_invalid'])
  })
})
