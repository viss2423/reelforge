/**
 * Easing + keyframe evaluation shared by the web preview, the ASS generator and the export
 * compiler. Everything here is allocation-free on the hot path (evaluate is called per frame
 * per property by the preview).
 *
 * Keyframe convention: for the segment between k[i] and k[i+1] the easing of k[i+1] is used
 * (an easing describes how a value ARRIVES at a keyframe). `hold` is a step: the value stays
 * k[i].value until k[i+1].t. Before the first keyframe the first value holds, after the last
 * keyframe the last value holds, and an empty list yields the fallback.
 */
import type { Animatable, Easing } from './schema.ts'
import type { AnimationPreset } from './packs.ts'

/** Structural keyframe shape shared by clip keyframes (µs) and pack presets (normalised t). */
export interface KeyframeLike {
  readonly t: number
  readonly value: number
  readonly easing: Easing
}

const BACK_C1 = 1.70158
const BACK_C3 = BACK_C1 + 1
const ELASTIC_C4 = (2 * Math.PI) / 3

/** Map progress 0..1 through an easing curve. Input is clamped to 0..1. */
export function ease(easing: Easing, p: number): number {
  const x = p <= 0 ? 0 : p >= 1 ? 1 : p
  switch (easing) {
    case 'linear':
      return x
    case 'easeIn':
      return x * x * x
    case 'easeOut': {
      const q = 1 - x
      return 1 - q * q * q
    }
    case 'easeInOut': {
      if (x < 0.5) return 4 * x * x * x
      const q = 2 - 2 * x
      return 1 - (q * q * q) / 2
    }
    case 'easeOutBack': {
      const q = x - 1
      return 1 + BACK_C3 * q * q * q + BACK_C1 * q * q
    }
    case 'easeOutElastic':
      if (x === 0 || x === 1) return x
      return 2 ** (-10 * x) * Math.sin((x * 10 - 0.75) * ELASTIC_C4) + 1
    case 'hold':
      return x < 1 ? 0 : 1
  }
}

/** Antiderivative F(p) of ease(easing, p) on 0..1 for the closed-form easings. */
function easeAntiderivative(easing: Exclude<Easing, 'easeOutElastic'>, p: number): number {
  switch (easing) {
    case 'linear':
      return (p * p) / 2
    case 'easeIn':
      return (p * p * p * p) / 4
    case 'easeOut': {
      const q = 1 - p
      return p + (q * q * q * q) / 4 - 0.25
    }
    case 'easeInOut': {
      if (p < 0.5) return p * p * p * p
      const q = 2 - 2 * p
      return p - 0.5 + (q * q * q * q) / 16
    }
    case 'easeOutBack': {
      const q = p - 1
      return p + (BACK_C3 * q * q * q * q) / 4 + (BACK_C1 * q * q * q) / 3
    }
    case 'hold':
      return p < 1 ? 0 : p - 1
  }
}

// 5-point Gauss–Legendre nodes/weights on [-1, 1]; composite over 16 panels gives ~1e-12
// accuracy for the elastic curve (the only easing without a cheap closed form).
const GL_X = [
  0, -0.5384693101056831, 0.5384693101056831, -0.906179845938664, 0.906179845938664,
] as const
const GL_W = [
  0.5688888888888889, 0.47862867049936647, 0.47862867049936647, 0.23692688538483683,
  0.23692688538483683,
] as const
const GL_PANELS = 16

/** ∫ ease(easing, p) dp over [p0, p1] (0 ≤ p0 ≤ p1 ≤ 1). Exact except elastic (quadrature). */
export function easeIntegral(easing: Easing, p0: number, p1: number): number {
  if (p1 <= p0) return 0
  if (easing !== 'easeOutElastic') {
    return easeAntiderivative(easing, p1) - easeAntiderivative(easing, p0)
  }
  const h = (p1 - p0) / GL_PANELS
  let sum = 0
  for (let k = 0; k < GL_PANELS; k++) {
    const mid = p0 + (k + 0.5) * h
    for (let j = 0; j < 5; j++) sum += GL_W[j]! * ease(easing, mid + (GL_X[j]! * h) / 2)
  }
  return (sum * h) / 2
}

