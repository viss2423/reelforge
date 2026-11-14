/**
 * FFmpeg expression generation for animated values.
 *
 * Keyframe semantics (shared with the web preview and core `animation.ts`):
 * - keyframe `t` is clip-relative microseconds; keyframes are sorted by `t`;
 * - the segment k[i] → k[i+1] uses `k[i+1].easing` (easing describes how you ARRIVE);
 * - `hold` is a step: the value stays `k[i].value` until `k[i+1].t`;
 * - before the first keyframe → first value; after the last → last value;
 * - no keyframes → the Animatable's static `value`.
 *
 * Easing curves are the classic cubic family (easings.net). {@link EASINGS} is the JS
 * reference and {@link easingExpr} emits the identical curve as an FFmpeg expression; unit
 * tests evaluate both and compare.
 */
import type { Animatable, Easing, Keyframe } from '../schema.ts'
import { CompileError } from './errors.ts'

/** Format a number for FFmpeg: ≤6 decimals, never exponent notation, no trailing zeros. */
export function num(x: number, digits = 6): string {
  if (!Number.isFinite(x)) throw new CompileError('invalid_number', `non-finite number: ${x}`)
  if (Number.isInteger(x)) return String(x)
  let s = x.toFixed(digits)
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  return s === '-0' ? '0' : s
}

/** Microseconds → FFmpeg seconds string. */
export const secs = (us: number): string => num(us / 1_000_000)

const BACK_C1 = 1.70158
const BACK_C3 = BACK_C1 + 1
const ELASTIC_C4 = (2 * Math.PI) / 3

/** Reference easing curves, p in 0..1 → eased progress. `hold` is a step (0 until the end). */
export const EASINGS: Readonly<Record<Easing, (p: number) => number>> = {
  linear: (p) => p,
  easeIn: (p) => p ** 3,
  easeOut: (p) => 1 - (1 - p) ** 3,
  easeInOut: (p) => (p < 0.5 ? 4 * p ** 3 : 1 - (2 - 2 * p) ** 3 / 2),
  easeOutBack: (p) => 1 + BACK_C3 * (p - 1) ** 3 + BACK_C1 * (p - 1) ** 2,
  easeOutElastic: (p) =>
    p <= 0 ? 0 : p >= 1 ? 1 : 2 ** (-10 * p) * Math.sin((p * 10 - 0.75) * ELASTIC_C4) + 1,
  hold: () => 0,
}

/** FFmpeg expression for `EASINGS[easing](p)`; `p` must be a parenthesised expression. */
export function easingExpr(easing: Easing, p: string): string {
  switch (easing) {
    case 'linear':
      return p
    case 'easeIn':
      return `pow(${p},3)`
    case 'easeOut':
      return `(1-pow(1-${p},3))`
    case 'easeInOut':
      return `if(lt(${p},0.5),4*pow(${p},3),1-pow(2-2*${p},3)/2)`
    case 'easeOutBack':
      return `(1+${num(BACK_C3)}*pow(${p}-1,3)+${num(BACK_C1)}*pow(${p}-1,2))`
    case 'easeOutElastic':
      return `if(lte(${p},0),0,if(gte(${p},1),1,pow(2,-10*${p})*sin((${p}*10-0.75)*${num(ELASTIC_C4)})+1))`
    case 'hold':
      return '0'
  }
}

/** Reference keyframe evaluation (clip-relative microseconds) implementing the convention. */
export function evalKeyframes(keyframes: readonly Keyframe[], t: number, fallback: number): number {
  const first = keyframes[0]
  if (!first) return fallback
  if (t <= first.t) return first.value
  for (let i = 1; i < keyframes.length; i++) {
    const b = keyframes[i]!
    if (t < b.t) {
      const a = keyframes[i - 1]!
      if (b.easing === 'hold') return a.value
      const p = (t - a.t) / (b.t - a.t)
      return a.value + (b.value - a.value) * EASINGS[b.easing](p)
    }
  }
  return keyframes[keyframes.length - 1]!.value
}

/** Value of an Animatable at clip-relative time t (us). */
export const evalAnimatable = (a: Animatable, t: number): number =>
  evalKeyframes(a.keyframes, t, a.value)

