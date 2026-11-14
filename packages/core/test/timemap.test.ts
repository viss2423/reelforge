import { describe, expect, it } from 'vitest'
import {
  AudioClip,
  MediaClip,
  clipTimeToSource,
  clipTimeToSourceExact,
  integrateKeyframes,
  sourceRange,
  sourceSpan,
  sourceToClipTime,
  sourceToTimeline,
  speedAt,
  speedProfile,
  timelineToSource,
  type Keyframe,
} from '../src/index.ts'

const video = (o: Record<string, unknown> = {}): MediaClip =>
  MediaClip.parse({
    id: 'v',
    type: 'video',
    assetId: 'a',
    start: 1_000_000,
    duration: 2_000_000,
    in: 500_000,
    ...o,
  })

const kf = (t: number, value: number, easing: Keyframe['easing'] = 'linear'): Keyframe => ({
  t,
  value,
  easing,
})

describe('constant speed mapping', () => {
  it('maps timeline → source with in-point and speed', () => {
    const c = video({ speed: 2 })
    expect(timelineToSource(c, 1_000_000)).toBe(500_000)
    expect(timelineToSource(c, 1_500_000)).toBe(1_500_000)
    expect(timelineToSource(c, 3_000_000)).toBe(4_500_000)
    expect(sourceSpan(c)).toBe(4_000_000)
    expect(sourceRange(c)).toEqual({ start: 500_000, end: 4_500_000 })
  })

  it('clamps timeline times outside the clip to its first/last frame', () => {
    const c = video()
    expect(timelineToSource(c, 0)).toBe(500_000)
    expect(timelineToSource(c, 9_000_000)).toBe(2_500_000)
  })

  it('maps source → timeline and rejects source outside the span', () => {
    const c = video({ speed: 0.5 })
    expect(sourceToTimeline(c, 500_000)).toBe(1_000_000)
    expect(sourceToTimeline(c, 1_000_000)).toBe(2_000_000)
    expect(sourceToTimeline(c, 1_500_000)).toBe(3_000_000)
    expect(sourceToTimeline(c, 400_000)).toBeUndefined()
    expect(sourceToTimeline(c, 1_600_000)).toBeUndefined()
  })

  it('reverse plays the span backwards', () => {
    const c = video({ reverse: true })
    expect(timelineToSource(c, 1_000_000)).toBe(2_500_000)
    expect(timelineToSource(c, 3_000_000)).toBe(500_000)
    expect(sourceToTimeline(c, 2_000_000)).toBe(1_500_000)
  })

  it('audio clips use constant speed (no ramp, no reverse)', () => {
    const a = AudioClip.parse({
      id: 'au',
      type: 'audio',
      assetId: 'x',
      start: 0,
      duration: 1_000_000,
      in: 100,
      speed: 1.5,
    })
    expect(timelineToSource(a, 1_000_000)).toBe(1_500_100)
    expect(sourceToTimeline(a, 1_500_100)).toBe(1_000_000)
    expect(speedAt(a, 0)).toBe(1.5)
  })

  it('images have no source mapping', () => {
    const c = video({ type: 'image' })
    expect(sourceSpan(c)).toBe(c.duration)
    expect(clipTimeToSource(c, 1000)).toBe(c.in)
    expect(sourceToClipTime(c, 0)).toBeUndefined()
  })
})

describe('speed ramps', () => {
  it('a single keyframe acts as a constant multiplier', () => {
    const c = video({ speedRamp: [kf(500_000, 2)] })
    expect(sourceSpan(c)).toBe(4_000_000)
    expect(speedAt(c, 0)).toBe(2)
  })

  it('integrates a linear ramp exactly', () => {
    // r goes 1 → 3 linearly over [0, 2 s]: ∫ = 2 s · (1 + 3)/2 = 4 s.
    const c = video({ speedRamp: [kf(0, 1), kf(2_000_000, 3)] })
    const p = speedProfile(c)
    expect(p.offsetAt(2_000_000)).toBeCloseTo(4_000_000, 6)
    expect(p.offsetAt(1_000_000)).toBeCloseTo(1_500_000, 6)
    expect(p.timeAt(1_500_000)).toBeCloseTo(1_000_000, 4)
    expect(sourceSpan(c)).toBe(4_000_000)
  })

  it('integrates hold segments and extrapolates beyond the ramp', () => {
    const c = video({ speedRamp: [kf(500_000, 2), kf(1_000_000, 0.5, 'hold')] })
    const p = speedProfile(c)
    // [0, .5] at 2 → 1 s; [.5, 1] hold at 2 → 1 s; [1, 2] at .5 → .5 s.
    expect(p.offsetAt(2_000_000)).toBeCloseTo(2_500_000, 6)
    expect(p.timeAt(2_000_000)).toBeCloseTo(1_000_000, 4)
    expect(p.timeAt(500_000)).toBeCloseTo(250_000, 4)
    expect(p.timeAt(2_250_000)).toBeCloseTo(1_500_000, 4)
  })

  it('profile matches numeric integration of speedAt for every easing', () => {
    for (const easing of ['easeIn', 'easeOut', 'easeInOut', 'easeOutBack', 'linear'] as const) {
      const c = video({ speed: 1.5, speedRamp: [kf(200_000, 0.5), kf(1_800_000, 2, easing)] })
      const p = speedProfile(c)
      let numeric = 0
      const steps = 20_000
      const h = c.duration / steps
      for (let i = 0; i < steps; i++) numeric += speedAt(c, (i + 0.5) * h) * h
      expect(p.offsetAt(c.duration) / numeric).toBeCloseTo(1, 5)
    }
  })

  it('timeAt inverts offsetAt across all segments and easings', () => {
    for (const easing of [
      'easeIn',
      'easeOut',
      'easeInOut',
      'easeOutBack',
      'linear',
      'hold',
    ] as const) {
      const c = video({
        speedRamp: [kf(100_000, 0.4), kf(700_000, 3, easing), kf(1_500_000, 1, easing)],
      })
      const p = speedProfile(c)
      for (let tau = 0; tau <= c.duration; tau += 37_000) {
        expect(p.timeAt(p.offsetAt(tau))).toBeCloseTo(tau, 0)
      }
    }
  })

  it('linear segments with equal values use the constant branch', () => {
    const c = video({ speedRamp: [kf(0, 2), kf(1_000_000, 2)] })
    const p = speedProfile(c)
    expect(p.timeAt(1_000_000)).toBeCloseTo(500_000, 6)
  })

  it('round-trips source → timeline → source through ramp + reverse', () => {
    const c = video({
      reverse: true,
      speed: 1.25,
      speedRamp: [kf(0, 0.5), kf(2_000_000, 2.5, 'easeInOut')],
    })
    const range = sourceRange(c)
    for (let s = range.start; s <= range.end; s += 97_331) {
      const t = sourceToTimeline(c, s)!
      expect(t).toBeDefined()
      expect(Math.abs(timelineToSource(c, t) - s)).toBeLessThanOrEqual(4)
    }
  })

  it('clipTimeToSourceExact agrees with the ramp integral', () => {
    const ramp = [kf(0, 1), kf(2_000_000, 2, 'easeIn')]
    const c = video({ speedRamp: ramp })
    expect(clipTimeToSourceExact(c, 1_000_000) - c.in).toBeCloseTo(
      integrateKeyframes(ramp, 0, 1_000_000, 1),
      3,
    )
  })
})
