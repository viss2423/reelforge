/**
 * Timeline ⇄ source time mapping for media and audio clips.
 *
 * DEFINITION (speed ramps)
 * Let τ be clip-relative timeline time (0 ≤ τ ≤ duration). The instantaneous playback speed
 * is v(τ) = clip.speed × r(τ), where r(τ) = evaluateKeyframes(clip.speedRamp, τ, 1) (so an
 * empty ramp means r ≡ 1, and before/after the first/last ramp keyframe r holds). The SOURCE
 * OFFSET consumed after τ is the integral
 *   O(τ) = ∫₀^τ v(u) du        (exact closed forms for every easing except elastic)
 * and the clip's SOURCE SPAN is O(duration). A forward clip shows source time in + O(τ);
 * a reversed clip shows in + span − O(τ). Ramp values must be > 0 so O is strictly
 * increasing and invertible (validateProject enforces it).
 */
import { evaluateKeyframes, integrateKeyframes, keyframeIndexAt } from '../animation.ts'
import type { AudioClip, Keyframe, MediaClip, Us } from '../schema.ts'

export type TimedClip = MediaClip | AudioClip

/** Precomputed speed integral for one clip; build once per op, reuse across many lookups. */
export interface SpeedProfile {
  /** Source offset (µs, fractional) consumed after clip time τ ≥ 0. */
  offsetAt(tau: number): number
  /** Inverse of offsetAt: clip time (fractional) at which offset o ≥ 0 is reached. */
  timeAt(o: number): number
}

const constantProfile = (speed: number): SpeedProfile => ({
  offsetAt: (tau) => Math.max(0, tau) * speed,
  timeAt: (o) => Math.max(0, o) / speed,
})

const rampOf = (clip: TimedClip): readonly Keyframe[] =>
  clip.type === 'audio' ? [] : clip.speedRamp

/** Build the speed profile of a clip (constant fast path when there is no ramp). */
export function speedProfile(clip: TimedClip): SpeedProfile {
  const ramp = rampOf(clip)
  const speed = clip.speed
  if (ramp.length === 0) return constantProfile(speed)
  if (ramp.length === 1) return constantProfile(speed * ramp[0]!.value)

  // cum[i] = O(ramp[i].t) / speed — cumulative integral of r up to each keyframe.
  const n = ramp.length
  const cum = new Float64Array(n)
  cum[0] = ramp[0]!.value * ramp[0]!.t
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1]! + integrateKeyframes(ramp, ramp[i - 1]!.t, ramp[i]!.t, 1)
  }
  const first = ramp[0]!
  const last = ramp[n - 1]!

  const offsetAt = (tau: number): number => {
    const t = Math.max(0, tau)
    if (t <= first.t) return speed * first.value * t
    if (t >= last.t) return speed * (cum[n - 1]! + last.value * (t - last.t))
    const i = keyframeIndexAt(ramp, t)
    return speed * (cum[i]! + integrateKeyframes(ramp, ramp[i]!.t, t, 1))
  }

  const timeAt = (o: number): number => {
    const target = Math.max(0, o) / speed
    if (target <= cum[0]!) return target / first.value
    if (target >= cum[n - 1]!) return last.t + (target - cum[n - 1]!) / last.value
    // Segment i: cum[i] <= target < cum[i+1].
    let lo = 0
    let hi = n - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1
      if (cum[mid]! <= target) lo = mid
      else hi = mid
    }
    const a = ramp[lo]!
    const b = ramp[lo + 1]!
    const need = target - cum[lo]!
    const span = b.t - a.t
    if (b.easing === 'hold') return a.t + need / a.value
    if (b.easing === 'linear') {
      // need = a.v·x + (b.v − a.v)·x²/(2·span); solve the quadratic for x ∈ [0, span].
      const k = (b.value - a.value) / (2 * span)
      if (Math.abs(k) < 1e-15) return a.t + need / a.value
      const disc = a.value * a.value + 4 * k * need
      return a.t + (-a.value + Math.sqrt(Math.max(0, disc))) / (2 * k)
    }
    // Monotone bisection on the closed-form integral; 60 iterations hit double precision.
    let x0 = 0
    let x1 = span
    for (let it = 0; it < 60 && x1 - x0 > 1e-7; it++) {
      const mid = (x0 + x1) / 2
      if (integrateKeyframes(ramp, a.t, a.t + mid, 1) < need) x0 = mid
      else x1 = mid
    }
    return a.t + (x0 + x1) / 2
  }

  return { offsetAt, timeAt }
}

