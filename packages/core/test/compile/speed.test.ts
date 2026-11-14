import { describe, expect, it } from 'vitest'
import type { Keyframe } from '../../src/schema.ts'
import {
  audioRampSegments,
  sliceSpeedMap,
  sourceAt,
  speedMap,
  tempoFilters,
  videoSpeedFilter,
} from '../../src/compile/speed.ts'
import { sourceWindow } from '../../src/compile/visual.ts'
import { evalExpr } from './helpers.ts'

const ramp: Keyframe[] = [
  { t: 0, value: 1, easing: 'linear' },
  { t: 1_000_000, value: 3, easing: 'linear' },
  { t: 2_000_000, value: 0.5, easing: 'easeInOut' },
]

describe('speedMap', () => {
  it('constant speed consumes duration × speed of source', () => {
    const m = speedMap({ duration: 2_000_000, speed: 2, speedRamp: [] })
    expect(m.constant).toBe(2)
    expect(m.sourceSpan).toBe(4_000_000)
    expect(m.segments).toEqual([{ t0: 0, t1: 2_000_000, s0: 0, s1: 4_000_000 }])
  })

  it('a flat ramp multiplies the clip speed', () => {
    const m = speedMap({
      duration: 1_000_000,
      speed: 2,
      speedRamp: [{ t: 0, value: 0.5, easing: 'linear' }],
    })
    expect(m.constant).toBe(1)
    expect(m.sourceSpan).toBe(1_000_000)
  })

  it('a ramp integrates speed over time', () => {
    const m = speedMap({ duration: 2_000_000, speed: 1, speedRamp: ramp })
    expect(m.constant).toBeUndefined()
    // ∫ linear 1→3 over 1 s = 2 s; ∫ easeInOut 3→0.5 over 1 s = 1.75 s (symmetric curve).
    expect(m.sourceSpan / 1e6).toBeCloseTo(3.75, 3)
    // Monotonic, contiguous segments.
    for (let i = 1; i < m.segments.length; i++) {
      expect(m.segments[i]!.t0).toBe(m.segments[i - 1]!.t1)
      expect(m.segments[i]!.s0).toBeCloseTo(m.segments[i - 1]!.s1, 6)
      expect(m.segments[i]!.s1).toBeGreaterThan(m.segments[i]!.s0)
    }
    expect(m.segments.length).toBeLessThanOrEqual(50)
  })

  it('sourceAt interpolates the mapping', () => {
    const m = speedMap({ duration: 2_000_000, speed: 1, speedRamp: ramp })
    expect(sourceAt(m, 0)).toBe(0)
    expect(sourceAt(m, 500_000) / 1e6).toBeCloseTo(0.75, 2)
    expect(sourceAt(m, 1_000_000) / 1e6).toBeCloseTo(2, 2)
    expect(sourceAt(m, 9e9)).toBeCloseTo(m.segments.at(-1)!.s1, 6)
  })

  it('sliceSpeedMap rebases a window of the mapping', () => {
    const m = speedMap({ duration: 2_000_000, speed: 1, speedRamp: ramp })
    const s = sliceSpeedMap(m, 500_000, 1_500_000)
    expect(s.segments[0]!.t0).toBe(0)
    expect(s.segments[0]!.s0).toBeCloseTo(0, 6)
    expect(s.segments.at(-1)!.t1).toBe(1_000_000)
    expect(s.sourceSpan).toBe(Math.round(sourceAt(m, 1_500_000) - sourceAt(m, 500_000)))
    const c = sliceSpeedMap(speedMap({ duration: 4_000_000, speed: 2, speedRamp: [] }), 1e6, 2e6)
    expect(c).toEqual({
      sourceSpan: 2_000_000,
      constant: 2,
      segments: [{ t0: 0, t1: 1_000_000, s0: 0, s1: 2_000_000 }],
    })
  })
})

describe('videoSpeedFilter', () => {
  it('is omitted at speed 1 and a simple setpts otherwise', () => {
    expect(videoSpeedFilter(speedMap({ duration: 1, speed: 1, speedRamp: [] }))).toBeUndefined()
    expect(videoSpeedFilter(speedMap({ duration: 1e6, speed: 4, speedRamp: [] }))).toBe(
      'setpts=(PTS-STARTPTS)/4',
    )
  })

  it('ramps map source time to timeline time with a piecewise expression', () => {
    const m = speedMap({ duration: 2_000_000, speed: 1, speedRamp: ramp })
    const f = videoSpeedFilter(m)!
    expect(f.startsWith('setpts=expr=')).toBe(true)
    const expr = f.slice('setpts=expr='.length).replace(/^'|'$/g, '')
    // Inverse check: source position s → timeline t should invert sourceAt.
    for (const t of [0, 250_000, 900_000, 1_400_000, 1_999_000]) {
      const s = sourceAt(m, t) / 1e6
      const out = evalExpr(expr, { T: s, STARTT: 0, TB: 1 })
      expect(out).toBeCloseTo(t / 1e6, 3)
    }
  })
})

describe('tempoFilters', () => {
  const product = (fs: string[]): number =>
    fs.reduce((acc, f) => acc * Number(/atempo=([\d.]+)/.exec(f)![1]), 1)

  it('chains atempo stages within FFmpeg limits', () => {
    expect(tempoFilters(1, true, false)).toEqual([])
    expect(tempoFilters(2, true, false)).toEqual(['atempo=2'])
    const slow = tempoFilters(0.1, true, false)
    expect(slow.every((f) => Number(f.split('=')[1]) >= 0.5)).toBe(true)
    expect(product(slow)).toBeCloseTo(0.1, 9)
    expect(product(tempoFilters(16, true, false))).toBeCloseTo(16, 9)
  })

  it('uses rubberband for high quality pitch preservation', () => {
    expect(tempoFilters(0.5, true, true)).toEqual(['rubberband=tempo=0.5'])
  })

  it('resamples (tape-style) when pitch is not preserved', () => {
    expect(tempoFilters(2, false, true)).toEqual(['asetrate=96000', 'aresample=48000'])
  })
})

describe('audioRampSegments', () => {
  it('merges ramp segments down to the cap, preserving the total', () => {
    const m = speedMap({ duration: 4_800_000, speed: 1, speedRamp: ramp })
    const segs = audioRampSegments(m, 6)
    expect(segs.length).toBeLessThanOrEqual(6)
    expect(segs[0]!.t0).toBe(0)
    expect(segs.at(-1)!.t1).toBe(4_800_000)
    expect(segs.at(-1)!.s1).toBeCloseTo(m.segments.at(-1)!.s1, 6)
    expect(audioRampSegments(speedMap({ duration: 1, speed: 1, speedRamp: [] }))).toHaveLength(1)
  })
})

describe('sourceWindow', () => {
  const clip = { in: 1_000_000, duration: 2_000_000, speed: 2, speedRamp: [], reverse: false }

  it('reads from the in-point forward', () => {
    expect(sourceWindow(clip, 0, 2_000_000)).toMatchObject({ start: 1_000_000, span: 4_000_000 })
    expect(sourceWindow(clip, 500_000, 1_000_000)).toMatchObject({
      start: 2_000_000,
      span: 2_000_000,
    })
  })

  it('reads the mirrored source range when reversed', () => {
    // Reversed clip: timeline head shows the END of the source span.
    const r = { ...clip, reverse: true }
    expect(sourceWindow(r, 0, 1_000_000)).toMatchObject({ start: 3_000_000, span: 2_000_000 })
    expect(sourceWindow(r, 1_000_000, 1_000_000)).toMatchObject({
      start: 1_000_000,
      span: 2_000_000,
    })
  })
})
