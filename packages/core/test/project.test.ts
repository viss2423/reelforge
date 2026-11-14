import { describe, expect, it } from 'vitest'
import {
  OpError,
  addTrack,
  createProject,
  defaultTrack,
  effectiveOverlap,
  findClip,
  insertTextClip,
  isFree,
  mainTrack,
  mainTrackLayout,
  minClipDuration,
  normalizeMainTrack,
  placeClip,
  playbackStart,
  projectDuration,
  removeTrack,
  trackAccepts,
  validateProject,
} from '../src/index.ts'
import { NOW, asset, project, projectWithMain, textClip } from './helpers.ts'

describe('createProject', () => {
  it('creates main, text and audio tracks with schema defaults', () => {
    const p = createProject({ name: 'Reel', id: 'p1', now: NOW, fps: 60 })
    expect(p.id).toBe('p1')
    expect(p.createdAt).toBe(NOW)
    expect(p.settings).toMatchObject({ width: 1080, height: 1920, fps: 60 })
    expect(p.tracks.map((t) => t.kind)).toEqual(['main', 'text', 'audio'])
    expect(validateProject(p)).toEqual([])
  })

  it('generates ids and timestamps when omitted', () => {
    const a = createProject({ name: 'A' })
    const b = createProject({ name: 'B' })
    expect(a.id).not.toBe(b.id)
    expect(Number.isNaN(Date.parse(a.createdAt))).toBe(false)
    expect(a.settings.fps).toBe(30)
  })
})

describe('tracks', () => {
  it('mainTrack throws when missing', () => {
    const p = project()
    p.tracks = p.tracks.filter((t) => t.kind !== 'main')
    expect(() => mainTrack(p)).toThrow(OpError)
  })

  it('addTrack stacks overlays above main/overlays and appends text/audio', () => {
    const p = project()
    const o1 = addTrack(p, 'overlay')
    const o2 = addTrack(p, 'overlay')
    const t2 = addTrack(p, 'text')
    expect(p.tracks.map((t) => t.kind)).toEqual([
      'main',
      'overlay',
      'overlay',
      'text',
      'audio',
      'text',
    ])
    expect(p.tracks.indexOf(o1)).toBe(1)
    expect(p.tracks.indexOf(o2)).toBe(2)
    expect(o2.name).toBe('Overlay 2')
    expect(t2.name).toBe('Text 2')
    const named = addTrack(p, 'audio', { name: 'Music', index: 0 })
    expect(p.tracks[0]).toBe(named)
  })

  it('refuses a second main track and removing the main track', () => {
    const p = project()
    expect(() => addTrack(p, 'main')).toThrow(/exactly one/)
    expect(() => removeTrack(p, mainTrack(p).id)).toThrow(OpError)
    expect(() => removeTrack(p, 'nope')).toThrow(OpError)
  })

  it('addTrack(main) on a project without one inserts it first', () => {
    const p = project()
    p.tracks = p.tracks.filter((t) => t.kind !== 'main')
    addTrack(p, 'main')
    expect(p.tracks[0]!.kind).toBe('main')
  })

  it('removeTrack removes a non-main track', () => {
    const p = project()
    const text = p.tracks[1]!
    removeTrack(p, text.id)
    expect(p.tracks.some((t) => t.id === text.id)).toBe(false)
  })

  it('trackAccepts encodes the clip/track matrix', () => {
    expect(trackAccepts('main', 'video')).toBe(true)
    expect(trackAccepts('main', 'sticker')).toBe(false)
    expect(trackAccepts('overlay', 'sticker')).toBe(true)
    expect(trackAccepts('overlay', 'text')).toBe(false)
    expect(trackAccepts('text', 'text')).toBe(true)
    expect(trackAccepts('audio', 'audio')).toBe(true)
    expect(trackAccepts('audio', 'video')).toBe(false)
  })

  it('defaultTrack skips locked tracks and creates one when needed', () => {
    const p = project()
    const text = p.tracks[1]!
    expect(defaultTrack(p, 'text')).toBe(text)
    text.locked = true
    const created = defaultTrack(p, 'text')
    expect(created).not.toBe(text)
    expect(created.kind).toBe('text')
  })
})

