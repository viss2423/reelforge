import { assert, integer, property, record } from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Adjustments } from '../../src/schema.ts'
import {
  ADJUSTMENT_MAPPING,
  blurFilter,
  chromaCurve,
  chromaExpr,
  grainFilter,
  lumaCurve,
  lumaExpr,
  lutyuvFilter,
  sharpenFilter,
  vignetteFilter,
} from '../../src/compile/adjustments.ts'
import { adjustmentFilters, adjustmentsNeutral } from '../../src/compile/look.ts'
import { evalExpr } from './helpers.ts'

const neutral = Adjustments.parse({})
const slider = integer({ min: -100, max: 100 })
const adjustmentsArb = record({
  brightness: slider,
  contrast: slider,
  saturation: slider,
  exposure: slider,
  temperature: slider,
  tint: slider,
  highlights: slider,
  shadows: slider,
  vibrance: slider,
}).map((r) => Adjustments.parse(r))

describe('adjustment curves', () => {
  it('neutral settings are the identity and produce no filters', () => {
    for (let y = 16; y <= 235; y++) expect(lumaCurve(y, neutral)).toBe(y)
    for (let c = 16; c <= 240; c++) {
      expect(chromaCurve(c, 'u', neutral)).toBe(c)
      expect(chromaCurve(c, 'v', neutral)).toBe(c)
    }
    expect(lutyuvFilter(neutral)).toBeUndefined()
    expect(adjustmentFilters(neutral, 1)).toEqual([])
    expect(adjustmentsNeutral(neutral, 1)).toBe(true)
  })

  it('FFmpeg lutyuv expressions equal the exported reference curves (property)', () => {
    assert(
      property(adjustmentsArb, (a) => {
        const y = lumaExpr(a)
        const u = chromaExpr('u', a)
        const v = chromaExpr('v', a)
        for (let val = 0; val <= 255; val += 3) {
          expect(evalExpr(y, { val })).toBe(lumaCurve(val, a))
          expect(evalExpr(u, { val })).toBe(chromaCurve(val, 'u', a))
          expect(evalExpr(v, { val })).toBe(chromaCurve(val, 'v', a))
        }
      }),
      { numRuns: 60 },
    )
  })

  it('outputs stay within limited range and the luma curve is monotonic', () => {
    assert(
      property(adjustmentsArb, (a) => {
        let prev = -1
        for (let y = 0; y <= 255; y++) {
          const out = lumaCurve(y, a)
          expect(out).toBeGreaterThanOrEqual(16)
          expect(out).toBeLessThanOrEqual(235)
          expect(out).toBeGreaterThanOrEqual(prev)
          prev = out
          const c = chromaCurve(y, 'u', a)
          expect(c).toBeGreaterThanOrEqual(16)
          expect(c).toBeLessThanOrEqual(240)
        }
      }),
      { numRuns: 60 },
    )
  })

  it('sliders move values in the documented direction', () => {
    const mid = 126
    expect(lumaCurve(mid, { ...neutral, brightness: 50 })).toBeGreaterThan(mid)
    expect(lumaCurve(mid, { ...neutral, exposure: -50 })).toBeLessThan(mid)
    expect(lumaCurve(200, { ...neutral, contrast: 50 })).toBeGreaterThan(200)
    expect(lumaCurve(50, { ...neutral, contrast: 50 })).toBeLessThan(50)
    expect(lumaCurve(70, { ...neutral, shadows: 100 })).toBeGreaterThan(70)
    expect(lumaCurve(180, { ...neutral, highlights: -100 })).toBeLessThan(180)
    expect(chromaCurve(160, 'u', { ...neutral, saturation: 50 })).toBeGreaterThan(160)
    expect(chromaCurve(160, 'u', { ...neutral, saturation: -100 })).toBe(128)
    // warm → less blue (U down), more red (V up)
    expect(chromaCurve(128, 'u', { ...neutral, temperature: 100 })).toBeLessThan(128)
    expect(chromaCurve(128, 'v', { ...neutral, temperature: 100 })).toBeGreaterThan(128)
    // positive tint → magenta (both up)
    expect(chromaCurve(128, 'u', { ...neutral, tint: 100 })).toBeGreaterThan(128)
    expect(chromaCurve(128, 'v', { ...neutral, tint: 100 })).toBeGreaterThan(128)
  })

  it('only emits the planes that change', () => {
    const lumaOnly = lutyuvFilter({ ...neutral, contrast: 10 })!
    expect(lumaOnly).toMatch(/^lutyuv=y=/)
    expect(lumaOnly).not.toMatch(/:u=/)
    const chromaOnly = lutyuvFilter({ ...neutral, saturation: 10 })!
    expect(chromaOnly).toMatch(/^lutyuv=u=.*:v=/)
    expect(chromaOnly).not.toMatch(/y=/)
  })
})

describe('spatial adjustments', () => {
  it('map sliders to filters scaled by export size', () => {
    expect(sharpenFilter(neutral, 1)).toBeUndefined()
    expect(sharpenFilter({ ...neutral, sharpen: 100 }, 1)).toBe(
      `unsharp=lx=5:ly=5:la=${ADJUSTMENT_MAPPING.SHARPEN_MAX_AMOUNT}:cx=3:cy=3:ca=0`,
    )
    // 4K: larger matrix (odd, ≤ 23).
    expect(sharpenFilter({ ...neutral, sharpen: 50 }, 2)).toMatch(/^unsharp=lx=9:ly=9:la=0.75/)
    expect(sharpenFilter({ ...neutral, sharpen: 50 }, 0.1)).toMatch(/lx=3:ly=3/)
    expect(blurFilter({ ...neutral, blur: 50 }, 2)).toBe('gblur=sigma=24')
    expect(vignetteFilter({ ...neutral, vignette: 100 })).toBe(
      `vignette=angle=${(Math.PI / 2.5).toFixed(6).replace(/0+$/, '')}`,
    )
    expect(grainFilter({ ...neutral, grain: 50 })).toBe('noise=c0s=16:c0f=t+u')
    expect(grainFilter({ ...neutral, grain: 1 })).toBe('noise=c0s=1:c0f=t+u')
  })

  it('orders filters cheapest first', () => {
    const fs = adjustmentFilters(
      { ...neutral, contrast: 5, sharpen: 10, blur: 10, vignette: 10, grain: 10 },
      1,
    )
    expect(fs.map((f) => f.split('=')[0])).toEqual([
      'lutyuv',
      'unsharp',
      'gblur',
      'vignette',
      'noise',
    ])
  })
})
