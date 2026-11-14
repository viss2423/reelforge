/**
 * Colour adjustment mapping: Adjustments sliders (-100..100 / 0..100) → FFmpeg filters.
 *
 * The web preview imports these constants and the reference functions ({@link lumaCurve},
 * {@link chromaCurve}) so its WebGL shader computes exactly what the export does.
 *
 * Tonal and colour sliders are folded into ONE `lutyuv` filter operating directly on 8-bit
 * limited-range YUV (no RGB round-trip, a 256-entry table per plane — the cheapest possible
 * colour pipeline). Each plane is an independent curve:
 *
 * Luma, with x = (Y − 16) / 219 clamped to 0..1:
 *   1. exposure    x ← clamp(x · 2^(exposure/100 · EXPOSURE_STOPS))
 *   2. shadows     x ← x + s · SHADOWS_STRENGTH · 4x(1−x)²     (s = shadows/100; peaks at x = 1/3)
 *   3. highlights  x ← x + h · HIGHLIGHTS_STRENGTH · 4x²(1−x)  (h = highlights/100; peaks at 2/3)
 *   4. contrast    x ← (x − 0.5) · (1 + contrast/100 · CONTRAST_RANGE) + 0.5
 *   5. brightness  x ← x + brightness/100 · BRIGHTNESS_RANGE
 *   Y' = round(clamp(16 + 219x, 16, 235))
 *   (strengths ≤ 0.25 keep steps 2–3 monotonic.)
 *
 * Chroma, with c = (C − 128) / 112 for C ∈ {U(Cb), V(Cr)}:
 *   1. saturation  c ← c · (1 + saturation/100 · SATURATION_RANGE)
 *   2. vibrance    c ← c · (1 + vibrance/100 · VIBRANCE_STRENGTH · (1 − min(1, |c|)))
 *                  (per-plane approximation: boosts weakly saturated colours most)
 *   3. shift       U ← c − temperature/100 · TEMPERATURE_SHIFT + tint/100 · TINT_SHIFT
 *                  V ← c + temperature/100 · TEMPERATURE_SHIFT + tint/100 · TINT_SHIFT
 *                  (warm = towards red/yellow, cool = towards blue; tint + = magenta, − = green)
 *   C' = round(clamp(128 + 112c, 16, 240))
 *
 * Every coefficient is rounded to 6 decimal places (the digits the FFmpeg expression
 * carries) before use, in both the filter and the reference curves.
 *
 * Spatial sliders use dedicated filters (sizes are canvas px; multiply by the export scale):
 *   sharpen  → unsharp luma, amount = sharpen/100 · SHARPEN_MAX_AMOUNT, matrix 5×5 at 1080p
 *   blur     → gblur sigma = blur/100 · BLUR_MAX_SIGMA
 *   vignette → vignette angle = vignette/100 · VIGNETTE_MAX_ANGLE (radians, lens angle)
 *   grain    → temporal noise on luma, strength = grain/100 · GRAIN_MAX_STRENGTH
 */
import type { Adjustments } from '../schema.ts'
import { filter } from './escape.ts'
import { num } from './expr.ts'

export const ADJUSTMENT_MAPPING = {
  EXPOSURE_STOPS: 1,
  SHADOWS_STRENGTH: 0.25,
  HIGHLIGHTS_STRENGTH: 0.25,
  CONTRAST_RANGE: 0.5,
  BRIGHTNESS_RANGE: 0.2,
  SATURATION_RANGE: 1,
  VIBRANCE_STRENGTH: 0.6,
  TEMPERATURE_SHIFT: 0.1,
  TINT_SHIFT: 0.08,
  SHARPEN_MAX_AMOUNT: 1.5,
  BLUR_MAX_SIGMA: 24,
  VIGNETTE_MAX_ANGLE: Math.PI / 2.5,
  GRAIN_MAX_STRENGTH: 32,
} as const

const M = ADJUSTMENT_MAPPING
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))

