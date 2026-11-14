import { describe, expect, it } from 'vitest'
import {
  AnimationPreset,
  BUILTIN_ANIMATIONS,
  Easing,
  IDENTITY_PROPS,
  characterReveal,
  composeProps,
  ease,
  easeIntegral,
  evaluate,
  evaluateKeyframes,
  evaluatePreset,
  integrateKeyframes,
  isAnimated,
  keyframeIndexAt,
  presetProgress,
  resolveBuiltinAnimation,
  type Keyframe,
} from '../src/index.ts'

const EASINGS = Easing.options

describe('ease', () => {
  it.each(EASINGS.filter((e) => e !== 'hold'))('%s maps 0→0 and 1→1', (e) => {
    expect(ease(e, 0)).toBeCloseTo(0, 12)
    expect(ease(e, 1)).toBeCloseTo(1, 12)
  })

  it('clamps progress outside 0..1', () => {
    for (const e of EASINGS) {
      expect(ease(e, -3)).toBe(ease(e, 0))
      expect(ease(e, 7)).toBe(ease(e, 1))
    }
  })

  it('has the expected shapes', () => {
    expect(ease('linear', 0.3)).toBe(0.3)
    expect(ease('easeIn', 0.5)).toBeCloseTo(0.125)
    expect(ease('easeOut', 0.5)).toBeCloseTo(0.875)
    expect(ease('easeInOut', 0.5)).toBeCloseTo(0.5)
    expect(ease('easeInOut', 0.25)).toBeCloseTo(0.0625)
    expect(ease('easeInOut', 0.75)).toBeCloseTo(0.9375)
    expect(ease('hold', 0.999)).toBe(0)
    expect(ease('hold', 1)).toBe(1)
  })

  it('easeOutBack overshoots above 1 and easeOutElastic oscillates around 1', () => {
    const back = Array.from({ length: 99 }, (_, i) => ease('easeOutBack', (i + 1) / 100))
    expect(Math.max(...back)).toBeGreaterThan(1.05)
    const elastic = Array.from({ length: 99 }, (_, i) => ease('easeOutElastic', (i + 1) / 100))
    expect(Math.max(...elastic)).toBeGreaterThan(1)
    expect(Math.min(...elastic.slice(10))).toBeLessThan(1)
  })

  it('monotone easings are non-decreasing', () => {
    for (const e of ['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold'] as const) {
      let prev = -Infinity
      for (let i = 0; i <= 200; i++) {
        const v = ease(e, i / 200)
        expect(v).toBeGreaterThanOrEqual(prev)
        prev = v
      }
    }
  })
})

describe('easeIntegral', () => {
  const numeric = (e: Easing, a: number, b: number) => {
    const n = 20_000
    const h = (b - a) / n
    let s = 0
    for (let i = 0; i < n; i++) s += ease(e, a + (i + 0.5) * h)
    return s * h
  }
  it.each(EASINGS)('%s matches numeric integration', (e) => {
    expect(easeIntegral(e, 0, 1)).toBeCloseTo(numeric(e, 0, 1), 5)
    expect(easeIntegral(e, 0.2, 0.7)).toBeCloseTo(numeric(e, 0.2, 0.7), 5)
    expect(easeIntegral(e, 0.55, 0.95)).toBeCloseTo(numeric(e, 0.55, 0.95), 5)
  })
  it('is zero for empty or reversed intervals', () => {
    expect(easeIntegral('linear', 0.5, 0.5)).toBe(0)
    expect(easeIntegral('linear', 0.7, 0.2)).toBe(0)
  })
})

