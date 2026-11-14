import { describe, expect, it } from 'vitest'
import {
  OpError,
  addTrack,
  buildCaptions,
  deleteClips,
  duplicateClip,
  evaluate,
  findClip,
  insertAudioClip,
  insertMediaClip,
  insertTextClip,
  mainTrack,
  mainTrackLayout,
  moveClip,
  pruneEmptyTracks,
  removeSourceRanges,
  setClipSpeed,
  sourceRange,
  splitClip,
  timelineToSource,
  trimClip,
  validateProject,
  type MediaClip,
  type TextClip,
} from '../src/index.ts'
import { asset, captionStyle, project, projectWithMain, words } from './helpers.ts'

const ids = (clips: readonly { id: string }[]) => clips.map((c) => c.id)

describe('splitClip', () => {
  it('splits a main clip with an exact source mapping and stays contiguous', () => {
    const { p, clips, assets } = projectWithMain([1_000_000, 3_000_000])
    const c = clips[1]!
    c.in = 500_000
    c.speed = 2
    c.duration = 3_000_000
    const [a, b] = splitClip(p, c.id, 2_000_000) as [MediaClip, MediaClip]
    expect(a.id).toBe(c.id)
    expect(b.id).not.toBe(c.id)
    expect([a.start, a.duration, a.in]).toEqual([1_000_000, 1_000_000, 500_000])
    expect([b.start, b.duration, b.in]).toEqual([2_000_000, 2_000_000, 2_500_000])
    expect(ids(mainTrack(p).clips)).toEqual([clips[0]!.id, a.id, b.id])
    expect(validateProject(p, assets)).toEqual([])
  })

  it('splits keyframes with an interpolated keyframe at the cut (continuous animation)', () => {
    const { p, clips } = projectWithMain([2_000_000])
    const c = clips[0]!
    c.transform.x.keyframes = [
      { t: 0, value: 0, easing: 'linear' },
      { t: 2_000_000, value: 200, easing: 'linear' },
    ]
    c.transform.scale.keyframes = [
      { t: 0, value: 1, easing: 'linear' },
      { t: 500_000, value: 2, easing: 'easeInOut' },
    ]
    const [a, b] = splitClip(p, c.id, 1_000_000) as [MediaClip, MediaClip]
    expect(a.transform.x.keyframes.map((k) => [k.t, k.value])).toEqual([
      [0, 0],
      [1_000_000, 100],
    ])
    expect(b.transform.x.keyframes.map((k) => [k.t, k.value])).toEqual([
      [0, 100],
      [1_000_000, 200],
    ])
    for (let t = 0; t <= 2_000_000; t += 50_000) {
      const v = t < 1_000_000 ? evaluate(a.transform.x, t) : evaluate(b.transform.x, t - 1_000_000)
      expect(v).toBeCloseTo(t / 10_000, 6)
    }
    // Scale animation finishes inside the first half; the second half holds its final value.
    expect(evaluate(b.transform.scale, 0)).toBe(2)
    expect(b.transform.scale.keyframes).toEqual([{ t: 0, value: 2, easing: 'linear' }])
  })

  it('reverse clips: the first half shows the END of the source span', () => {
    const { p, clips } = projectWithMain([4_000_000])
    const c = clips[0]!
    c.reverse = true
    const [a, b] = splitClip(p, c.id, 1_000_000) as [MediaClip, MediaClip]
    expect([a.in, a.duration]).toEqual([3_000_000, 1_000_000])
    expect([b.in, b.duration]).toEqual([0, 3_000_000])
    expect(timelineToSource(a, 0)).toBe(4_000_000)
    expect(timelineToSource(b, b.start)).toBe(3_000_000)
  })

  it('speed ramps: the halves cover exactly the original source span', () => {
    const { p, clips } = projectWithMain([4_000_000])
    const c = clips[0]!
    c.duration = 3_000_000
    c.speedRamp = [
      { t: 0, value: 0.5, easing: 'linear' },
      { t: 3_000_000, value: 2, easing: 'easeInOut' },
    ]
    const whole = sourceRange(c)
    const [a, b] = splitClip(p, c.id, 1_300_000) as [MediaClip, MediaClip]
    const ra = sourceRange(a)
    const rb = sourceRange(b)
    expect(ra.start).toBe(whole.start)
    expect(Math.abs(ra.end - rb.start)).toBeLessThanOrEqual(1)
    expect(Math.abs(rb.end - whole.end)).toBeLessThanOrEqual(1)
  })

  it('partitions effect windows and keeps head/tail attributes on the right half', () => {
    const { p, clips } = projectWithMain([1_000_000, 2_000_000])
    const c = clips[1]!
    c.transitionIn = { type: 'fade', duration: 400_000 }
    c.audio.fadeIn = 300_000
    c.audio.fadeOut = 300_000
    c.effects = [
      { id: 'e1', ref: 'p/shake', start: 500_000, duration: 1_000_000, intensity: 1 },
      { id: 'e2', ref: 'p/glow', start: 0, intensity: 0.5 },
      { id: 'e3', ref: 'p/flash', start: 1_500_000, duration: 100_000, intensity: 1 },
    ]
    // Playback start of c is 1.0 s − 0.4 s overlap = 0.6 s; split 1 s into the clip.
    const [a, b] = splitClip(p, c.id, 1_600_000) as [MediaClip, MediaClip]
    expect(a.duration).toBe(1_000_000)
    expect(a.transitionIn?.type).toBe('fade')
    expect(b.transitionIn).toBeUndefined()
    expect([a.audio.fadeIn, a.audio.fadeOut, b.audio.fadeIn, b.audio.fadeOut]).toEqual([
      300_000, 0, 0, 300_000,
    ])
    expect(a.effects.map((e) => [e.id, e.start, e.duration])).toEqual([
      ['e1', 500_000, 500_000],
      ['e2', 0, undefined],
    ])
    expect(b.effects.map((e) => [e.ref, e.start, e.duration])).toEqual([
      ['p/shake', 0, 500_000],
      ['p/glow', 0, undefined],
      ['p/flash', 500_000, 100_000],
    ])
    expect(b.effects.every((e) => !['e1', 'e2', 'e3'].includes(e.id))).toBe(true)
    expect(validateProject(p)).toEqual([])
  })

  it('leaves captions untouched', () => {
    const { p, clips } = projectWithMain([3_000_000])
    buildCaptions(p, { [clips[0]!.assetId]: words(5) }, captionStyle())
    const before = structuredClone(p.captions)
    splitClip(p, clips[0]!.id, 1_000_000)
    expect(p.captions).toEqual(before)
  })

  it('splits text clips on free tracks: animationIn first, animationOut second', () => {
    const p = project()
    const t = insertTextClip(p, { at: 1_000_000, duration: 2_000_000, text: 'hey' })
    t.animationIn = { ref: 'builtin/pop', duration: 300_000 }
    t.animationOut = { ref: 'builtin/fade', duration: 300_000 }
    const [a, b] = splitClip(p, t.id, 1_500_000) as [TextClip, TextClip]
    expect([a.start, a.duration, b.start, b.duration]).toEqual([
      1_000_000, 500_000, 1_500_000, 1_500_000,
    ])
    expect(a.animationIn).toBeDefined()
    expect(a.animationOut).toBeUndefined()
    expect(b.animationIn).toBeUndefined()
    expect(b.animationOut).toBeDefined()
    expect(validateProject(p)).toEqual([])
  })

  it('rejects cuts within one frame of an edge, unknown clips and locked tracks', () => {
    const { p, clips } = projectWithMain([1_000_000])
    expect(() => splitClip(p, clips[0]!.id, 10_000)).toThrow(OpError)
    expect(() => splitClip(p, clips[0]!.id, 990_000)).toThrow(OpError)
    expect(() => splitClip(p, 'nope', 500_000)).toThrow(/not found/)
    mainTrack(p).locked = true
    expect(() => splitClip(p, clips[0]!.id, 500_000)).toThrow(/locked/)
  })
})