/** True when the value actually changes over time. */
export function isAnimated(a: Animatable): boolean {
  const [first, ...rest] = a.keyframes
  return first !== undefined && rest.some((k) => k.value !== first.value)
}

/** Constant value of a non-animated Animatable. */
export const staticValue = (a: Animatable): number => a.keyframes[0]?.value ?? a.value

/** Affine value mapping applied to keyframe values: `v * mul + add`. */
export interface Affine {
  mul?: number
  add?: number
}

const applyAffine = (v: number, m: Affine | undefined): number => v * (m?.mul ?? 1) + (m?.add ?? 0)

/**
 * Balanced binary `if(lt(x,b),…)` tree over sorted boundaries: leaf j covers
 * `[bounds[j-1], bounds[j])`, so `leaves.length === bounds.length + 1`. Depth is
 * O(log n), which keeps per-frame evaluation cheap for long keyframe lists.
 */
export function piecewise(x: string, bounds: readonly number[], leaves: readonly string[]): string {
  if (leaves.length !== bounds.length + 1) {
    throw new CompileError('invalid_piecewise', 'piecewise: leaves must be bounds + 1')
  }
  // Merge neighbouring identical leaves (e.g. "hold" segments next to the constant tails).
  const b: number[] = []
  const l: string[] = [leaves[0]!]
  for (let i = 0; i < bounds.length; i++) {
    const leaf = leaves[i + 1]!
    if (leaf === l[l.length - 1]) continue
    b.push(bounds[i]!)
    l.push(leaf)
  }
  const build = (lo: number, hi: number): string => {
    if (lo === hi) return l[lo]!
    const mid = (lo + hi) >> 1
    return `if(lt(${x},${num(b[mid]!)}),${build(lo, mid)},${build(mid + 1, hi)})`
  }
  return build(0, l.length - 1)
}

/**
 * Expression for keyframes evaluated at `tSec` (an expression in clip-relative SECONDS),
 * with an affine mapping applied to values (exact for affine maps because easing is a
 * convex combination). Returns a plain number string when the value is constant.
 */
export function keyframesExpr(
  keyframes: readonly Keyframe[],
  fallback: number,
  tSec: string,
  map?: Affine,
): string {
  const first = keyframes[0]
  if (!first || keyframes.every((k) => k.value === first.value)) {
    return num(applyAffine(first?.value ?? fallback, map))
  }
  const bounds: number[] = []
  const leaves: string[] = [num(applyAffine(first.value, map))]
  for (let i = 0; i < keyframes.length; i++) {
    const k = keyframes[i]!
    bounds.push(k.t / 1_000_000)
    const next = keyframes[i + 1]
    if (!next) {
      leaves.push(num(applyAffine(k.value, map)))
      break
    }
    const v0 = applyAffine(k.value, map)
    const v1 = applyAffine(next.value, map)
    if (next.easing === 'hold' || v0 === v1 || next.t === k.t) {
      leaves.push(num(v0))
      continue
    }
    const dur = (next.t - k.t) / 1_000_000
    const p = `((${tSec}-${num(k.t / 1_000_000)})/${num(dur)})`
    leaves.push(`(${num(v0)}+${num(v1 - v0)}*${easingExpr(next.easing, p)})`)
  }
  return piecewise(tSec, bounds, leaves)
}

/** {@link keyframesExpr} for an Animatable. */
export const animExpr = (a: Animatable, tSec: string, map?: Affine): string =>
  keyframesExpr(a.keyframes, a.value, tSec, map)

/**
 * Min/max an Animatable reaches, including easing overshoot (easeOutBack/Elastic), found by
 * dense sampling of every segment.
 */
export function animRange(a: Animatable): { min: number; max: number } {
  if (!isAnimated(a)) {
    const v = staticValue(a)
    return { min: v, max: v }
  }
  let min = Infinity
  let max = -Infinity
  const ks = a.keyframes
  for (let i = 0; i < ks.length; i++) {
    const k = ks[i]!
    min = Math.min(min, k.value)
    max = Math.max(max, k.value)
    const next = ks[i + 1]
    if (!next || next.easing === 'hold' || next.easing === 'linear') continue
    for (let s = 1; s < 64; s++) {
      const v = k.value + (next.value - k.value) * EASINGS[next.easing](s / 64)
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
  }
  return { min, max }
}