/** True when the luma curve is the identity. */
const lumaNeutral = (a: Adjustments): boolean =>
  a.exposure === 0 &&
  a.shadows === 0 &&
  a.highlights === 0 &&
  a.contrast === 0 &&
  a.brightness === 0

/** True when the chroma curves are the identity. */
const chromaNeutral = (a: Adjustments): boolean =>
  a.saturation === 0 && a.vibrance === 0 && a.temperature === 0 && a.tint === 0

/**
 * Curve coefficients, quantised to exactly the digits written into the FFmpeg expression so
 * the reference curves and the filter agree bit-for-bit (undefined = step skipped).
 */
interface LumaCoefficients {
  exposure?: number
  shadows?: number
  highlights?: number
  contrast?: number
  brightness?: number
}

interface ChromaCoefficients {
  saturation?: number
  vibrance?: number
  shift?: number
}

const quantise = (x: number): number => Number(num(x))
const when = (active: boolean, value: () => number): number | undefined =>
  active ? quantise(value()) : undefined

function lumaCoefficients(a: Adjustments): LumaCoefficients {
  return {
    exposure: when(a.exposure !== 0, () => 2 ** ((a.exposure / 100) * M.EXPOSURE_STOPS)),
    shadows: when(a.shadows !== 0, () => (a.shadows / 100) * M.SHADOWS_STRENGTH * 4),
    highlights: when(a.highlights !== 0, () => (a.highlights / 100) * M.HIGHLIGHTS_STRENGTH * 4),
    contrast: when(a.contrast !== 0, () => 1 + (a.contrast / 100) * M.CONTRAST_RANGE),
    brightness: when(a.brightness !== 0, () => (a.brightness / 100) * M.BRIGHTNESS_RANGE),
  }
}

function chromaCoefficients(plane: 'u' | 'v', a: Adjustments): ChromaCoefficients {
  const temperature = (a.temperature / 100) * M.TEMPERATURE_SHIFT
  const shift = (plane === 'u' ? -temperature : temperature) + (a.tint / 100) * M.TINT_SHIFT
  return {
    saturation: when(a.saturation !== 0, () => 1 + (a.saturation / 100) * M.SATURATION_RANGE),
    vibrance: when(a.vibrance !== 0, () => (a.vibrance / 100) * M.VIBRANCE_STRENGTH),
    shift: when(shift !== 0, () => shift),
  }
}

/** Reference luma curve: 8-bit limited-range Y code value → adjusted code value. */
export function lumaCurve(y: number, a: Adjustments): number {
  const k = lumaCoefficients(a)
  let x = clamp((y - 16) / 219, 0, 1)
  if (k.exposure !== undefined) x = clamp(x * k.exposure, 0, 1)
  if (k.shadows !== undefined) x = x + k.shadows * x * (1 - x) ** 2
  if (k.highlights !== undefined) x = x + k.highlights * x * x * (1 - x)
  if (k.contrast !== undefined) x = (x - 0.5) * k.contrast + 0.5
  if (k.brightness !== undefined) x = x + k.brightness
  return Math.round(clamp(16 + 219 * x, 16, 235))
}

/** Reference chroma curve: 8-bit Cb ('u') or Cr ('v') code value → adjusted code value. */
export function chromaCurve(value: number, plane: 'u' | 'v', a: Adjustments): number {
  const k = chromaCoefficients(plane, a)
  let c = (value - 128) / 112
  if (k.saturation !== undefined) c = c * k.saturation
  if (k.vibrance !== undefined) c = c * (1 + k.vibrance * (1 - Math.min(1, Math.abs(c))))
  if (k.shift !== undefined) c = c + k.shift
  return Math.round(clamp(128 + 112 * c, 16, 240))
}

