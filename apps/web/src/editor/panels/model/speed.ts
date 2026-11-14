/**
 * Speed controls: a log-scale slider mapping (0.1× … 16×, 1× in a sensible place) and
 * speed-curve presets that write `speedRamp` keyframes.
 *
 * A ramp value r multiplies `clip.speed`; the source consumed by the clip is
 * speed × ∫ r(τ) dτ. Curves are normalised so that the mean of r is 1: the clip keeps its
 * duration AND its source span, so applying a curve never ripples the timeline or runs past
 * the end of the media. Curve segments use only `linear` and `hold` easings, whose integrals
 * are exact (trapezoid / step), so the normalisation is exact too.
 */
import type { Easing, Keyframe, Us } from '@reelforge/core'

export const SPEED_MIN = 0.1
export const SPEED_MAX = 16
const LOG_RANGE = Math.log(SPEED_MAX / SPEED_MIN)

/** Slider position 0..1 → speed (log scale). */
export const positionToSpeed = (p: number): number => {
  const s = SPEED_MIN * Math.exp(Math.min(1, Math.max(0, p)) * LOG_RANGE)
  // Two significant decimals below 10×, one above: what a person would type.
  return s < 10 ? Math.round(s * 100) / 100 : Math.round(s * 10) / 10
}

/** Speed → slider position 0..1. */
export const speedToPosition = (s: number): number =>
  Math.log(Math.min(SPEED_MAX, Math.max(SPEED_MIN, s)) / SPEED_MIN) / LOG_RANGE

export const formatSpeed = (s: number): string =>
  `${s >= 10 ? s.toFixed(1) : s.toFixed(s < 1 ? 2 : 1).replace(/\.?0+$/, '')}×`

export type CurveId = 'montage' | 'hero' | 'bullet' | 'flashIn' | 'flashOut' | 'jumpCut'

interface CurvePoint {
  /** Normalised clip time 0..1. */
  u: number
  /** Relative speed (before normalisation). */
  r: number
  /** Easing arriving at this point (first point's easing is unused). */
  e?: Easing
}

export interface SpeedCurve {
  id: CurveId
  name: string
  points: readonly CurvePoint[]
}

export const SPEED_CURVES: readonly SpeedCurve[] = [
  {
    id: 'montage',
    name: 'Montage',
    points: [
      { u: 0, r: 1.6 },
      { u: 0.2, r: 0.6 },
      { u: 0.45, r: 1.8 },
      { u: 0.7, r: 0.5 },
      { u: 1, r: 1.6 },
    ],
  },
  {
    id: 'hero',
    name: 'Hero',
    points: [
      { u: 0, r: 1.8 },
      { u: 0.35, r: 1.8 },
      { u: 0.45, r: 0.25 },
      { u: 0.6, r: 0.25 },
      { u: 0.7, r: 1.8 },
      { u: 1, r: 1.8 },
    ],
  },
  {
    id: 'bullet',
    name: 'Bullet',
    points: [
      { u: 0, r: 1.5 },
      { u: 0.3, r: 1.5 },
      { u: 0.4, r: 0.12 },
      { u: 0.7, r: 0.12 },
      { u: 0.8, r: 1.5 },
      { u: 1, r: 1.5 },
    ],
  },
  {
    id: 'flashIn',
    name: 'Flash in',
    points: [
      { u: 0, r: 5 },
      { u: 0.35, r: 0.8 },
      { u: 1, r: 0.8 },
    ],
  },
  {
    id: 'flashOut',
    name: 'Flash out',
    points: [
      { u: 0, r: 0.8 },
      { u: 0.65, r: 0.8 },
      { u: 1, r: 5 },
    ],
  },
  {
    id: 'jumpCut',
    name: 'Jump cut',
    points: [
      { u: 0, r: 1 },
      { u: 0.25, r: 6, e: 'hold' },
      { u: 0.4, r: 1, e: 'hold' },
      { u: 0.65, r: 6, e: 'hold' },
      { u: 0.8, r: 1, e: 'hold' },
    ],
  },
]

/** Mean of r over u ∈ [0, 1] (holding the first/last value outside the points). */
const meanOf = (pts: readonly CurvePoint[]): number => {
  const first = pts[0]
  const last = pts.at(-1)
  if (!first || !last) return 1
  let area = first.u * first.r + (1 - last.u) * last.r
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!
    const b = pts[i]!
    const w = b.u - a.u
    area += b.e === 'hold' ? w * a.r : (w * (a.r + b.r)) / 2
  }
  return area
}

/**
 * Ramp keyframes for `curve` on a clip of `duration` (µs) at base `speed`. Instantaneous
 * speeds are kept within 0.1–16× (clamping, then re-normalising) and keyframe times are
 * integer, strictly increasing clip times.
 */
export const curveRamp = (curve: SpeedCurve, duration: Us, speed: number): Keyframe[] => {
  let pts = curve.points.map((p) => ({ ...p }))
  const lo = SPEED_MIN / speed
  const hi = SPEED_MAX / speed
  for (let pass = 0; pass < 6; pass++) {
    const m = meanOf(pts)
    pts = pts.map((p) => ({ ...p, r: Math.min(hi, Math.max(lo, p.r / m)) }))
    if (Math.abs(meanOf(pts) - 1) < 1e-9) break
  }
  // Never consume more source than before (would run past the media's end).
  const m = meanOf(pts)
  if (m > 1) pts = pts.map((p) => ({ ...p, r: p.r / m }))
  const out: Keyframe[] = []
  for (const p of pts) {
    const t = Math.round(p.u * duration)
    if (out.length && t <= out.at(-1)!.t) continue
    out.push({ t, value: Number(p.r.toFixed(6)), easing: p.e ?? 'linear' })
  }
  return out
}

/** Which preset (if any) produced `ramp` for this clip — used to highlight the active curve. */
export const detectCurve = (
  ramp: readonly Keyframe[],
  duration: Us,
  speed: number,
): CurveId | 'none' | 'custom' => {
  if (ramp.length === 0) return 'none'
  for (const c of SPEED_CURVES) {
    const k = curveRamp(c, duration, speed)
    if (
      k.length === ramp.length &&
      k.every((x, i) => {
        const y = ramp[i]!
        return (
          Math.abs(x.t - y.t) <= 1 && Math.abs(x.value - y.value) < 1e-3 && x.easing === y.easing
        )
      })
    )
      return c.id
  }
  return 'custom'
}