describe('trimClip', () => {
  it('trims a main clip end and ripples the rest', () => {
    const { p, clips } = projectWithMain([2_000_000, 1_000_000])
    trimClip(p, clips[0]!.id, { end: 1_500_000 })
    expect(clips[0]!.duration).toBe(1_500_000)
    expect(findClip(p, clips[1]!.id)!.clip.start).toBe(1_500_000)
  })

  it('trims a main clip start by advancing its in-point', () => {
    const { p, clips } = projectWithMain([2_000_000, 1_000_000])
    clips[0]!.speed = 2
    trimClip(p, clips[0]!.id, { start: 500_000 })
    const c = findClip(p, clips[0]!.id)!.clip as MediaClip
    expect([c.start, c.duration, c.in]).toEqual([0, 1_500_000, 1_000_000])
    expect(findClip(p, clips[1]!.id)!.clip.start).toBe(1_500_000)
  })

  it('extends head limited by available source before the in-point', () => {
    const { p, clips } = projectWithMain([2_000_000])
    const c = clips[0]!
    c.in = 1_000_000
    c.transform.x.keyframes = [{ t: 0, value: 1, easing: 'linear' }]
    // Asking to extend 5 s at the head only finds 1 s of source.
    trimClip(p, c.id, { start: 0 })
    let cur = findClip(p, c.id)!.clip as MediaClip
    expect([cur.in, cur.duration]).toEqual([1_000_000, 2_000_000])
    // Re-trim start then extend back: the in-point is the limit.
    trimClip(p, c.id, { start: 500_000 })
    cur = findClip(p, c.id)!.clip as MediaClip
    expect(cur.in).toBe(1_500_000)
    // Extending a non-main clip head beyond its source is clamped by the in-point.
    const overlay = addTrack(p, 'overlay')
    const o = insertMediaClip(p, {
      trackId: overlay.id,
      asset: asset(),
      at: 3_000_000,
      duration: 1_000_000,
    })
    o.in = 250_000
    trimClip(p, o.id, { start: 1_000_000 })
    expect([o.start, o.duration, o.in]).toEqual([2_750_000, 1_250_000, 0])
  })

  it('extends the tail limited by the asset duration when the asset is given', () => {
    const { p, clips, assets } = projectWithMain([2_000_000])
    const c = clips[0]!
    c.in = 7_000_000
    trimClip(p, c.id, { end: 9_000_000 }, { asset: assets[c.assetId]! })
    expect((findClip(p, c.id)!.clip as MediaClip).duration).toBe(3_000_000)
    expect(validateProject(p, assets)).toEqual([])
  })

  it('reverse clips extend their tail into earlier source', () => {
    const { p, clips, assets } = projectWithMain([2_000_000])
    const c = clips[0]!
    c.reverse = true
    c.in = 1_000_000
    trimClip(p, c.id, { end: 5_000_000 }, { asset: assets[c.assetId]! })
    const cur = findClip(p, c.id)!.clip as MediaClip
    expect([cur.in, cur.duration]).toEqual([0, 3_000_000])
    // The first frame still shows the same source position (end of the span).
    expect(timelineToSource(cur, 0)).toBe(3_000_000)
  })

  it('clamps non-main trims to the neighbours on the same track', () => {
    const p = project()
    const a = insertTextClip(p, { at: 0, duration: 1_000_000, text: 'a' })
    const b = insertTextClip(p, { at: 2_000_000, duration: 1_000_000, text: 'b' })
    const c = insertTextClip(p, { at: 4_000_000, duration: 1_000_000, text: 'c' })
    trimClip(p, b.id, { start: 500_000, end: 4_500_000 })
    expect([b.start, b.duration]).toEqual([1_000_000, 3_000_000])
    expect(a.duration + c.duration).toBe(2_000_000)
    expect(validateProject(p)).toEqual([])
  })

  it('refuses trims shorter than one frame', () => {
    const { p, clips } = projectWithMain([1_000_000])
    expect(() => trimClip(p, clips[0]!.id, { end: 10 })).toThrow(/one frame/)
  })

  it('trims audio clips on audio tracks', () => {
    const p = project()
    const au = insertAudioClip(p, { asset: asset({ kind: 'audio' }), at: 0 })
    trimClip(p, au.id, { start: 1_000_000, end: 3_000_000 })
    expect([au.start, au.duration, au.in]).toEqual([1_000_000, 2_000_000, 1_000_000])
  })
})