/** FFmpeg expression (variable `val`) equivalent to {@link lumaCurve}. */
export function lumaExpr(a: Adjustments): string {
  const k = lumaCoefficients(a)
  // st(0)/ld(0) keep each step readable and evaluate `x` once per step.
  const steps = ['st(0,clip((val-16)/219,0,1))']
  if (k.exposure !== undefined) steps.push(`st(0,clip(ld(0)*${num(k.exposure)},0,1))`)
  if (k.shadows !== undefined) steps.push(`st(0,ld(0)+${num(k.shadows)}*ld(0)*pow(1-ld(0),2))`)
  if (k.highlights !== undefined) {
    steps.push(`st(0,ld(0)+${num(k.highlights)}*ld(0)*ld(0)*(1-ld(0)))`)
  }
  if (k.contrast !== undefined) steps.push(`st(0,(ld(0)-0.5)*${num(k.contrast)}+0.5)`)
  if (k.brightness !== undefined) steps.push(`st(0,ld(0)+${num(k.brightness)})`)
  steps.push('round(clip(16+219*ld(0),16,235))')
  return steps.join(';')
}

/** FFmpeg expression (variable `val`) equivalent to {@link chromaCurve}. */
export function chromaExpr(plane: 'u' | 'v', a: Adjustments): string {
  const k = chromaCoefficients(plane, a)
  const steps = ['st(0,(val-128)/112)']
  if (k.saturation !== undefined) steps.push(`st(0,ld(0)*${num(k.saturation)})`)
  if (k.vibrance !== undefined) {
    steps.push(`st(0,ld(0)*(1+${num(k.vibrance)}*(1-min(1,abs(ld(0))))))`)
  }
  if (k.shift !== undefined) steps.push(`st(0,ld(0)+${num(k.shift)})`)
  steps.push('round(clip(128+112*ld(0),16,240))')
  return steps.join(';')
}

/** The single `lutyuv` filter for the tonal/colour sliders, or undefined when neutral. */
export function lutyuvFilter(a: Adjustments): string | undefined {
  const luma = !lumaNeutral(a)
  const chroma = !chromaNeutral(a)
  if (!luma && !chroma) return undefined
  return filter('lutyuv', {
    y: luma ? lumaExpr(a) : undefined,
    u: chroma ? chromaExpr('u', a) : undefined,
    v: chroma ? chromaExpr('v', a) : undefined,
  })
}

/** Odd unsharp matrix size for the export scale (5 at 1080p, clamped to FFmpeg's 3..23). */
const unsharpSize = (scale: number): number => clamp(2 * Math.round(2 * scale) + 1, 3, 23)

/** `unsharp` (luma only) for the sharpen slider, or undefined at 0. */
export function sharpenFilter(a: Adjustments, scale: number): string | undefined {
  if (a.sharpen <= 0) return undefined
  const size = unsharpSize(scale)
  return filter('unsharp', {
    lx: size,
    ly: size,
    la: (a.sharpen / 100) * M.SHARPEN_MAX_AMOUNT,
    cx: 3,
    cy: 3,
    ca: 0,
  })
}

/** `gblur` for the blur slider (sigma in canvas px × export scale), or undefined at 0. */
export function blurFilter(a: Adjustments, scale: number): string | undefined {
  if (a.blur <= 0) return undefined
  return filter('gblur', { sigma: (a.blur / 100) * M.BLUR_MAX_SIGMA * scale })
}

/** `vignette` for the vignette slider, or undefined at 0. */
export function vignetteFilter(a: Adjustments): string | undefined {
  if (a.vignette <= 0) return undefined
  return filter('vignette', { angle: (a.vignette / 100) * M.VIGNETTE_MAX_ANGLE })
}

/** Temporal luma `noise` for the grain slider, or undefined at 0. */
export function grainFilter(a: Adjustments): string | undefined {
  if (a.grain <= 0) return undefined
  return filter('noise', {
    c0s: Math.max(1, Math.round((a.grain / 100) * M.GRAIN_MAX_STRENGTH)),
    c0f: 't+u',
  })
}
