import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  ADJUSTMENT_MAPPING,
  Adjustments,
  chromaCurve,
  lumaCurve,
  lutyuvFilter,
} from '@reelforge/core'
import { afterAll, describe, expect, it } from 'vitest'
import { ffmpegRaw, HAS_FFMPEG, tempDir } from '../test/ffmpeg.ts'
import {
  adjustParams,
  ADJ_FLOATS,
  applyAdjustmentsCpu,
  curveTable,
  packAdjustUniforms,
  rgbToYuv709,
  vignetteFactor,
  yuv709ToRgb,
} from './adjustments.ts'

/** Deterministic pseudo-random bytes (LCG). */
function randomBytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    out[i] = s >>> 24
  }
  return out
}

const W = 16
const H = 16
const N = W * H

const CASES: Record<string, Partial<Adjustments>> = {
  contrast: { contrast: 45 },
  brightness: { brightness: -35 },
  exposure: { exposure: 60 },
  tonal: { shadows: 70, highlights: -50 },
  saturation: { saturation: 70 },
  vibrance: { vibrance: -60 },
  warmTint: { temperature: 60, tint: -40 },
  combined: { contrast: 20, saturation: 25, temperature: 30, shadows: -20, vibrance: 30 },
}

describe('slider mapping (core ADJUSTMENT_MAPPING)', () => {
  it('neutral sliders skip every step', () => {
    const p = adjustParams(Adjustments.parse({}))
    expect(p).toEqual({ curves: null, sharpen: 0, blurSigma: 0, vignetteAngle: 0, grain: 0 })
    const u = new Float32Array(ADJ_FLOATS)
    expect(packAdjustUniforms(p, u)).toBe(false)
    expect([...u]).toEqual([0, 0, 0, 0])
  })

  it('spatial sliders use the export constants', () => {
    const M = ADJUSTMENT_MAPPING
    const p = adjustParams(Adjustments.parse({ sharpen: 50, blur: 25, vignette: 100, grain: 50 }))
    expect(p.curves).toBeNull()
    expect(p.sharpen).toBeCloseTo(0.5 * M.SHARPEN_MAX_AMOUNT)
    expect(p.blurSigma).toBeCloseTo(0.25 * M.BLUR_MAX_SIGMA)
    expect(p.vignetteAngle).toBeCloseTo(M.VIGNETTE_MAX_ANGLE)
    expect(p.grain).toBe(Math.round(0.5 * M.GRAIN_MAX_STRENGTH))
    const u = new Float32Array(ADJ_FLOATS)
    expect(packAdjustUniforms(p, u)).toBe(true)
    expect(u[3]).toBe(0)
  })

  it('the curve table is core’s lutyuv reference curves', () => {
    for (const a of Object.values(CASES).map((c) => Adjustments.parse(c))) {
      const t = curveTable(a)
      for (let i = 0; i < 256; i++) {
        expect(t[i * 4]).toBe(lumaCurve(i, a))
        expect(t[i * 4 + 1]).toBe(chromaCurve(i, 'u', a))
        expect(t[i * 4 + 2]).toBe(chromaCurve(i, 'v', a))
        expect(t[i * 4 + 3]).toBe(255)
      }
      const u = new Float32Array(ADJ_FLOATS)
      expect(packAdjustUniforms(adjustParams(a), u)).toBe(true)
      expect(u[3]).toBe(1)
    }
  })
})

describe('math helpers', () => {
  it('BT.709 limited YUV round-trips', () => {
    const t = new Float64Array(3)
    for (const [r, g, b] of [
      [0, 0, 0],
      [1, 1, 1],
      [0.2, 0.5, 0.9],
    ] as const) {
      rgbToYuv709(r, g, b, t)
      yuv709ToRgb(t[0]!, t[1]!, t[2]!, t)
      expect(t[0]).toBeCloseTo(r, 4)
      expect(t[1]).toBeCloseTo(g, 4)
      expect(t[2]).toBeCloseTo(b, 4)
    }
    rgbToYuv709(1, 1, 1, t)
    expect(t[0]).toBeCloseTo(235)
  })

  it('vignette factor is 1 at the centre and 0 outside the radius', () => {
    expect(vignetteFactor(50, 50, 100, 100, 1)).toBe(1)
    expect(vignetteFactor(0, 0, 100, 100, Math.PI / 2)).toBeCloseTo(0, 6)
  })

  it('CPU pipeline is identity for neutral params', () => {
    const p = adjustParams(Adjustments.parse({}))
    expect(applyAdjustmentsCpu([0.2, 0.4, 0.6], p)).toEqual([0.2, 0.4, 0.6])
  })

  it('CPU pipeline moves colours in the slider direction', () => {
    const grey = [0.5, 0.5, 0.5]
    const bright = applyAdjustmentsCpu(grey, adjustParams(Adjustments.parse({ exposure: 50 })))
    expect(bright[1]).toBeGreaterThan(0.55)
    const warm = applyAdjustmentsCpu(grey, adjustParams(Adjustments.parse({ temperature: 80 })))
    expect(warm[0]).toBeGreaterThan(warm[2]!)
  })
})

describe.skipIf(!HAS_FFMPEG)('bit-compatibility with the export filters', () => {
  const tmp = tempDir()
  afterAll(() => tmp.cleanup())

  const run = (file: string, vf: string, w = W, h = H): Uint8Array =>
    new Uint8Array(
      ffmpegRaw([
        '-f',
        'rawvideo',
        '-pix_fmt',
        'yuv444p',
        '-s',
        `${w}x${h}`,
        '-i',
        file,
        '-vf',
        vf,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'yuv444p',
        'pipe:1',
      ]),
    )

  it('the curve table equals the export lutyuv on every plane, exactly', () => {
    const planes = randomBytes(N * 3, 7)
    // Cover every code value on each plane, then random ones.
    for (let i = 0; i < 256; i++) planes[i] = planes[N + i] = planes[2 * N + i] = i
    const file = path.join(tmp.dir, 'lut.yuv')
    writeFileSync(file, planes)
    for (const [name, c] of Object.entries(CASES)) {
      const a = Adjustments.parse(c)
      const out = run(file, lutyuvFilter(a)!)
      const t = curveTable(a)
      let maxErr = 0
      for (let i = 0; i < N; i++) {
        maxErr = Math.max(maxErr, Math.abs(out[i]! - t[planes[i]! * 4]!))
        maxErr = Math.max(maxErr, Math.abs(out[N + i]! - t[planes[N + i]! * 4 + 1]!))
        maxErr = Math.max(maxErr, Math.abs(out[2 * N + i]! - t[planes[2 * N + i]! * 4 + 2]!))
      }
      expect({ name, maxErr }).toEqual({ name, maxErr: 0 })
    }
  })

  it('vignette (no dither) matches within 1 LSB on luma', () => {
    const w = 64
    const h = 36
    const y = new Uint8Array(w * h).fill(200)
    const uv = new Uint8Array(w * h * 2).fill(128)
    const file = path.join(tmp.dir, 'vig.yuv')
    writeFileSync(file, Buffer.concat([y, uv]))
    const angle = ADJUSTMENT_MAPPING.VIGNETTE_MAX_ANGLE * 0.7
    const out = run(file, `vignette=angle=${angle}:dither=0`, w, h)
    let maxErr = 0
    for (let yy = 0; yy < h; yy++) {
      for (let x = 0; x < w; x++) {
        const ref = 200 * vignetteFactor(x, yy, w, h, angle)
        maxErr = Math.max(maxErr, Math.abs(out[yy * w + x]! - ref))
      }
    }
    expect(maxErr).toBeLessThanOrEqual(1)
  })
})