describe('moveClip', () => {
  it('reorders main clips by index or nearest boundary', () => {
    const { p, clips } = projectWithMain([1_000_000, 1_000_000, 1_000_000])
    const [a, b, c] = clips.map((x) => x.id) as [string, string, string]
    moveClip(p, a, { index: 2 })
    expect(ids(mainTrack(p).clips)).toEqual([b, c, a])
    moveClip(p, a, { start: 0 })
    expect(ids(mainTrack(p).clips)).toEqual([a, b, c])
    moveClip(p, a, {})
    expect(ids(mainTrack(p).clips)).toEqual([a, b, c])
    expect(validateProject(p)).toEqual([])
  })

  it('moves a main clip to an overlay (dropping its transition) and back', () => {
    const { p, clips } = projectWithMain([1_000_000, 1_000_000, 1_000_000])
    const overlay = addTrack(p, 'overlay')
    clips[1]!.transitionIn = { type: 'fade', duration: 200_000 }
    moveClip(p, clips[1]!.id, { trackId: overlay.id, start: 5_000_000 })
    expect(overlay.clips[0]).toMatchObject({ id: clips[1]!.id, start: 5_000_000 })
    expect((overlay.clips[0] as MediaClip).transitionIn).toBeUndefined()
    expect(mainTrack(p).clips).toHaveLength(2)
    moveClip(p, clips[1]!.id, { trackId: mainTrack(p).id })
    expect(mainTrack(p).clips.at(-1)!.id).toBe(clips[1]!.id)
    expect(validateProject(p)).toEqual([])
  })

  it('moves a main clip to an overlay at its current playback start by default', () => {
    const { p, clips } = projectWithMain([1_000_000, 1_000_000])
    const overlay = addTrack(p, 'overlay')
    moveClip(p, clips[1]!.id, { trackId: overlay.id })
    expect(overlay.clips[0]!.start).toBe(1_000_000)
  })

  it('moves between free tracks, layering on collision', () => {
    const p = project()
    const a = insertTextClip(p, { at: 0, duration: 2_000_000, text: 'a' })
    const b = insertTextClip(p, { at: 3_000_000, duration: 2_000_000, text: 'b' })
    moveClip(p, b.id, { start: 1_000_000 })
    expect(findClip(p, b.id)!.track).not.toBe(findClip(p, a.id)!.track)
    expect(b.start).toBe(1_000_000)
    moveClip(p, b.id, { start: -100 })
    expect(b.start).toBe(0)
    expect(validateProject(p)).toEqual([])
  })

  it('rejects incompatible targets', () => {
    const p = project()
    const t = insertTextClip(p, { at: 0, text: 'x' })
    expect(() => moveClip(p, t.id, { trackId: mainTrack(p).id })).toThrow(/cannot go/)
    const target = addTrack(p, 'text')
    target.locked = true
    expect(() => moveClip(p, t.id, { trackId: target.id })).toThrow(/locked/)
  })
})

