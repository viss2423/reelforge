import { sec } from '@reelforge/core'
import { describe, expect, it } from 'vitest'
import {
  anchoredScroll,
  autoScrollSpeed,
  clampGroupDelta,
  clampTrim,
  freeNeighbours,
  pinchZoom,
  reorderBoundary,
  reorderIndex,
  reorderLayout,
  sourceHeadroom,
  trimRange,
  wheelPixels,
  wheelZoomFactor,
  type TrimLimits,
} from '@/editor/timeline/dragMath.ts'
import { pxPerUs, timeToX, trackSpans, xToTime } from '@/editor/timeline/geometry.ts'
import { clip, mainClips, track } from './helpers.ts'

describe('reorderIndex', () => {
  const d = [sec(2), sec(2), sec(2)] // clips at 0-2, 2-4, 4-6

  it('counts the other clips whose original midpoint is before the pointer', () => {
    // Midpoints 1, 3, 5. Dragging clip 0.
    expect(reorderIndex(d, 0, sec(0.5))).toBe(0)
    expect(reorderIndex(d, 0, sec(1.5))).toBe(0)
    expect(reorderIndex(d, 0, sec(3.5))).toBe(1)
    expect(reorderIndex(d, 0, sec(5.5))).toBe(2)
    expect(reorderIndex(d, 0, sec(99))).toBe(2)
    expect(reorderIndex(d, 0, -sec(5))).toBe(0)
  })

  it('is stable over the dragged clip slot (no oscillation from the opening gap)', () => {
    for (const t of [2.1, 2.5, 3.3, 4.9]) expect(reorderIndex(d, 1, sec(t))).toBe(1)
    expect(reorderIndex(d, 1, sec(5.1))).toBe(2)
    expect(reorderIndex(d, 1, sec(1.1))).toBe(1)
    // At or before a neighbour's midpoint the clip goes before it.
    expect(reorderIndex(d, 1, sec(1))).toBe(0)
  })

  it('treats dragIndex -1 as an external clip (insert into the full list)', () => {
    expect(reorderIndex(d, -1, sec(2.9))).toBe(1)
    expect(reorderIndex(d, -1, sec(3.1))).toBe(2)
    expect(reorderIndex([], -1, sec(1))).toBe(0)
  })

  it('reorderBoundary gives the indicator time in the collapsed layout', () => {
    expect(reorderBoundary(d, 0, 0)).toBe(0)
    expect(reorderBoundary(d, 0, 1)).toBe(sec(2))
    expect(reorderBoundary(d, 0, 2)).toBe(sec(4))
    expect(reorderBoundary(d, -1, 3)).toBe(sec(6))
  })

  it('reorderLayout previews starts by original index', () => {
    const clips = mainClips(1, 2, 3)
    // Move clip 0 to the end: order 1, 2, 0.
    expect([...reorderLayout(clips, 0, 2)]).toEqual([sec(5), 0, sec(2)])
    // No-op move keeps the layout.
    expect([...reorderLayout(clips, 1, 1)]).toEqual([0, sec(1), sec(3)])
    // Out-of-range index is clamped.
    expect([...reorderLayout(clips, 2, 99)]).toEqual([0, sec(1), sec(3)])
  })
})

describe('sourceHeadroom', () => {
  const asset = { duration: sec(10) }

  it('bounds video by the in-point and the remaining source', () => {
    const c = clip('video', 0, sec(4), { in: sec(2) })
    expect(sourceHeadroom(c, asset)).toEqual({ before: sec(2), after: sec(4) })
  })

  it('scales by speed', () => {
    const c = clip('video', 0, sec(2), { in: sec(2), speed: 2 })
    // Source used 2..6; 2 s before (1 s timeline), 4 s after (2 s timeline).
    expect(sourceHeadroom(c, asset)).toEqual({ before: sec(1), after: sec(2) })
  })

  it('mirrors reversed clips', () => {
    const c = clip('video', 0, sec(4), { in: sec(1), reverse: true })
    // Source 1..5 played backwards: the head extends towards 10 s, the tail towards 0.
    expect(sourceHeadroom(c, asset)).toEqual({ before: sec(5), after: sec(1) })
  })

  it('is unbounded for images, text and stickers, and at an unknown asset tail', () => {
    expect(sourceHeadroom(clip('image', 0, sec(1)), undefined)).toEqual({
      before: Infinity,
      after: Infinity,
    })
    expect(sourceHeadroom(clip('text', 0, sec(1)), undefined).after).toBe(Infinity)
    const a = clip('audio', 0, sec(1), { in: sec(3) })
    expect(sourceHeadroom(a, undefined)).toEqual({ before: sec(3), after: Infinity })
  })

  it('leaves the tail to core for speed ramps', () => {
    const c = clip('video', 0, sec(2), {
      in: sec(1),
      speedRamp: [
        { t: 0, value: 2 },
        { t: sec(2), value: 0.5 },
      ],
    })
    const h = sourceHeadroom(c, asset)
    expect(h.before).toBe(sec(0.5)) // 1 s of source at the 2× head rate
    expect(h.after).toBe(Infinity)
  })
})

