import { describe, expect, it } from 'vitest'
import { constant, fromKeyframes } from '../../src/compile/signal.ts'
import { regionCropFilter, snapSpan, warpReach, type ClipMotion } from '../../src/compile/visual.ts'
import type { MediaClip } from '../../src/schema.ts'
import { main, project } from './helpers.ts'

/** A parsed main-track clip with the given overrides. */
const clipWith = (spec: Record<string, unknown>): MediaClip => {
  const p = project([main([{ duration: 1_000_000, ...spec }])])
  const c = p.tracks[0]!.clips[0]
  if (c?.type !== 'video' && c?.type !== 'image') throw new Error('expected a media clip')
  return c
}

describe('regionCropFilter', () => {
  it('is a no-op for the full, uncropped frame', () => {
    expect(regionCropFilter(clipWith({}), { x0: 0, y0: 0, x1: 1, y1: 1 })).toBeUndefined()
  })

  it('keeps the clip crop alone for the full region', () => {
    expect(
      regionCropFilter(clipWith({ crop: { left: 0.1, right: 0.1 } }), {
        x0: 0,
        y0: 0,
        x1: 1,
        y1: 1,
      }),
    ).toBe('crop=w=iw*0.8:h=ih*1:x=iw*0.1:y=ih*0')
  })

  it('folds the region into the clip crop', () => {
    const c = clipWith({ crop: { left: 0.2, top: 0.5 } })
    // left half of the cropped frame: x ∈ [0.2, 0.6] of the source, y ∈ [0.5, 1].
    expect(regionCropFilter(c, { x0: 0, y0: 0, x1: 0.5, y1: 1 })).toBe(
      'crop=w=iw*0.4:h=ih*0.5:x=iw*0.2:y=ih*0.5',
    )
  })

  it('mirrors the region for flips (the crop runs before hflip/vflip)', () => {
    const c = clipWith({ crop: { left: 0.2 }, transform: { flipH: true, flipV: true } })
    // left half AFTER the flip is the right half of the source crop: x ∈ [0.6, 1].
    expect(regionCropFilter(c, { x0: 0, y0: 0, x1: 0.5, y1: 0.25 })).toBe(
      'crop=w=iw*0.4:h=ih*0.25:x=iw*0.6:y=ih*0.75',
    )
  })
})

describe('snapSpan', () => {
  it('covers the fraction with an even whole-pixel span', () => {
    const [o, n] = snapSpan(0.1, 0.6, 1000)
    expect([o, n]).toEqual([100, 500])
    const [o2, n2] = snapSpan(0.1005, 0.6005, 1000)
    expect(o2).toBeLessThanOrEqual(100.5)
    expect(o2 + n2).toBeGreaterThanOrEqual(600.5)
    expect(n2 % 2).toBe(0)
  })

  it('stays inside the axis when rounding up to even', () => {
    // [0, 1] of a 1001.4 px axis: 1001 px is odd and cannot grow → shrinks to 1000.
    expect(snapSpan(0, 1, 1001.4)).toEqual([0, 1000])
    // ending at the edge with an odd size: grows backwards instead.
    expect(snapSpan(0.5, 1, 1001)).toEqual([499, 502])
    expect(snapSpan(0.5, 1, 1001)[0] + snapSpan(0.5, 1, 1001)[1]).toBeLessThanOrEqual(1001)
  })

  it('never returns less than 2 px', () => {
    expect(snapSpan(0.5, 0.5, 100)[1]).toBe(2)
  })
})

describe('warpReach', () => {
  const still = (z: number): ClipMotion => ({
    cx: constant(540),
    cy: constant(960),
    z: constant(z),
    rot: constant(0),
    opacity: constant(1),
  })
  const o = { W: 1080, H: 1920, S: 1, PW: 1296, PH: 2304, q: 1.2 }

  it('is the centred canvas window of a static zoom, padded by 2 px', () => {
    const r = warpReach(still(1.2), { start: 0, frames: 10, head: 0 }, 30, o)
    expect(r.x0).toBeCloseTo((108 - 2) / 1296, 9)
    expect(r.x1).toBeCloseTo((1188 + 2) / 1296, 9)
    expect(r.y0).toBeCloseTo((192 - 2) / 2304, 9)
    expect(r.y1).toBeCloseTo((2112 + 2) / 2304, 9)
  })

  it('unions every frame of a zoom-in (the widest frame wins) and clamps to the frame', () => {
    const m = {
      ...still(1),
      z: fromKeyframes(
        [
          { t: 0, value: 1, easing: 'linear' },
          { t: 1_000_000, value: 1.2, easing: 'linear' },
        ],
        1.2,
      ),
    }
    const r = warpReach(m, { start: 0, frames: 30, head: 0 }, 30, o)
    expect(r).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 })
    // a window starting late in the zoom only reaches the tighter crop.
    const late = warpReach(m, { start: 0, frames: 3, head: 27 }, 30, o)
    expect(late.x0).toBeGreaterThan(0.05)
    expect(late.x1).toBeLessThan(0.95)
  })
})