/** Index of the last keyframe with t <= time (−1 if time precedes all). Binary search. */
export function keyframeIndexAt(keyframes: readonly KeyframeLike[], time: number): number {
  let lo = 0
  let hi = keyframes.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (keyframes[mid]!.t <= time) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

/** Value of a keyframe list at time t (clip-relative µs). Before first/after last → hold. */
export function evaluateKeyframes(
  keyframes: readonly KeyframeLike[],
  t: number,
  fallback: number,
): number {
  const n = keyframes.length
  if (n === 0) return fallback
  const first = keyframes[0]!
  if (t <= first.t) return first.value
  const last = keyframes[n - 1]!
  if (t >= last.t) return last.value
  const i = keyframeIndexAt(keyframes, t)
  const a = keyframes[i]!
  const b = keyframes[i + 1]!
  const span = b.t - a.t
  if (span <= 0 || b.easing === 'hold') return a.value
  return a.value + (b.value - a.value) * ease(b.easing, (t - a.t) / span)
}

/** Value of an Animatable at clip-relative time t. */
export function evaluate(a: Animatable, t: number): number {
  return evaluateKeyframes(a.keyframes, t, a.value)
}

/** True when the value can change over time. */
export const isAnimated = (a: Animatable): boolean => a.keyframes.length > 1

/**
 * ∫ value(t) dt over [t0, t1] for a keyframe list (same semantics as evaluateKeyframes).
 * Used to integrate speed ramps into source time; exact for all easings but elastic.
 */
export function integrateKeyframes(
  keyframes: readonly KeyframeLike[],
  t0: number,
  t1: number,
  fallback: number,
): number {
  if (t1 <= t0) return 0
  const n = keyframes.length
  if (n === 0) return fallback * (t1 - t0)
  const first = keyframes[0]!
  const last = keyframes[n - 1]!
  let sum = 0
  let t = t0
  if (t < first.t) {
    const e = Math.min(t1, first.t)
    sum += first.value * (e - t)
    t = e
  }
  let i = Math.max(0, keyframeIndexAt(keyframes, t))
  while (t < t1 && i < n - 1) {
    const a = keyframes[i]!
    const b = keyframes[i + 1]!
    const e = Math.min(t1, b.t)
    if (e > t) {
      const span = b.t - a.t
      if (b.easing === 'hold' || span <= 0) {
        sum += a.value * (e - t)
      } else {
        const dv = b.value - a.value
        sum +=
          a.value * (e - t) + dv * span * easeIntegral(b.easing, (t - a.t) / span, (e - a.t) / span)
      }
      t = e
    }
    i++
  }
  if (t < t1) sum += last.value * (t1 - Math.max(t, last.t))
  return sum
}

export interface AnimatedProps {
  opacity: number
  scale: number
  /** px offset */
  x: number
  /** px offset */
  y: number
  /** degrees */
  rotation: number
}

/** The neutral element of AnimatedProps composition. */
export const IDENTITY_PROPS: Readonly<AnimatedProps> = Object.freeze({
  opacity: 1,
  scale: 1,
  x: 0,
  y: 0,
  rotation: 0,
})

/** Evaluate a pack animation at normalised progress p (0..1). Missing tracks → identity. */
export function evaluatePreset(preset: AnimationPreset, p: number): AnimatedProps {
  const tr = preset.tracks
  const x = p <= 0 ? 0 : p >= 1 ? 1 : p
  return {
    // Per-character presets drive each glyph's reveal with the opacity track (see
    // characterReveal); the block as a whole stays opaque.
    opacity: tr.opacity && !preset.perCharacter ? evaluateKeyframes(tr.opacity, x, 1) : 1,
    scale: tr.scale ? evaluateKeyframes(tr.scale, x, 1) : 1,
    x: tr.x ? evaluateKeyframes(tr.x, x, 0) : 0,
    y: tr.y ? evaluateKeyframes(tr.y, x, 0) : 0,
    rotation: tr.rotation ? evaluateKeyframes(tr.rotation, x, 0) : 0,
  }
}

/**
 * Opacity (0..1) of character `index` of `count` for a per-character preset at progress p.
 * Characters reveal sequentially: character i owns the progress slot [i/count, (i+1)/count]
 * and runs the preset's opacity track across that slot. Non per-character presets → 1.
 */
export function characterReveal(
  preset: AnimationPreset,
  index: number,
  count: number,
  p: number,
): number {
  if (!preset.perCharacter || count <= 0) return 1
  const local = p * count - index
  const track = preset.tracks.opacity
  if (!track) return local >= 1 ? 1 : 0
  return evaluateKeyframes(track, local <= 0 ? 0 : local >= 1 ? 1 : local, 1)
}

/** Compose two prop sets: opacity/scale multiply, offsets/rotation add. Allocation-free into `out`. */
export function composeProps(
  out: AnimatedProps,
  a: Readonly<AnimatedProps>,
  b: Readonly<AnimatedProps>,
): AnimatedProps {
  out.opacity = a.opacity * b.opacity
  out.scale = a.scale * b.scale
  out.x = a.x + b.x
  out.y = a.y + b.y
  out.rotation = a.rotation + b.rotation
  return out
}

/** Which slot of a clip a TextAnimation plays in. */
export type AnimationSlot = 'in' | 'out' | 'loop'

/**
 * Normalised preset progress for an animation playing in `slot` of a clip of length
 * `clipDuration`, at clip-relative time t; `undefined` when the animation is not active.
 *
 * - `in` plays over [0, d]; `out` over [D − d, D]; `loop` repeats with period d.
 * - A preset authored for the opposite direction is played backwards (an `in` preset used
 *   as `animationOut` mirrors it), so every in-animation doubles as an out-animation.
 * - Before an in-animation starts the clip is not visible, so t < 0 never occurs; after it
 *   ends the final pose (p = 1) holds, which presets define as identity.
 */
export function presetProgress(
  preset: Pick<AnimationPreset, 'kind'>,
  slot: AnimationSlot,
  duration: number,
  clipDuration: number,
  t: number,
): number | undefined {
  const d = Math.min(duration, clipDuration)
  if (d <= 0) return undefined
  if (slot === 'loop') {
    const local = ((t % d) + d) % d
    return local / d
  }
  if (slot === 'in') {
    if (t >= d) return undefined
    const p = Math.max(0, t / d)
    return preset.kind === 'out' ? 1 - p : p
  }
  const startOut = clipDuration - d
  if (t < startOut) return undefined
  const p = Math.min(1, (t - startOut) / d)
  return preset.kind === 'in' ? 1 - p : p
}
