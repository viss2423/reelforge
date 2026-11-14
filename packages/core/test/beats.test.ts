import { describe, expect, it } from 'vitest'
import {
  OpError,
  insertTextClip,
  mainTrack,
  mainTrackLayout,
  sourceRange,
  syncToBeats,
  validateProject,
  type MediaClip,
} from '../src/index.ts'
import { project, projectWithMain } from './helpers.ts'

const SEC = 1_000_000

describe('syncToBeats (main track)', () => {
  it('moves each cut back to the latest beat and ripples', () => {
    const { p, assets } = projectWithMain([2 * SEC, 2 * SEC, 2 * SEC])
    syncToBeats(p, [1_800_000, 3_500_000, 5_700_000])
    expect(mainTrack(p).clips.map((c) => [c.start, c.duration])).toEqual([
      [0, 1_800_000],
      [1_800_000, 1_700_000],
      [3_500_000, 2 * SEC], // no beat inside the last clip → unchanged
    ])
    expect(validateProject(p, assets)).toEqual([])
  })

  it('uses only every n-th beat and ignores duplicates / non-positive beats', () => {
    const { p } = projectWithMain([3 * SEC])
    syncToBeats(p, [0, -5, 500_000, 500_000, 1_000_000, 1_500_000, 2_000_000, 2_500_000], {
      every: 2,
    })
    // Grid (every 2nd of 0.5,1,1.5,2,2.5): 0.5, 1.5, 2.5 → last usable beat 2.5 s.
    expect(mainTrack(p).clips[0]!.duration).toBe(2_500_000)
  })

  it('lands transition midpoints on the beat', () => {
    const { p, clips } = projectWithMain([2 * SEC, 2 * SEC])
    clips[1]!.transitionIn = { type: 'fade', duration: 400_000 }
    syncToBeats(p, [1_500_000])
    const layout = mainTrackLayout(p)
    const mid = layout[1]!.start + layout[1]!.overlap / 2
    expect(mid).toBe(1_500_000)
    expect(validateProject(p)).toEqual([])
  })

  it('keeps reversed source mappings exact (cuts only shorten)', () => {
    const { p, clips } = projectWithMain([2 * SEC])
    clips[0]!.reverse = true
    const before = sourceRange(clips[0]!)
    syncToBeats(p, [1_200_000])
    const after = sourceRange(mainTrack(p).clips[0] as MediaClip)
    expect(after.end).toBe(before.end)
    expect(after.end - after.start).toBe(1_200_000)
  })

  it('is a no-op without beats and refuses locked tracks', () => {
    const { p } = projectWithMain([2 * SEC])
    syncToBeats(p, [])
    expect(mainTrack(p).clips[0]!.duration).toBe(2 * SEC)
    mainTrack(p).locked = true
    expect(() => syncToBeats(p, [SEC])).toThrow(OpError)
  })

  it('never shortens a clip below one frame', () => {
    const { p } = projectWithMain([2 * SEC])
    syncToBeats(p, [10_000])
    expect(mainTrack(p).clips[0]!.duration).toBe(2 * SEC)
  })
})

describe('syncToBeats (free tracks)', () => {
  it('snaps starts to the nearest beat and ends back to the latest beat', () => {
    const p = project()
    const text = p.tracks[1]!
    const a = insertTextClip(p, { at: 100_000, duration: 1_000_000, text: 'a' })
    const b = insertTextClip(p, { at: 2_100_000, duration: 1_500_000, text: 'b' })
    syncToBeats(p, [500_000, 1_000_000, 2_000_000, 3_000_000, 4_000_000], { trackId: text.id })
    expect([a.start, a.duration]).toEqual([500_000, 500_000])
    expect([b.start, b.duration]).toEqual([2_000_000, 1_000_000])
    expect(validateProject(p)).toEqual([])
  })

  it('does not drag a clip to a far beat', () => {
    const p = project()
    const text = p.tracks[1]!
    const a = insertTextClip(p, { at: 0, duration: 1_000_000, text: 'a' })
    const b = insertTextClip(p, { at: 1_000_000, duration: 1_000_000, text: 'b' })
    syncToBeats(p, [900_000], { trackId: text.id })
    // a's start is 900 ms from the beat (> half its length): only its end moves back.
    expect([a.start, a.duration]).toEqual([0, 900_000])
    // b's start is 100 ms from the beat: it moves onto it, keeping its length.
    expect([b.start, b.duration]).toEqual([900_000, 1_000_000])
    expect(validateProject(p)).toEqual([])
  })
})