describe('trim limits', () => {
  const base: TrimLimits = {
    edge: 'end',
    start: sec(2),
    end: sec(4),
    minDuration: 33_333,
    lo: sec(1),
    hi: sec(5),
    headroom: { before: sec(3), after: sec(3) },
  }

  it('end edge: at least one frame, at most the next clip or source', () => {
    expect(trimRange(base)).toEqual({ min: sec(2) + 33_333, max: sec(5) })
    expect(clampTrim(sec(9), base)).toBe(sec(5))
    expect(clampTrim(0, base)).toBe(sec(2) + 33_333)
    expect(trimRange({ ...base, hi: Infinity, headroom: { before: 0, after: sec(0.5) } }).max).toBe(
      sec(4.5),
    )
  })

  it('start edge: bounded by the previous clip and the source head', () => {
    const l = { ...base, edge: 'start' as const }
    expect(trimRange(l)).toEqual({ min: sec(1), max: sec(4) - 33_333 })
    expect(clampTrim(-sec(5), { ...l, lo: -Infinity })).toBe(-sec(1))
    expect(clampTrim(sec(3), l)).toBe(sec(3))
  })

  it('never inverts the range when headroom is zero', () => {
    const l = { ...base, headroom: { before: 0, after: 0 } }
    expect(trimRange(l)).toEqual({ min: sec(2) + 33_333, max: sec(4) })
    const s = trimRange({ ...l, edge: 'start' })
    expect(s.min).toBe(sec(2))
    expect(s.max).toBe(sec(4) - 33_333)
  })

  it('freeNeighbours reads the previous end and next start', () => {
    const t = track('overlay', [
      clip('video', 0, sec(1)),
      clip('video', sec(2), sec(1)),
      clip('video', sec(5), sec(1)),
    ])
    const s = trackSpans(t)
    expect(freeNeighbours(s, 0)).toEqual({ lo: 0, hi: sec(2) })
    expect(freeNeighbours(s, 1)).toEqual({ lo: sec(1), hi: sec(5) })
    expect(freeNeighbours(s, 2)).toEqual({ lo: sec(3), hi: Infinity })
  })
})

describe('moves and zoom', () => {
  it('clampGroupDelta keeps every clip at or after 0', () => {
    expect(clampGroupDelta([sec(1), sec(3)], -sec(2))).toBe(-sec(1))
    expect(clampGroupDelta([sec(1)], sec(2))).toBe(sec(2))
    expect(clampGroupDelta([], -5)).toBe(-5)
  })

  it('pinchZoom scales with finger distance and clamps', () => {
    expect(pinchZoom(100, 100, 200, 8, 2400)).toBe(200)
    expect(pinchZoom(100, 100, 10, 8, 2400)).toBe(10)
    expect(pinchZoom(100, 100, 1, 8, 2400)).toBe(8)
    expect(pinchZoom(2000, 100, 300, 8, 2400)).toBe(2400)
    expect(pinchZoom(100, 0, 50, 8, 2400)).toBe(100)
  })

  it('anchoredScroll keeps the gesture anchor time under the fingers', () => {
    const anchorT = sec(7.3)
    for (const zoom of [20, 120, 900]) {
      const ppu = pxPerUs(zoom)
      const scroll = anchoredScroll(anchorT, ppu, 250)
      expect(xToTime(scroll + 250, ppu)).toBeCloseTo(anchorT, 3)
    }
    // Fingers pan right by 40 px: the content follows.
    const ppu = pxPerUs(120)
    expect(anchoredScroll(anchorT, ppu, 290)).toBeCloseTo(timeToX(anchorT, ppu) - 290)
  })

  it('wheelPixels normalises line and page deltas', () => {
    expect(wheelPixels(3, 0, 800)).toBe(3)
    expect(wheelPixels(3, 1, 800)).toBe(48)
    expect(wheelPixels(1, 2, 800)).toBe(800)
  })

  it('wheelZoomFactor zooms in for negative deltas and caps big notches', () => {
    expect(wheelZoomFactor(-10)).toBeGreaterThan(1)
    expect(wheelZoomFactor(10)).toBeLessThan(1)
    expect(wheelZoomFactor(0)).toBe(1)
    expect(wheelZoomFactor(-1000)).toBe(wheelZoomFactor(-60))
    expect(wheelZoomFactor(100) * wheelZoomFactor(-100)).toBeCloseTo(1)
  })

  it('autoScrollSpeed ramps quadratically in the edge zones', () => {
    expect(autoScrollSpeed(500, 1000, 50, 20)).toBe(0)
    expect(autoScrollSpeed(0, 1000, 50, 20)).toBe(-20)
    expect(autoScrollSpeed(-30, 1000, 50, 20)).toBe(-20)
    expect(autoScrollSpeed(25, 1000, 50, 20)).toBe(-5)
    expect(autoScrollSpeed(1000, 1000, 50, 20)).toBe(20)
    expect(autoScrollSpeed(975, 1000, 50, 20)).toBe(5)
    expect(autoScrollSpeed(10, 80, 50, 20)).toBe(0) // too narrow for edge zones
  })
})
