import { describe, expect, it } from 'vitest'
import { image, video } from '../test/model.ts'
import { sourceRateAt, sourceTimeAt } from './sourceTime.ts'

const S = 1_000_000

describe('sourceTimeAt', () => {
  it('re-bases clip-local time onto clip.start (independent of the rendered start)', () => {
    // a main clip whose model start is 5 s but which renders from 4.5 s (transition overlap)
    const c = video({ start: 5 * S, duration: 2 * S, in: S })
    expect(sourceTimeAt(c, 0)).toBe(S)
    expect(sourceTimeAt(c, 500_000)).toBe(1_500_000)
    expect(sourceTimeAt(c, 2 * S)).toBe(3 * S)
  })

  it('clamps local time to the clip and rounds to integer microseconds', () => {
    const c = video({ duration: S, in: 2 * S })
    expect(sourceTimeAt(c, -40_000)).toBe(2 * S)
    expect(sourceTimeAt(c, 5 * S)).toBe(3 * S)
    expect(Number.isInteger(sourceTimeAt(c, 333.7))).toBe(true)
  })

  it('applies speed and reverse', () => {
    const fast = video({ duration: S, in: S, speed: 2 })
    expect(sourceTimeAt(fast, 250_000)).toBe(1_500_000)
    const rev = video({ duration: S, in: 0, reverse: true })
    expect(sourceTimeAt(rev, 0)).toBe(S)
    expect(sourceTimeAt(rev, S)).toBe(0)
  })

  it('images always show their single frame', () => {
    expect(sourceTimeAt(image({ in: 0 }), 700_000)).toBe(0)
  })
})

describe('sourceRateAt', () => {
  it('is the signed source rate, including reverse and edges', () => {
    expect(sourceRateAt(video({ duration: S }), 500_000)).toBeCloseTo(1, 6)
    expect(sourceRateAt(video({ duration: S, speed: 0.5 }), 0)).toBeCloseTo(0.5, 3)
    expect(sourceRateAt(video({ duration: S, speed: 3, reverse: true }), S)).toBeCloseTo(-3, 3)
  })

  it('falls back to the nominal speed for degenerate windows; images are static', () => {
    expect(sourceRateAt(video({ duration: S, speed: 2 }), 0, 0)).toBe(2)
    expect(sourceRateAt(video({ duration: S, speed: 2, reverse: true }), 0, 0)).toBe(-2)
    expect(sourceRateAt(image(), 100)).toBe(0)
  })
})