/** Source span (µs, rounded) a clip covers. Images report their timeline duration. */
export function sourceSpan(clip: TimedClip, profile = speedProfile(clip)): Us {
  if (clip.type === 'image') return clip.duration
  return Math.round(profile.offsetAt(clip.duration))
}

/** Source interval [start, end] (µs) covered by a clip. */
export function sourceRange(clip: TimedClip, profile = speedProfile(clip)): { start: Us; end: Us } {
  const span = sourceSpan(clip, profile)
  return { start: clip.in, end: clip.in + span }
}

const isReversed = (clip: TimedClip): boolean => clip.type !== 'audio' && clip.reverse

/** Clip-relative timeline time → source time (fractional µs). */
export function clipTimeToSourceExact(clip: TimedClip, tau: number, profile = speedProfile(clip)) {
  if (clip.type === 'image') return clip.in
  const t = Math.min(Math.max(0, tau), clip.duration)
  const o = profile.offsetAt(t)
  if (!isReversed(clip)) return clip.in + o
  return clip.in + profile.offsetAt(clip.duration) - o
}

/** Clip-relative timeline time → source time (µs). */
export const clipTimeToSource = (clip: TimedClip, tau: number, profile = speedProfile(clip)): Us =>
  Math.round(clipTimeToSourceExact(clip, tau, profile))

/** Source time → clip-relative time (fractional µs), or undefined outside the clip's span. */
export function sourceToClipTimeExact(
  clip: TimedClip,
  s: number,
  profile = speedProfile(clip),
): number | undefined {
  if (clip.type === 'image') return undefined
  const span = profile.offsetAt(clip.duration)
  const o = isReversed(clip) ? clip.in + span - s : s - clip.in
  // Half a µs of slack absorbs the rounding of integer source times at the span edges.
  if (o < -0.5 || o > span + 0.5) return undefined
  return Math.min(clip.duration, Math.max(0, profile.timeAt(Math.min(Math.max(o, 0), span))))
}

/** Source time → clip-relative time (µs), or undefined outside the clip's span. */
export function sourceToClipTime(
  clip: TimedClip,
  s: number,
  profile = speedProfile(clip),
): Us | undefined {
  const tau = sourceToClipTimeExact(clip, s, profile)
  return tau === undefined ? undefined : Math.round(tau)
}

/**
 * Map timeline time → source time for a media/audio clip (respects speed, reverse, ramps).
 * `t` is measured against `clip.start`; for main-track clips with transitions pass the
 * effective start instead via `clipTimeToSource(clip, t − mainTrackLayout(p)[i].start)`.
 * Times outside the clip clamp to its first/last source frame.
 */
export function timelineToSource(clip: MediaClip | AudioClip, t: Us): Us {
  return clipTimeToSource(clip, t - clip.start)
}

/**
 * Map source time → timeline time (relative to `clip.start`, see timelineToSource), or
 * undefined if that source time is not part of the clip.
 */
export function sourceToTimeline(clip: MediaClip | AudioClip, s: Us): Us | undefined {
  const tau = sourceToClipTime(clip, s)
  return tau === undefined ? undefined : clip.start + tau
}

/** Instantaneous playback speed at clip time τ (clip.speed × ramp multiplier). */
export const speedAt = (clip: TimedClip, tau: number): number =>
  clip.speed * evaluateKeyframes(rampOf(clip), tau, 1)
