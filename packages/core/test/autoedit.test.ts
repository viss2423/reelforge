import { describe, expect, it } from 'vitest'
import {
  OpError,
  assembleAutoEdit,
  hasClearDownbeats,
  insertAudioClip,
  musicSyncOptions,
  mainTrack,
  mainTrackLayout,
  projectDuration,
  validateProject,
  type Asset,
  type AutoEditPlan,
  type MediaClip,
  type TextClip,
} from '../src/index.ts'
import { asset, captionStyle, projectWithMain, words } from './helpers.ts'

const SEC = 1_000_000

/** Two 10 s videos on the main track plus a 20 s music asset. */
const setup = () => {
  const base = projectWithMain([10 * SEC, 10 * SEC])
  const music = asset({ kind: 'audio', duration: 20 * SEC, hasVideo: false })
  const assets: Record<string, Asset> = { ...base.assets, [music.id]: music }
  const [a, b] = base.clips.map((c) => c.assetId) as [string, string]
  return { ...base, assets, a, b, music }
}

const mains = (p: Parameters<typeof mainTrack>[0]) => mainTrack(p).clips as MediaClip[]

describe('assembleAutoEdit', () => {
  it('lays the moments out in story order with their source ranges', () => {
    const { p, assets, a, b } = setup()
    const stats = assembleAutoEdit(
      p,
      {
        moments: [
          { assetId: b, start: 6 * SEC, end: 8 * SEC, role: 'hook' },
          { assetId: a, start: 1 * SEC, end: 4 * SEC },
          { assetId: b, start: 0, end: 1_500_000, role: 'payoff' },
        ],
      },
      assets,
    )
    expect(mains(p).map((c) => [c.assetId, c.in, c.duration])).toEqual([
      [b, 6 * SEC, 2 * SEC],
      [a, 1 * SEC, 3 * SEC],
      [b, 0, 1_500_000],
    ])
    expect(stats).toMatchObject({
      clips: 3,
      duration: 6_500_000,
      beatSynced: false,
      hookText: false,
    })
    expect(validateProject(p, assets)).toEqual([])
  })

  it('keeps the look of the user clip of the same asset but drops keyframed transforms', () => {
    const { p, assets, a, b } = setup()
    const [ca, cb] = mains(p) as [MediaClip, MediaClip]
    ca.adjustments.brightness = 0.3
    ca.audio.denoise = true
    cb.transform.x.keyframes = [{ t: 0, value: 100, easing: 'linear' }]
    assembleAutoEdit(
      p,
      {
        moments: [
          { assetId: a, start: 0, end: SEC },
          { assetId: b, start: 0, end: SEC },
        ],
      },
      assets,
    )
    const [na, nb] = mains(p) as [MediaClip, MediaClip]
    expect(na.adjustments.brightness).toBe(0.3)
    expect(na.audio.denoise).toBe(true)
    expect(nb.transform.x.keyframes).toEqual([])
  })

  it('clamps moments to the source and skips unknown or too-short ones', () => {
    const { p, assets, a } = setup()
    assembleAutoEdit(
      p,
      {
        moments: [
          { assetId: a, start: 9 * SEC, end: 14 * SEC },
          { assetId: 'missing', start: 0, end: SEC },
          { assetId: a, start: 0, end: 10 },
        ],
      },
      assets,
    )
    expect(mains(p).map((c) => [c.in, c.duration])).toEqual([[9 * SEC, SEC]])
  })

  it('throws when nothing can be placed', () => {
    const { p, assets } = setup()
    expect(() => assembleAutoEdit(p, { moments: [] }, assets)).toThrow(OpError)
  })

  it('places photos with their segment length and a Ken Burns move', () => {
    const { p, assets } = setup()
    const img = asset({ kind: 'image' })
    assembleAutoEdit(
      p,
      { moments: [{ assetId: img.id, start: 0, end: 2 * SEC }] },
      {
        ...assets,
        [img.id]: img,
      },
    )
    expect(mains(p)[0]).toMatchObject({ type: 'image', duration: 2 * SEC, autoMotion: 'zoomIn' })
  })

  it('applies the filter everywhere and transitions after the hook cut', () => {
    const { p, assets, a, b } = setup()
    assembleAutoEdit(
      p,
      {
        moments: [0, 1, 2, 3].map((i) => ({
          assetId: i % 2 ? a : b,
          start: i * SEC,
          end: (i + 1.5) * SEC,
        })),
        filter: { ref: 'pack/warm', intensity: 0.8 },
        transition: { type: 'fade', duration: 300_000 },
      },
      assets,
    )
    const clips = mains(p)
    expect(clips.every((c) => c.filter?.ref === 'pack/warm')).toBe(true)
    expect(clips.map((c) => c.transitionIn?.type ?? null)).toEqual([null, null, 'fade', 'fade'])
    expect(validateProject(p, assets)).toEqual([])
  })

  it('inserts music at 0, syncs cuts to its beats, trims and fades it', () => {
    const { p, assets, a, b, music } = setup()
    const beats = Array.from({ length: 40 }, (_, i) => 2 * SEC + i * 500_000) // 120 BPM from 2 s
    const stats = assembleAutoEdit(
      p,
      {
        moments: [
          { assetId: a, start: 0, end: 2_300_000 },
          { assetId: b, start: 0, end: 3_200_000 },
          { assetId: a, start: 5 * SEC, end: 7 * SEC },
        ],
        music: { asset: music, in: 2 * SEC, beats, every: 2, duck: true },
      },
      assets,
    )
    expect(stats.beatSynced).toBe(true)
    // Timeline beats 0.5, 1.0, 1.5 … (music starts at its 2 s beat); every 2nd → 0.5, 1.5, 2.5 …
    const ends = mainTrackLayout(p).map((e) => e.end)
    for (const e of ends.slice(0, -1)) expect((e - 500_000) % SEC).toBe(0)
    const m = p.tracks.flatMap((t) => t.clips).find((c) => c.id === stats.musicClipId)!
    expect(m).toMatchObject({ type: 'audio', start: 0, in: 2 * SEC, duckUnderVoice: true })
    expect(m.duration).toBe(projectDuration(p))
    expect(m.type === 'audio' && m.audio.fadeOut).toBeGreaterThan(0)
    expect(validateProject(p, assets)).toEqual([])
  })

  it('cuts on real bar starts when the music has a clear downbeat grid', () => {
    const { p, assets, a, b, music } = setup()
    // 120 BPM from 0 s; bars start on the 2nd beat (0.5 s) — not every 4th beat from 0.
    const beats = Array.from({ length: 40 }, (_, i) => i * 500_000)
    const downbeats = beats.filter((_, i) => i % 4 === 1)
    const stats = assembleAutoEdit(
      p,
      {
        moments: [
          { assetId: a, start: 0, end: 3_300_000 },
          { assetId: b, start: 0, end: 4_400_000 },
          { assetId: a, start: 5 * SEC, end: 8 * SEC },
        ],
        music: { asset: music, in: 0, beats, downbeats, every: 4 },
      },
      assets,
    )
    expect(stats.beatUnit).toBe('bar')
    const ends = mainTrackLayout(p).map((e) => e.end)
    for (const e of ends.slice(0, -1)) expect(downbeats).toContain(e)
    // The music bed carries bar-labelled beat markers from insertMusicClip.
    expect(p.markers.filter((m) => m.kind === 'beat' && m.label === 'bar').length).toBeGreaterThan(
      0,
    )
    expect(validateProject(p, assets)).toEqual([])
  })

  it('falls back to beats when the downbeats are irregular', () => {
    const beats = Array.from({ length: 40 }, (_, i) => i * 500_000)
    const steady = beats.filter((_, i) => i % 4 === 0)
    expect(hasClearDownbeats(beats, steady)).toBe(true)
    expect(hasClearDownbeats(beats, steady.slice(0, 3))).toBe(false)
    const ragged = [0, 500_000, 3_000_000, 3_500_000, 9_000_000, 9_500_000]
    expect(hasClearDownbeats(beats, ragged)).toBe(false)
    expect(musicSyncOptions(4, beats, ragged)).toEqual({ every: 4 })
    expect(musicSyncOptions(4, beats, steady)).toEqual({ unit: 'bar', every: 1, downbeats: steady })
    expect(musicSyncOptions(2, beats, steady)).toEqual({
      unit: 'beat',
      every: 2,
      downbeats: steady,
    })
  })

  it('reuses an existing music clip', () => {
    const { p, assets, a, music } = setup()
    const clip = insertAudioClip(p, { asset: music, at: 4 * SEC })
    const stats = assembleAutoEdit(
      p,
      { moments: [{ assetId: a, start: 0, end: 3 * SEC }], music: { clipId: clip.id } },
      assets,
    )
    expect(stats.musicClipId).toBe(clip.id)
    expect(clip.start).toBe(0)
    expect(clip.duration).toBe(3 * SEC)
  })

  it('maps captions through the new cuts and adds hook text over the opening', () => {
    const { p, assets, a, b } = setup()
    const plan: AutoEditPlan = {
      moments: [
        { assetId: b, start: 2 * SEC, end: 4 * SEC, role: 'hook' },
        { assetId: a, start: 0, end: 2 * SEC },
      ],
      captions: {
        transcripts: {
          [a]: words(20, { len: 200_000, gap: 0 }),
          [b]: words(20, { len: 200_000, gap: 0 }),
        },
        style: captionStyle(),
        language: 'en',
      },
      hookText: {
        text: '  You are doing this wrong ',
        presetRef: 'pack/hook',
        animationIn: { ref: 'builtin/pop', duration: 5 * SEC },
      },
    }
    const stats = assembleAutoEdit(p, plan, assets)
    // 10 words per 2 s moment, re-timed onto the timeline.
    expect(stats.captionWords).toBe(20)
    expect(p.captions?.words[0]).toMatchObject({ text: 'w10', start: 0 })
    expect(p.captions?.words[10]).toMatchObject({ text: 'w0', start: 2 * SEC })
    const text = p.tracks.flatMap((t) => t.clips).find((c) => c.type === 'text') as TextClip
    expect(text).toMatchObject({
      text: 'You are doing this wrong',
      start: 0,
      duration: 2 * SEC,
      presetRef: 'pack/hook',
    })
    expect(text.animationIn?.duration).toBe(SEC)
    expect(stats.hookText).toBe(true)
    expect(validateProject(p, assets)).toEqual([])
  })
})
