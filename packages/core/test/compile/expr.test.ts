import { describe, expect, it } from 'vitest'
import { Easing, type Keyframe } from '../../src/schema.ts'
import {
  EASINGS,
  animExpr,
  animRange,
  easingExpr,
  evalAnimatable,
  evalKeyframes,
  isAnimated,
  keyframesExpr,
  num,
  piecewise,
  secs,
  staticValue,
} from '../../src/compile/expr.ts'
import { CompileError } from '../../src/compile/errors.ts'
import { evalExpr } from './helpers.ts'

const EASING_NAMES = Easing.options

describe('num / secs', () => {
  it('formats without exponents or trailing zeros', () => {
    expect(num(1)).toBe('1')
    expect(num(0.5)).toBe('0.5')
    expect(num(1 / 3)).toBe('0.333333')
    expect(num(1e-9)).toBe('0')
    expect(num(-1e-9)).toBe('0')
    expect(num(1e21)).toBe('1e+21') // integers pass through String()
    expect(num(123456.0000001)).toBe('123456')
    expect(num(-2.5)).toBe('-2.5')
    expect(num(0.123456789, 3)).toBe('0.123')
  })

  it('rejects non-finite numbers', () => {
    expect(() => num(Number.NaN)).toThrow(CompileError)
    expect(() => num(Infinity)).toThrow(/non-finite/)
  })

  it('converts microseconds to seconds', () => {
    expect(secs(1_500_000)).toBe('1.5')
    expect(secs(33_333)).toBe('0.033333')
    expect(secs(0)).toBe('0')
  })
})

describe('easings', () => {
  it('every easing maps 0 → 0 and 1 → 1 (hold is a step)', () => {
    for (const e of EASING_NAMES) {
      if (e === 'hold') continue
      expect(EASINGS[e](0)).toBeCloseTo(0, 9)
      expect(EASINGS[e](1)).toBeCloseTo(1, 9)
    }
    expect(EASINGS.hold(0.99)).toBe(0)
  })

  it('FFmpeg expressions match the JS reference for every easing', () => {
    for (const e of EASING_NAMES) {
      for (let k = 0; k <= 100; k++) {
        const p = k / 100
        const ff = evalExpr(easingExpr(e, '(p)'), { p })
        expect(ff, `${e}(${p})`).toBeCloseTo(EASINGS[e](p), 5)
      }
    }
  })

  it('easeOutBack overshoots and easeOutElastic oscillates', () => {
    const back = Array.from({ length: 50 }, (_, i) => EASINGS.easeOutBack(i / 49))
    expect(Math.max(...back)).toBeGreaterThan(1.05)
    const el = Array.from({ length: 200 }, (_, i) => EASINGS.easeOutElastic(i / 199))
    expect(Math.max(...el)).toBeGreaterThan(1.2)
  })
})

describe('keyframe convention', () => {
  const kf = (t: number, value: number, easing: Easing = 'linear'): Keyframe => ({
    t,
    value,
    easing,
  })

  it('uses the static value with no keyframes', () => {
    expect(evalKeyframes([], 123, 7)).toBe(7)
    expect(evalAnimatable({ value: 3, keyframes: [] }, 1e6)).toBe(3)
  })

  it('holds the first value before and the last value after', () => {
    const ks = [kf(1_000_000, 10), kf(2_000_000, 20)]
    expect(evalKeyframes(ks, 0, 0)).toBe(10)
    expect(evalKeyframes(ks, 5_000_000, 0)).toBe(20)
  })

  it('segment k[i] → k[i+1] uses the easing of k[i+1]', () => {
    // First keyframe says easeIn, but the segment must use the second keyframe's linear.
    const ks = [kf(0, 0, 'easeIn'), kf(1_000_000, 100, 'linear')]
    expect(evalKeyframes(ks, 250_000, 0)).toBeCloseTo(25, 9)
    const ks2 = [kf(0, 0, 'linear'), kf(1_000_000, 100, 'easeIn')]
    expect(evalKeyframes(ks2, 500_000, 0)).toBeCloseTo(12.5, 9)
  })

  it('hold steps: value stays k[i] until k[i+1].t', () => {
    const ks = [kf(0, 1), kf(1_000_000, 5, 'hold'), kf(2_000_000, 9)]
    expect(evalKeyframes(ks, 999_999, 0)).toBe(1)
    expect(evalKeyframes(ks, 1_000_000, 0)).toBe(5)
    expect(evalKeyframes(ks, 1_500_000, 0)).toBe(7)
  })

  it('keyframesExpr matches evalKeyframes for every easing (with affine map)', () => {
    for (const e of EASING_NAMES) {
      const ks = [
        kf(200_000, 10),
        kf(700_000, -30, e),
        kf(900_000, 50, 'easeInOut'),
        kf(1_500_000, 5, e),
      ]
      const expr = keyframesExpr(ks, 0, '(T)', { mul: 2, add: 1 })
      for (let us = 0; us <= 1_800_000; us += 12_500) {
        const ff = evalExpr(expr, { T: us / 1e6 })
        expect(ff, `${e} @${us}`).toBeCloseTo(evalKeyframes(ks, us, 0) * 2 + 1, 4)
      }
    }
  })

  it('constant keyframes compile to a plain number', () => {
    expect(keyframesExpr([kf(0, 4), kf(1_000_000, 4)], 0, 't')).toBe('4')
    expect(animExpr({ value: 2, keyframes: [] }, 't', { mul: 3 })).toBe('6')
    expect(isAnimated({ value: 2, keyframes: [kf(0, 4), kf(10, 4)] })).toBe(false)
    expect(staticValue({ value: 2, keyframes: [kf(0, 4)] })).toBe(4)
  })

  it('handles many keyframes with a balanced (logarithmic depth) tree', () => {
    const ks = Array.from({ length: 256 }, (_, i) => kf(i * 10_000, (i * 37) % 11))
    const expr = keyframesExpr(ks, 0, 'T')
    // Depth ≈ log2(256) nested ifs on any path; total length stays linear.
    expect(expr.length).toBeLessThan(256 * 120)
    for (let us = 0; us < 2_600_000; us += 3_333) {
      expect(evalExpr(expr, { T: us / 1e6 })).toBeCloseTo(evalKeyframes(ks, us, 0), 6)
    }
  })

  it('animRange includes easing overshoot', () => {
    const r = animRange({ value: 0, keyframes: [kf(0, 1), kf(1_000_000, 2, 'easeOutBack')] })
    expect(r.min).toBe(1)
    expect(r.max).toBeGreaterThan(2.05)
    expect(animRange({ value: 3, keyframes: [] })).toEqual({ min: 3, max: 3 })
  })
})

describe('piecewise', () => {
  it('selects leaves by half-open intervals and merges equal neighbours', () => {
    const e = piecewise('x', [1, 2, 3], ['a', 'b', 'b', 'c'])
    expect(e).toBe('if(lt(x,3),if(lt(x,1),a,b),c)')
    const ex = piecewise('x', [1, 2], ['10', '20', '30'])
    expect(evalExpr(ex, { x: 0.5 })).toBe(10)
    expect(evalExpr(ex, { x: 1 })).toBe(20)
    expect(evalExpr(ex, { x: 2 })).toBe(30)
  })

  it('validates leaf count', () => {
    expect(() => piecewise('x', [1], ['a'])).toThrow(CompileError)
  })
})