describe('evaluateKeyframes', () => {
  const kf = (t: number, value: number, easing: Easing = 'linear'): Keyframe => ({
    t,
    value,
    easing,
  })

  it('returns the fallback for an empty list', () => {
    expect(evaluateKeyframes([], 123, 42)).toBe(42)
  })

  it('holds before the first and after the last keyframe', () => {
    const k = [kf(100, 1), kf(200, 3)]
    expect(evaluateKeyframes(k, 0, 9)).toBe(1)
    expect(evaluateKeyframes(k, 100, 9)).toBe(1)
    expect(evaluateKeyframes(k, 200, 9)).toBe(3)
    expect(evaluateKeyframes(k, 10_000, 9)).toBe(3)
  })

  it('uses the easing of the ARRIVING keyframe', () => {
    const k = [kf(0, 0, 'hold'), kf(100, 10, 'easeIn')]
    expect(evaluateKeyframes(k, 50, 0)).toBeCloseTo(10 * ease('easeIn', 0.5))
    const k2 = [kf(0, 0, 'easeIn'), kf(100, 10, 'linear')]
    expect(evaluateKeyframes(k2, 50, 0)).toBeCloseTo(5)
  })

  it('hold is a step at the next keyframe', () => {
    const k = [kf(0, 1), kf(100, 5, 'hold'), kf(200, 9)]
    expect(evaluateKeyframes(k, 99.999, 0)).toBe(1)
    expect(evaluateKeyframes(k, 100, 0)).toBe(5)
    expect(evaluateKeyframes(k, 150, 0)).toBeCloseTo(7)
  })

  it('binary search agrees with a linear scan on many keyframes', () => {
    const k = Array.from({ length: 500 }, (_, i) => kf(i * 10, Math.sin(i)))
    for (let t = -5; t < 5010; t += 7.3) {
      let i = -1
      for (let j = 0; j < k.length; j++) if (k[j]!.t <= t) i = j
      expect(keyframeIndexAt(k, t)).toBe(i)
    }
  })

  it('evaluate() uses Animatable.value when there are no keyframes', () => {
    expect(evaluate({ value: 7, keyframes: [] }, 1000)).toBe(7)
    expect(evaluate({ value: 7, keyframes: [kf(0, 1), kf(10, 2)] }, 5)).toBeCloseTo(1.5)
    expect(isAnimated({ value: 1, keyframes: [kf(0, 1)] })).toBe(false)
    expect(isAnimated({ value: 1, keyframes: [kf(0, 1), kf(5, 2)] })).toBe(true)
  })
})

describe('integrateKeyframes', () => {
  const numeric = (k: Keyframe[], a: number, b: number, fb: number) => {
    const n = 50_000
    const h = (b - a) / n
    let s = 0
    for (let i = 0; i < n; i++) s += evaluateKeyframes(k, a + (i + 0.5) * h, fb)
    return s * h
  }
  it('matches numeric integration across segments, holds and extrapolation', () => {
    const k: Keyframe[] = [
      { t: 100, value: 1, easing: 'linear' },
      { t: 300, value: 3, easing: 'easeInOut' },
      { t: 400, value: 0.5, easing: 'hold' },
      { t: 700, value: 2, easing: 'easeOutElastic' },
      { t: 900, value: 1, easing: 'easeOutBack' },
    ]
    for (const [a, b] of [
      [0, 1000],
      [150, 650],
      [320, 380],
      [0, 50],
      [950, 1200],
    ] as const) {
      expect(integrateKeyframes(k, a, b, 1)).toBeCloseTo(numeric(k, a, b, 1), 1)
    }
  })
  it('handles empty lists and empty intervals', () => {
    expect(integrateKeyframes([], 0, 10, 2)).toBe(20)
    expect(integrateKeyframes([], 10, 10, 2)).toBe(0)
  })
})