describe('deleteClips', () => {
  it('main deletes always close the gap', () => {
    const { p, clips } = projectWithMain([1_000_000, 2_000_000, 3_000_000])
    deleteClips(p, [clips[1]!.id])
    expect(mainTrack(p).clips.map((c) => [c.start, c.duration])).toEqual([
      [0, 1_000_000],
      [1_000_000, 3_000_000],
    ])
  })

  it('free tracks keep gaps unless ripple is requested', () => {
    const p = project()
    const a = insertTextClip(p, { at: 0, duration: 1_000_000, text: 'a' })
    const b = insertTextClip(p, { at: 1_000_000, duration: 1_000_000, text: 'b' })
    const c = insertTextClip(p, { at: 2_000_000, duration: 1_000_000, text: 'c' })
    const d = insertTextClip(p, { at: 3_000_000, duration: 1_000_000, text: 'd' })
    deleteClips(p, [b.id])
    expect(c.start).toBe(2_000_000)
    deleteClips(p, [c.id], { ripple: true })
    expect([a.start, d.start]).toEqual([0, 2_000_000])
    expect(validateProject(p)).toEqual([])
  })

  it('deletes across tracks at once and validates every id first', () => {
    const { p, clips } = projectWithMain([1_000_000, 1_000_000])
    const t = insertTextClip(p, { at: 0, text: 'x' })
    expect(() => deleteClips(p, [t.id, 'missing'])).toThrow(/not found/)
    expect(findClip(p, t.id)).toBeDefined()
    deleteClips(p, [t.id, clips[0]!.id])
    expect(findClip(p, t.id)).toBeUndefined()
    expect(mainTrack(p).clips).toHaveLength(1)
  })
})

