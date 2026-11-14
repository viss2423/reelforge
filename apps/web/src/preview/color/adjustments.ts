/**
 * Colour adjustments for the preview, built on the export's own definitions in
 * `@reelforge/core` (packages/core/src/compile/adjustments.ts):
 *
 * - Tonal and colour sliders (exposure, shadows, highlights, contrast, brightness,
 *   saturation, vibrance, temperature, tint) are ONE `lutyuv` in the export: an independent
 *   256-entry curve per 8-bit limited-range Y/U/V plane. The preview evaluates core's
 *   reference curves (`lumaCurve`, `chromaCurve`) into a 256×1 RGBA table (R = Y, G = U,
 *   B = V) that the shader indexes with the pixel's integer YUV code values, so the GPU
 *   result is the export's table lookup exactly (up to the RGB↔YUV conversion).
 * - Spatial sliders use core's `ADJUSTMENT_MAPPING` constants: unsharp amount, gblur sigma,
 *   vignette angle and grain strength.
 *
 * Export filter order: lutyuv → unsharp → gblur → vignette → noise (→ lut3d). The preview's
 * single-pass shader sharpens from the source neighbourhood before the curves (invisible at
 * preview scale).
 */
import { ADJUSTMENT_MAPPING, chromaCurve, lumaCurve, type Adjustments } from '@reelforge/core'

const M = ADJUSTMENT_MAPPING

/** Concrete parameters for one clip. */
export interface AdjustParams {
  /** 256×1 RGBA8 curve table (R = Y', G = U', B = V', A = 255), or null when neutral. */
  curves: Uint8Array | null
  /** unsharp luma amount (5×5 at 1080p). */
  sharpen: number
  /** gblur sigma in canvas px (1080 wide). */
  blurSigma: number
  /** vignette angle (radians). */
  vignetteAngle: number
  /** noise strength in 8-bit levels. */
  grain: number
}

const tonalNeutral = (a: Adjustments): boolean =>
  a.exposure === 0 &&
  a.shadows === 0 &&
  a.highlights === 0 &&
  a.contrast === 0 &&
  a.brightness === 0 &&
  a.saturation === 0 &&
  a.vibrance === 0 &&
  a.temperature === 0 &&
  a.tint === 0

/** The export's `lutyuv` tables as one RGBA8 row (see module docs). */
export function curveTable(a: Adjustments): Uint8Array {
  const t = new Uint8Array(256 * 4)
  for (let i = 0; i < 256; i++) {
    t[i * 4] = lumaCurve(i, a)
    t[i * 4 + 1] = chromaCurve(i, 'u', a)
    t[i * 4 + 2] = chromaCurve(i, 'v', a)
    t[i * 4 + 3] = 255
  }
  return t
}

/** Map UI sliders to preview parameters; neutral sliders produce "skip" values. */
export function adjustParams(a: Adjustments): AdjustParams {
  return {
    curves: tonalNeutral(a) ? null : curveTable(a),
    sharpen: a.sharpen > 0 ? (a.sharpen / 100) * M.SHARPEN_MAX_AMOUNT : 0,
    blurSigma: a.blur > 0 ? (a.blur / 100) * M.BLUR_MAX_SIGMA : 0,
    vignetteAngle: a.vignette > 0 ? (a.vignette / 100) * M.VIGNETTE_MAX_ANGLE : 0,
    grain: a.grain > 0 ? Math.max(1, Math.round((a.grain / 100) * M.GRAIN_MAX_STRENGTH)) : 0,
  }
}

/* ------------------------------------------------------------------ YUV ↔ RGB (BT.709, limited) */

/** RGB 0..1 → Y'CbCr 8-bit code values (BT.709 limited range), unrounded. */
export function rgbToYuv709(r: number, g: number, b: number, out: Float64Array): Float64Array {
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  out[0] = 16 + 219 * y
  out[1] = 128 + 224 * ((b - y) / 1.8556)
  out[2] = 128 + 224 * ((r - y) / 1.5748)
  return out
}

/** Y'CbCr 8-bit code values (BT.709 limited) → RGB 0..1 (unclamped). */
export function yuv709ToRgb(y: number, u: number, v: number, out: Float64Array): Float64Array {
  const Y = (y - 16) / 219
  const Cb = (u - 128) / 224
  const Cr = (v - 128) / 224
  out[0] = Y + 1.5748 * Cr
  out[1] = Y - 0.187324 * Cb - 0.468124 * Cr
  out[2] = Y + 1.8556 * Cb
  return out
}

/* ------------------------------------------------------------------ vignette (vf_vignette.c) */

/** Natural vignette factor at pixel (x, y) of a w×h frame (aspect 1, centred). */
export function vignetteFactor(x: number, y: number, w: number, h: number, angle: number): number {
  const xx = Math.trunc(x - w / 2)
  const yy = Math.trunc(y - h / 2)
  const dnorm = Math.hypot(xx, yy) / Math.hypot(w / 2, h / 2)
  if (dnorm > 1) return 0
  const c = Math.cos(angle * dnorm)
  return c * c * (c * c)
}

/* ------------------------------------------------------------------ uniform packing */

/** Floats in the adjustment uniform (one vec4). */
export const ADJ_FLOATS = 4

/**
 * Pack `p` into `out` (length ≥ {@link ADJ_FLOATS}):
 *   (sharpen amount, vignette angle, grain strength in 8-bit levels, curves on 0/1).
 * Returns false when every adjustment is neutral (the shader then skips the pipeline).
 */
export function packAdjustUniforms(p: AdjustParams, out: Float32Array): boolean {
  out[0] = p.sharpen
  out[1] = p.vignetteAngle
  out[2] = p.grain
  out[3] = p.curves ? 1 : 0
  return p.curves !== null || p.sharpen > 0 || p.vignetteAngle > 0 || p.grain > 0
}

/**
 * CPU reference of the shader's per-pixel colour step (the curve lookup; spatial filters,
 * LUT and grain excluded), operating on 0..1 RGB. Used by tests and the GPU self-check.
 */
export function applyAdjustmentsCpu(rgbIn: readonly number[], p: AdjustParams): number[] {
  const t = p.curves
  if (!t) return [...rgbIn]
  const yuv = rgbToYuv709(rgbIn[0]!, rgbIn[1]!, rgbIn[2]!, new Float64Array(3))
  const code = (v: number): number => Math.min(255, Math.max(0, Math.round(v)))
  const y = t[code(yuv[0]!) * 4]!
  const u = t[code(yuv[1]!) * 4 + 1]!
  const v = t[code(yuv[2]!) * 4 + 2]!
  const out = yuv709ToRgb(y, u, v, yuv)
  return [clamp01(out[0]!), clamp01(out[1]!), clamp01(out[2]!)]
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