describe('placement', () => {
  it('isFree treats ranges as half-open', () => {
    const p = project()
    const track = p.tracks[1]!
    track.clips.push(textClip({ id: 'a', start: 1_000_000, duration: 1_000_000 }))
    expect(isFree(track, 0, 1_000_000)).toBe(true)
    expect(isFree(track, 2_000_000, 3_000_000)).toBe(true)
    expect(isFree(track, 1_500_000, 1_600_000)).toBe(false)
    expect(isFree(track, 1_500_000, 1_600_000, 'a')).toBe(true)
  })

  it('placeClip uses the preferred track, another free track, or a new track above', () => {
    const p = project()
    const text = p.tracks[1]!
    expect(placeClip(p, text, textClip({ id: 'a', start: 0 }))).toBe(text)
    const second = placeClip(p, text, textClip({ id: 'b', start: 500_000 }))
    expect(second).not.toBe(text)
    expect(p.tracks.indexOf(second)).toBe(p.tracks.indexOf(text) + 1)
    // A third overlapping clip that fits on neither goes to yet another track…
    const third = placeClip(p, text, textClip({ id: 'c', start: 1_000_000 }))
    expect(third).not.toBe(text)
    expect(third).not.toBe(second)
    // …while a clip that fits on the second track lands there.
    expect(placeClip(p, text, textClip({ id: 'd', start: 2_600_000, duration: 100_000 }))).toBe(
      text,
    )
    expect(placeClip(p, text, textClip({ id: 'e', start: 2_550_000, duration: 100_000 }))).toBe(
      second,
    )
    expect(validateProject(p)).toEqual([])
  })

  it('placeClip keeps the track sorted by start', () => {
    const p = project()
    const text = p.tracks[1]!
    placeClip(p, text, textClip({ id: 'late', start: 5_000_000 }))
    placeClip(p, text, textClip({ id: 'early', start: 0 }))
    expect(text.clips.map((c) => c.id)).toEqual(['early', 'late'])
  })
})

describe('main track layout and duration', () => {
  it('is contiguous without transitions', () => {
    const { p, clips } = projectWithMain([1_000_000, 2_000_000, 500_000])
    expect(mainTrackLayout(p).map((e) => [e.start, e.end, e.overlap])).toEqual([
      [0, 1_000_000, 0],
      [1_000_000, 3_000_000, 0],
      [3_000_000, 3_500_000, 0],
    ])
    expect(projectDuration(p)).toBe(3_500_000)
    expect(playbackStart(p, mainTrack(p), clips[2]!)).toBe(3_000_000)
  })

  it('overlaps clips by their transitions: duration = Σd − Σoverlap', () => {
    const { p, clips } = projectWithMain([2_000_000, 2_000_000, 2_000_000])
    clips[1]!.transitionIn = { type: 'fade', duration: 400_000 }
    clips[2]!.transitionIn = { type: 'wipeleft', duration: 600_000 }
    const layout = mainTrackLayout(p)
    expect(layout.map((e) => [e.start, e.end])).toEqual([
      [0, 2_000_000],
      [1_600_000, 3_600_000],
      [3_000_000, 5_000_000],
    ])
    expect(projectDuration(p)).toBe(6_000_000 - 1_000_000)
    // The model keeps contiguous starts.
    expect(clips.map((c) => c.start)).toEqual([0, 2_000_000, 4_000_000])
  })

  it('effectiveOverlap clamps to half of both neighbours and drops sub-minimum transitions', () => {
    const t = { type: 'fade' as const, duration: 1_000_000 }
    expect(effectiveOverlap(undefined, 1_000_000, 1_000_000)).toBe(0)
    expect(effectiveOverlap(t, undefined, 1_000_000)).toBe(0)
    expect(effectiveOverlap(t, 600_000, 3_000_000)).toBe(300_000)
    expect(effectiveOverlap(t, 3_000_000, 500_000)).toBe(250_000)
    expect(effectiveOverlap(t, 80_000, 3_000_000)).toBe(0)
  })

  it('projectDuration includes clips on other tracks', () => {
    const { p } = projectWithMain([1_000_000])
    insertTextClip(p, { at: 4_000_000, duration: 1_000_000, text: 'late' })
    expect(projectDuration(p)).toBe(5_000_000)
    expect(projectDuration(project())).toBe(0)
  })

  it('mainTrackLayout of a project without a main track is empty', () => {
    const p = project()
    p.tracks = []
    expect(mainTrackLayout(p)).toEqual([])
  })

  it('findClip locates clips and reports undefined for unknown ids', () => {
    const { p, clips } = projectWithMain([1_000_000, 1_000_000])
    expect(findClip(p, clips[1]!.id)).toMatchObject({ index: 1, clip: clips[1] })
    expect(findClip(p, 'missing')).toBeUndefined()
  })

  it('minClipDuration is one frame', () => {
    expect(minClipDuration(30)).toBe(33_333)
    expect(minClipDuration(24)).toBe(41_666)
  })
})