describe('duplicateClip', () => {
  it('main: inserts right after with fresh ids and no transition', () => {
    const { p, clips } = projectWithMain([1_000_000, 1_000_000])
    clips[1]!.transitionIn = { type: 'fade', duration: 200_000 }
    clips[1]!.effects = [{ id: 'e1', ref: 'p/x', start: 0, intensity: 1 }]
    const copy = duplicateClip(p, clips[1]!.id) as MediaClip
    expect(ids(mainTrack(p).clips)).toEqual([clips[0]!.id, clips[1]!.id, copy.id])
    expect(copy.transitionIn).toBeUndefined()
    expect(copy.effects[0]!.id).not.toBe('e1')
    expect(validateProject(p)).toEqual([])
  })

  it('free tracks: placed after the original', () => {
    const p = project()
    const t = insertTextClip(p, { at: 1_000_000, duration: 1_000_000, text: 'x' })
    const copy = duplicateClip(p, t.id)
    expect(copy.start).toBe(2_000_000)
    expect(copy.type).toBe('text')
  })
})

describe('setClipSpeed', () => {
  it('preserves the source span and scales keyframes and effect windows', () => {
    const { p, clips, assets } = projectWithMain([2_000_000, 1_000_000])
    const c = clips[0]!
    c.transform.x.keyframes = [
      { t: 0, value: 0, easing: 'linear' },
      { t: 2_000_000, value: 100, easing: 'linear' },
    ]
    c.effects = [{ id: 'e', ref: 'p/x', start: 1_000_000, duration: 500_000, intensity: 1 }]
    c.audio.fadeOut = 1_500_000
    setClipSpeed(p, c.id, 2)
    expect(c.duration).toBe(1_000_000)
    expect(c.transform.x.keyframes.map((k) => k.t)).toEqual([0, 1_000_000])
    expect(c.effects[0]).toMatchObject({ start: 500_000, duration: 250_000 })
    expect(c.audio.fadeOut).toBe(1_000_000)
    expect(sourceRange(c)).toEqual({ start: 0, end: 2_000_000 })
    expect(findClip(p, clips[1]!.id)!.clip.start).toBe(1_000_000)
    expect(validateProject(p, assets)).toEqual([])
  })

  it('clamps to 0.1..16 and is a no-op for the same speed', () => {
    const { p, clips } = projectWithMain([2_000_000])
    setClipSpeed(p, clips[0]!.id, 1)
    expect(clips[0]!.duration).toBe(2_000_000)
    setClipSpeed(p, clips[0]!.id, 1000)
    expect(clips[0]!.speed).toBe(16)
    expect(clips[0]!.duration).toBe(125_000)
  })

  it('re-places a free clip that would now overlap its neighbour', () => {
    const p = project()
    const music = asset({ kind: 'audio', duration: 4_000_000 })
    const a = insertAudioClip(p, { asset: music, at: 0 })
    insertAudioClip(p, { asset: music, at: 4_000_000 })
    setClipSpeed(p, a.id, 0.5)
    expect(a.duration).toBe(8_000_000)
    expect(findClip(p, a.id)!.track).not.toBe(p.tracks.find((t) => t.kind === 'audio'))
    expect(validateProject(p)).toEqual([])
  })

  it('rejects images, NaN and speeds that make the clip shorter than a frame', () => {
    const p = project()
    const img = insertMediaClip(p, { trackId: mainTrack(p).id, asset: asset({ kind: 'image' }) })
    expect(() => setClipSpeed(p, img.id, 2)).toThrow(/no playback speed/)
    const v = insertMediaClip(p, { trackId: mainTrack(p).id, asset: asset(), duration: 100_000 })
    expect(() => setClipSpeed(p, v.id, Number.NaN)).toThrow(OpError)
    expect(() => setClipSpeed(p, v.id, 16)).toThrow(/shorter than one frame/)
  })
})

