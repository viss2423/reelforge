/**
 * Time-varying scalar "signals" with two synchronised backends:
 * - `expr(t)`: an FFmpeg expression of the time expression `t` (seconds, clip-relative);
 * - `at(us)`: the same value evaluated in JS (clip-relative microseconds).
 *
 * The JS side is used to decide graph shape (e.g. whether a zoom always covers the canvas),
 * to sample values for `sendcmd` (filters without per-frame expressions) and in tests, which
 * evaluate both backends and compare them.
 */
import type { Animatable, Easing, Keyframe } from '../schema.ts'
import { EASINGS, evalKeyframes, keyframesExpr, num } from './expr.ts'

export interface Signal {
  /** Set when the signal never changes. */
  readonly constant: number | undefined
  /** FFmpeg expression; `t` must be an atomic or parenthesised expression in seconds. */
  expr(t: string): string
  /** Value at clip-relative time `us`. */
  at(us: number): number
}

/** A constant signal. */
export function constant(value: number): Signal {
  const s = num(value)
  return { constant: value, expr: () => s, at: () => value }
}

/** Keyframes (clip-relative us) shifted by `offsetUs`, with an affine value map. */
export function fromKeyframes(
  keyframes: readonly Keyframe[],
  fallback: number,
  opts: { offsetUs?: number; mul?: number; add?: number } = {},
): Signal {
  const mul = opts.mul ?? 1
  const add = opts.add ?? 0
  const first = keyframes[0]
  if (!first || keyframes.every((k) => k.value === first.value)) {
    return constant((first?.value ?? fallback) * mul + add)
  }
  const offset = opts.offsetUs ?? 0
  const shifted = offset === 0 ? keyframes : keyframes.map((k) => ({ ...k, t: k.t + offset }))
  return {
    constant: undefined,
    expr: (t) => keyframesExpr(shifted, fallback, t, { mul, add }),
    at: (us) => evalKeyframes(shifted, us, fallback) * mul + add,
  }
}

/** An Animatable as a signal (`v * mul + add`). */
export const fromAnimatable = (a: Animatable, mul = 1, add = 0): Signal =>
  fromKeyframes(a.keyframes, a.value, { mul, add })

/** Normalised (t ∈ 0..1) preset track keyframe, as used by pack animations. */
export interface NormalisedKeyframe {
  t: number
  value: number
  easing: Easing
}

/**
 * A pack-animation track placed on the clip timeline: normalised `t` spans
 * [startUs, startUs + durationUs]. Outside the window the edge values hold.
 */
export function fromPresetTrack(
  track: readonly NormalisedKeyframe[] | undefined,
  identity: number,
  startUs: number,
  durationUs: number,
): Signal {
  if (!track || track.length === 0 || durationUs <= 0) return constant(identity)
  const kfs: Keyframe[] = track.map((k) => ({
    t: Math.max(0, Math.round(startUs + k.t * durationUs)),
    value: k.value,
    easing: k.easing,
  }))
  return fromKeyframes(kfs, identity)
}

/** Sum of signals (constants folded). */
export function add(...signals: Signal[]): Signal {
  const parts = signals.filter((s) => s.constant !== 0)
  if (parts.length === 0) return constant(0)
  if (parts.every((s) => s.constant !== undefined)) {
    return constant(parts.reduce((acc, s) => acc + s.constant!, 0))
  }
  if (parts.length === 1) return parts[0]!
  return {
    constant: undefined,
    expr: (t) => `(${parts.map((s) => s.expr(t)).join('+')})`,
    at: (us) => parts.reduce((acc, s) => acc + s.at(us), 0),
  }
}

/** Product of signals (constants folded, ×1 dropped, ×0 short-circuits). */
export function mul(...signals: Signal[]): Signal {
  if (signals.some((s) => s.constant === 0)) return constant(0)
  const parts = signals.filter((s) => s.constant !== 1)
  if (parts.length === 0) return constant(1)
  if (parts.every((s) => s.constant !== undefined)) {
    return constant(parts.reduce((acc, s) => acc * s.constant!, 1))
  }
  if (parts.length === 1) return parts[0]!
  return {
    constant: undefined,
    expr: (t) => `(${parts.map((s) => s.expr(t)).join('*')})`,
    at: (us) => parts.reduce((acc, s) => acc * s.at(us), 1),
  }
}

/**
 * A signal that is `inner` inside the window [startUs, endUs) and `outside` elsewhere.
 * `inner` receives the time relative to the window start.
 */
export function windowed(
  startUs: number,
  endUs: number,
  inner: { expr(local: string): string; at(localUs: number): number },
  outside: number,
): Signal {
  const a = num(startUs / 1e6)
  const b = num(endUs / 1e6)
  const o = num(outside)
  return {
    constant: undefined,
    expr: (t) => `if(between(${t},${a},${b}),${inner.expr(`(${t}-${a})`)},${o})`,
    at: (us) => (us >= startUs && us <= endUs ? inner.at(us - startUs) : outside),
  }
}

/** Sample a signal at every output frame of [0, durationUs). */
export function sampleFrames(signal: Signal, durationUs: number, fps: number): number[] {
  const n = Math.max(1, Math.round((durationUs * fps) / 1e6))
  const out = Array.from<number>({ length: n })
  for (let i = 0; i < n; i++) out[i] = signal.at((i * 1e6) / fps)
  return out
}

/** Min and max of a signal over [0, durationUs], sampled per frame (includes overshoot). */
export function signalRange(
  signal: Signal,
  durationUs: number,
  fps: number,
): { min: number; max: number } {
  if (signal.constant !== undefined) return { min: signal.constant, max: signal.constant }
  let min = Infinity
  let max = -Infinity
  // Sample at 2× the frame rate so eased overshoot between frames is not missed.
  const n = Math.max(2, Math.ceil((durationUs * fps * 2) / 1e6))
  for (let i = 0; i <= n; i++) {
    const v = signal.at((i * durationUs) / n)
    if (v < min) min = v
    if (v > max) max = v
  }
  return { min, max }
}

/** Ease helper re-exported for effect generators. */
export const easeValue = (easing: Easing, p: number): number =>
  EASINGS[easing](Math.min(1, Math.max(0, p)))
