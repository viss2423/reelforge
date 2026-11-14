import { describe, expect, it } from 'vitest'
import {
  clipWindow,
  frameSpan,
  frameToUs,
  renderDuration,
  renderLayout as mainTrackLayout,
  renderWindow,
  usToFrame,
} from '../../src/compile/layout.ts'
import { MIN_TRANSITION, effectiveOverlap } from '../../src/ops/project.ts'
import { main, project } from './helpers.ts'

describe('mainTrackLayout (transition overlap semantics)', () => {
  it('contiguous clips without transitions keep their model positions', () => {
    const p = project([main([{ duration: 1_000_000 }, { duration: 2_000_000 }])])
    const l = mainTrackLayout(p)
    expect(l.items.map((i) => [i.start, i.end, i.overlap])).toEqual([
      [0, 1_000_000, 0],
      [1_000_000, 3_000_000, 0],
    ])
    expect(l.duration).toBe(3_000_000)
  })

  it('each transition pulls the incoming clip (and everything after) earlier', () => {
    const p = project([
      main([
        { duration: 2_000_000 },
        { duration: 2_000_000, transitionIn: { type: 'fade', duration: 500_000 } },
        { duration: 1_000_000, transitionIn: { type: 'wipeleft', duration: 250_000 } },
      ]),
    ])
    const l = mainTrackLayout(p)
    expect(l.items.map((i) => [i.start, i.end, i.overlap])).toEqual([
      [0, 2_000_000, 0],
      [1_500_000, 3_500_000, 500_000],
      [3_250_000, 4_250_000, 250_000],
    ])
    // total = Σ durations − Σ transitions
    expect(l.duration).toBe(5_000_000 - 750_000)
    expect(renderDuration(p, l)).toBe(4_250_000)
  })

  it('ignores a transition on the first clip', () => {
    const p = project([
      {
        kind: 'main',
        clips: [
          {
            id: 'a',
            type: 'video',
            assetId: 'land',
            start: 0,
            duration: 1_000_000,
            transitionIn: { type: 'fade', duration: 400_000 },
          },
          { id: 'b', type: 'video', assetId: 'land', start: 1_000_000, duration: 1_000_000 },
        ],
      },
    ])
    const l = mainTrackLayout(p)
    expect(l.items.map((i) => i.clip.id)).toEqual(['a', 'b'])
    expect(l.items[0]!.overlap).toBe(0)
  })

  it('clamps overlaps to half of either clip and drops sub-minimum ones', () => {
    const p = project([
      main([
        { duration: 600_000 },
        { duration: 3_000_000, transitionIn: { type: 'fade', duration: 3_000_000 } },
        { duration: 80_000, transitionIn: { type: 'fade', duration: 1_000_000 } },
      ]),
    ])
    const [a, b, c] = mainTrackLayout(p).items
    expect(b!.overlap).toBe(300_000)
    // min(80_000, 3_000_000)/2 = 40_000 < MIN_TRANSITION → hard cut.
    expect(c!.overlap).toBe(0)
    expect(MIN_TRANSITION).toBe(50_000)
    expect(effectiveOverlap(b!.clip.transitionIn, undefined, b!.clip.duration)).toBe(0)
    expect(effectiveOverlap(b!.clip.transitionIn, a!.clip.duration, b!.clip.duration)).toBe(300_000)
  })

  it('handles projects without a main track; other tracks extend the duration', () => {
    const p = project([
      {
        kind: 'audio',
        clips: [{ id: 'a', type: 'audio', assetId: 'music', start: 500_000, duration: 2_000_000 }],
      },
    ])
    const l = mainTrackLayout(p)
    expect(l.track).toBeUndefined()
    expect(l.items).toEqual([])
    expect(renderDuration(p)).toBe(2_500_000)
  })
})

describe('frame mapping', () => {
  it('rounds to the nearest frame and back', () => {
    expect(usToFrame(1_000_000, 30)).toBe(30)
    expect(usToFrame(16_667, 30)).toBe(1)
    expect(usToFrame(16_666, 30)).toBe(0)
    expect(frameToUs(1, 30)).toBe(33_333)
    expect(frameToUs(3, 24)).toBe(125_000)
  })

  it('frameSpan always covers at least one frame', () => {
    expect(frameSpan(0, 1, 30)).toEqual({ start: 0, end: 1 })
    expect(frameSpan(1_000_000, 500_000, 30)).toEqual({ start: 30, end: 45 })
  })

  it('renderWindow clamps the range to the project', () => {
    expect(renderWindow(10_000_000, undefined, 30)).toEqual({ start: 0, end: 300 })
    expect(renderWindow(10_000_000, { start: 1_000_000, end: 2_500_000 }, 30)).toEqual({
      start: 30,
      end: 75,
    })
    expect(renderWindow(1_000_000, { start: 2_000_000, end: 3_000_000 }, 30)).toEqual({
      start: 30,
      end: 30,
    })
    expect(renderWindow(1_000_000, { start: 500_000, end: 100_000 }, 30)).toEqual({
      start: 15,
      end: 15,
    })
  })

  it('clipWindow intersects and reports the cut head', () => {
    expect(clipWindow({ start: 10, end: 50 }, { start: 0, end: 100 })).toEqual({
      start: 10,
      frames: 40,
      head: 0,
    })
    expect(clipWindow({ start: 10, end: 50 }, { start: 30, end: 40 })).toEqual({
      start: 30,
      frames: 10,
      head: 20,
    })
    expect(clipWindow({ start: 10, end: 50 }, { start: 50, end: 60 })).toBeUndefined()
  })
})