describe('removeSourceRanges', () => {
  const SEC = 1_000_000

  it('cuts source ranges out of a main clip and ripples', () => {
    const { p, clips, assets } = projectWithMain([10 * SEC, SEC])
    const c = clips[0]!
    removeSourceRanges(p, c.id, [
      { start: 5 * SEC, end: 6 * SEC },
      { start: 2 * SEC, end: 3 * SEC },
      { start: 2_500_000, end: 3_200_000 },
    ])
    const main = mainTrack(p).clips as MediaClip[]
    expect(main.map((x) => [x.start, x.duration, x.in])).toEqual([
      [0, 2 * SEC, 0],
      [2 * SEC, 1_800_000, 3_200_000],
      [3_800_000, 4 * SEC, 6 * SEC],
      [7_800_000, SEC, 0],
    ])
    expect(main[0]!.id).toBe(c.id)
    expect(validateProject(p, assets)).toEqual([])
  })

  it('handles speed != 1', () => {
    const { p, clips } = projectWithMain([5 * SEC])
    clips[0]!.speed = 2
    removeSourceRanges(p, clips[0]!.id, [{ start: 2 * SEC, end: 4 * SEC }])
    const main = mainTrack(p).clips as MediaClip[]
    expect(main.map((x) => [x.start, x.duration, x.in])).toEqual([
      [0, SEC, 0],
      [SEC, 3 * SEC, 4 * SEC],
    ])
  })

  it('handles reverse: pieces stay in playback order', () => {
    const { p, clips } = projectWithMain([10 * SEC])
    clips[0]!.reverse = true
    removeSourceRanges(p, clips[0]!.id, [{ start: 2 * SEC, end: 3 * SEC }])
    const main = mainTrack(p).clips as MediaClip[]
    // Playback shows 10→3 s first, then 2→0 s.
    expect(main.map((x) => [x.start, x.duration, x.in])).toEqual([
      [0, 7 * SEC, 3 * SEC],
      [7 * SEC, 2 * SEC, 0],
    ])
    expect(timelineToSource(main[0]!, 0)).toBe(10 * SEC)
    expect(timelineToSource(main[1]!, 7 * SEC)).toBe(2 * SEC)
  })

  it('remaps captions: words in removed spans drop, later words shift', () => {
    const { p, clips } = projectWithMain([10 * SEC])
    const c = clips[0]!
    buildCaptions(
      p,
      {
        [c.assetId]: [
          {
            text: 'keep',
            start: 1_000_000,
            end: 1_500_000,
            confidence: 1,
            filler: false,
            emphasis: false,
          },
          {
            text: 'um',
            start: 2_200_000,
            end: 2_600_000,
            confidence: 1,
            filler: false,
            emphasis: false,
          },
          {
            text: 'later',
            start: 3_500_000,
            end: 3_800_000,
            confidence: 1,
            filler: false,
            emphasis: false,
          },
        ],
      },
      captionStyle({ emphasizeKeywords: false }),
    )
    removeSourceRanges(p, c.id, [{ start: 2 * SEC, end: 3 * SEC }])
    expect(p.captions!.words.map((w) => [w.text, w.start, w.end])).toEqual([
      ['keep', 1_000_000, 1_500_000],
      ['later', 2_500_000, 2_800_000],
    ])
  })

  it('packs pieces of a free-track clip from its start', () => {
    const p = project()
    const au = insertAudioClip(p, { asset: asset({ kind: 'audio' }), at: SEC })
    removeSourceRanges(p, au.id, [
      { start: 0, end: SEC },
      { start: 4 * SEC, end: 5 * SEC },
    ])
    const track = findClip(p, au.id)!.track
    expect(track.clips.map((x) => [x.start, x.duration])).toEqual([
      [SEC, 3 * SEC],
      [4 * SEC, 5 * SEC],
    ])
    expect(validateProject(p)).toEqual([])
  })

  it('is a no-op for ranges outside the clip and drops sub-frame pieces', () => {
    const { p, clips } = projectWithMain([2 * SEC])
    removeSourceRanges(p, clips[0]!.id, [{ start: 5 * SEC, end: 6 * SEC }])
    expect(mainTrack(p).clips).toHaveLength(1)
    removeSourceRanges(p, clips[0]!.id, [{ start: 10_000, end: 2 * SEC }])
    // The 10 ms head is shorter than a frame and is dropped with the cut.
    expect(mainTrack(p).clips).toHaveLength(0)
  })

  it('rejects clips without source time', () => {
    const p = project()
    const t = insertTextClip(p, { at: 0, text: 'x' })
    expect(() => removeSourceRanges(p, t.id, [{ start: 0, end: 1 }])).toThrow(/no source time/)
  })

  it('keeps transitions clamped after cutting a neighbour short', () => {
    const { p, clips } = projectWithMain([4 * SEC, 4 * SEC])
    clips[1]!.transitionIn = { type: 'fade', duration: SEC }
    removeSourceRanges(p, clips[0]!.id, [{ start: SEC, end: 4 * SEC }])
    expect(clips[1]!.transitionIn!.duration).toBe(500_000)
    expect(mainTrackLayout(p).at(-1)!.end).toBe(4_500_000)
    expect(validateProject(p)).toEqual([])
  })
})