describe('presets', () => {
  const fade = resolveBuiltinAnimation('builtin/fade')!

  it('evaluatePreset returns identity for missing tracks and clamps progress', () => {
    const empty = AnimationPreset.parse({ id: 'x', name: 'x', kind: 'in', tracks: {} })
    expect(evaluatePreset(empty, 0.5)).toEqual(IDENTITY_PROPS)
    expect(evaluatePreset(fade, -1).opacity).toBe(0)
    expect(evaluatePreset(fade, 2).opacity).toBe(1)
  })

  it('composeProps multiplies opacity/scale and adds offsets', () => {
    const out = { ...IDENTITY_PROPS }
    composeProps(
      out,
      { opacity: 0.5, scale: 2, x: 1, y: 2, rotation: 3 },
      { opacity: 0.5, scale: 3, x: 1, y: 1, rotation: 1 },
    )
    expect(out).toEqual({ opacity: 0.25, scale: 6, x: 2, y: 3, rotation: 4 })
  })

  it('presetProgress covers in/out/loop slots and plays opposite-kind presets backwards', () => {
    expect(presetProgress(fade, 'in', 400, 2000, 0)).toBe(0)
    expect(presetProgress(fade, 'in', 400, 2000, 200)).toBe(0.5)
    expect(presetProgress(fade, 'in', 400, 2000, 400)).toBeUndefined()
    // An in-preset used as out-animation runs backwards over the last 400 µs.
    expect(presetProgress(fade, 'out', 400, 2000, 1500)).toBeUndefined()
    expect(presetProgress(fade, 'out', 400, 2000, 1600)).toBe(1)
    expect(presetProgress(fade, 'out', 400, 2000, 1800)).toBe(0.5)
    expect(presetProgress(fade, 'out', 400, 2000, 2000)).toBe(0)
    const outKind = { kind: 'out' as const }
    expect(presetProgress(outKind, 'in', 400, 2000, 100)).toBe(0.75)
    expect(presetProgress(outKind, 'out', 400, 2000, 1700)).toBe(0.25)
    expect(presetProgress(fade, 'loop', 400, 2000, 900)).toBe(0.25)
    // Durations longer than the clip are clamped; zero-length clips have no animation.
    expect(presetProgress(fade, 'in', 4000, 1000, 500)).toBe(0.5)
    expect(presetProgress(fade, 'in', 400, 0, 0)).toBeUndefined()
  })

  it('characterReveal reveals characters sequentially for per-character presets', () => {
    const tw = resolveBuiltinAnimation('builtin/typewriter')!
    expect(characterReveal(tw, 0, 4, 0.2)).toBe(0)
    expect(characterReveal(tw, 0, 4, 0.25)).toBe(1)
    expect(characterReveal(tw, 3, 4, 0.99)).toBe(0)
    expect(characterReveal(tw, 3, 4, 1)).toBe(1)
    expect(characterReveal(fade, 0, 4, 0)).toBe(1)
    expect(characterReveal(tw, 0, 0, 0)).toBe(1)
    const noTrack = AnimationPreset.parse({
      id: 'n',
      name: 'n',
      kind: 'in',
      perCharacter: true,
      tracks: {},
    })
    expect(characterReveal(noTrack, 1, 2, 0.6)).toBe(0)
    expect(characterReveal(noTrack, 1, 2, 1)).toBe(1)
    // Per-character presets keep the block opaque.
    expect(evaluatePreset(tw, 0).opacity).toBe(1)
  })
})

describe('builtin animations', () => {
  const ids = [
    'fade',
    'pop',
    'slideUp',
    'slideDown',
    'slideLeft',
    'slideRight',
    'zoomIn',
    'zoomOut',
    'typewriter',
    'bounce',
    'shake',
    'pulse',
    'spin',
    'blurIn',
    'wipe',
  ]

  it('ships every builtin id, each a valid AnimationPreset', () => {
    expect(BUILTIN_ANIMATIONS.map((a) => a.id).toSorted()).toEqual(ids.toSorted())
    for (const a of BUILTIN_ANIMATIONS) expect(AnimationPreset.safeParse(a).success).toBe(true)
  })

  it('resolves builtin/<id> refs only', () => {
    for (const id of ids) expect(resolveBuiltinAnimation(`builtin/${id}`)?.id).toBe(id)
    expect(resolveBuiltinAnimation('fade')).toBeUndefined()
    expect(resolveBuiltinAnimation('builtin/nope')).toBeUndefined()
    expect(resolveBuiltinAnimation('pack/fade')).toBeUndefined()
  })

  it('in-presets end at identity and loops start and end at identity', () => {
    for (const a of BUILTIN_ANIMATIONS.filter((x) => x.kind === 'in')) {
      expect(evaluatePreset(a, 1)).toEqual(IDENTITY_PROPS)
    }
    for (const a of BUILTIN_ANIMATIONS.filter((x) => x.kind === 'loop')) {
      expect(evaluatePreset(a, 0)).toEqual(IDENTITY_PROPS)
      expect(evaluatePreset(a, 1)).toEqual(IDENTITY_PROPS)
    }
  })

  it('in-presets start away from identity (they visibly animate)', () => {
    for (const a of BUILTIN_ANIMATIONS.filter((x) => x.kind === 'in' && !x.perCharacter)) {
      expect(evaluatePreset(a, 0)).not.toEqual(IDENTITY_PROPS)
    }
  })
})