describe('normalizeMainTrack', () => {
  it('re-packs starts, clamps transitions and strips the first transition', () => {
    const { p, clips } = projectWithMain([1_000_000, 600_000, 2_000_000])
    clips[0]!.transitionIn = { type: 'fade', duration: 400_000 }
    clips[1]!.transitionIn = { type: 'fade', duration: 1_000_000 }
    clips[2]!.transitionIn = { type: 'fade', duration: 400_000 }
    clips[1]!.start = 99
    clips[2]!.start = 7
    normalizeMainTrack(p)
    expect(clips[0]!.transitionIn).toBeUndefined()
    expect(clips[1]!.transitionIn!.duration).toBe(300_000)
    expect(clips[2]!.transitionIn!.duration).toBe(300_000)
    expect(clips.map((c) => c.start)).toEqual([0, 1_000_000, 1_600_000])
    expect(validateProject(p)).toEqual([])
  })

  it('removes transitions that clamp below the 50 ms minimum', () => {
    const { p, clips } = projectWithMain([1_000_000, 90_000])
    clips[1]!.transitionIn = { type: 'fade', duration: 400_000 }
    normalizeMainTrack(p)
    expect(clips[1]!.transitionIn).toBeUndefined()
  })

  it('moves stray non-media clips off the main track and demotes extra main tracks', () => {
    const { p } = projectWithMain([1_000_000])
    const main = mainTrack(p)
    main.clips.push(textClip({ id: 'stray', start: 0 }) as never)
    const extra = addTrack(p, 'overlay')
    extra.kind = 'main'
    normalizeMainTrack(p)
    expect(main.clips.every((c) => c.type === 'video' || c.type === 'image')).toBe(true)
    expect(findClip(p, 'stray')!.track.kind).toBe('text')
    expect(p.tracks.filter((t) => t.kind === 'main')).toHaveLength(1)
    expect(extra.kind).toBe('overlay')
  })

  it('creates a main track when none exists', () => {
    const p = project()
    p.tracks = p.tracks.filter((t) => t.kind !== 'main')
    normalizeMainTrack(p)
    expect(p.tracks[0]!.kind).toBe('main')
    expect(validateProject(p)).toEqual([])
  })

  it('sorts non-main tracks', () => {
    const p = project()
    const text = p.tracks[1]!
    text.clips.push(textClip({ id: 'b', start: 3_000_000 }), textClip({ id: 'a', start: 0 }))
    normalizeMainTrack(p)
    expect(text.clips.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('works with an image clip on main', () => {
    const p = project()
    const img = asset({ kind: 'image' })
    const v = asset()
    const track = mainTrack(p)
    track.clips.push(
      { ...projectWithMain([1_000_000]).clips[0]!, id: 'v', assetId: v.id },
      { ...projectWithMain([1_000_000]).clips[0]!, id: 'i', type: 'image', assetId: img.id },
    )
    normalizeMainTrack(p)
    expect(track.clips.map((c) => c.start)).toEqual([0, 1_000_000])
  })
})