describe('pruneEmptyTracks', () => {
  const kinds = (p: ReturnType<typeof project>) => p.tracks.map((t) => t.kind)

  it('keeps main, the default text/audio lanes and locked tracks; drops other empty lanes', () => {
    const p = project()
    addTrack(p, 'overlay')
    addTrack(p, 'text')
    const locked = addTrack(p, 'audio')
    locked.locked = true
    addTrack(p, 'audio')
    pruneEmptyTracks(p)
    expect(kinds(p)).toEqual(['main', 'text', 'audio', 'audio'])
    expect(p.tracks.at(-1)).toBe(locked)
  })

  it('moving the last clip off a layer removes that layer', () => {
    const p = project()
    const a = insertTextClip(p, { at: 0, duration: 2_000_000, text: 'a' })
    const b = insertTextClip(p, { at: 1_000_000, duration: 2_000_000, text: 'b' })
    expect(kinds(p).filter((k) => k === 'text')).toHaveLength(2)
    moveClip(p, b.id, { trackId: findClip(p, a.id)!.track.id, start: 3_000_000 })
    expect(findClip(p, b.id)!.track).toBe(findClip(p, a.id)!.track)
    expect(kinds(p)).toEqual(['main', 'text', 'audio'])
    expect(validateProject(p)).toEqual([])
  })

  it('deleting the last clip of an extra overlay removes the overlay', () => {
    const { p, clips } = projectWithMain([1_000_000, 1_000_000])
    const overlay = addTrack(p, 'overlay')
    moveClip(p, clips[1]!.id, { trackId: overlay.id, start: 0 })
    expect(kinds(p)).toContain('overlay')
    deleteClips(p, [clips[1]!.id])
    expect(kinds(p)).toEqual(['main', 'text', 'audio'])
  })
})
