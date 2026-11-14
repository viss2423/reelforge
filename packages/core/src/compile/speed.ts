/**
 * Clip speed → source mapping and the FFmpeg filters that implement it.
 *
 * Semantics: the effective speed at clip-relative timeline time τ is
 * `clip.speed × ramp(τ)` where `ramp` evaluates `clip.speedRamp` with the shared keyframe
 * convention (1 when there are no keyframes). The source position is the integral of the
 * effective speed, so the source span consumed by a clip is `∫₀ᴰ speed(τ) dτ`.
 */
import type { Keyframe } from '../schema.ts'
import { evalKeyframes, num, piecewise } from './expr.ts'
import { filter } from './escape.ts'

/** One linear piece of the timeline↔source mapping (all values in us, clip-relative). */
export interface SpeedSegment {
  /** Timeline start/end. */
  t0: number
  t1: number
  /** Source start/end (offset from the clip in-point). */
  s0: number
  s1: number
}

export interface SpeedMap {
  /** Source microseconds consumed by the clip. */
  sourceSpan: number
  /** Set when the speed never changes. */
  constant: number | undefined
  /** Piecewise-linear mapping (one segment when constant). */
  segments: SpeedSegment[]
}

const MIN_SPEED = 0.01
/** Timeline resolution of the ramp integration (us) and the cap on mapping pieces. */
const INTEGRATION_STEP_US = 5_000
const MAX_VIDEO_SEGMENTS = 48

interface SpeedSource {
  duration: number
  speed: number
  speedRamp: readonly Keyframe[]
}

const rampIsFlat = (ramp: readonly Keyframe[]): boolean =>
  ramp.every((k) => k.value === ramp[0]!.value)

/** Build the speed map of a clip (timeline duration → source span). */
export function speedMap(clip: SpeedSource): SpeedMap {
  const D = clip.duration
  if (rampIsFlat(clip.speedRamp)) {
    const v = Math.max(MIN_SPEED, clip.speed * (clip.speedRamp[0]?.value ?? 1))
    const span = Math.max(1, Math.round(D * v))
    return { sourceSpan: span, constant: v, segments: [{ t0: 0, t1: D, s0: 0, s1: span }] }
  }
  const speedAt = (t: number): number =>
    Math.max(MIN_SPEED, clip.speed * evalKeyframes(clip.speedRamp, t, 1))
  // Piece boundaries: every keyframe plus an even grid so eased segments stay accurate.
  const pieces = Math.min(MAX_VIDEO_SEGMENTS, Math.max(1, Math.ceil(D / 100_000)))
  const cuts = new Set<number>([0, D])
  for (let i = 1; i < pieces; i++) cuts.add(Math.round((i * D) / pieces))
  for (const k of clip.speedRamp) if (k.t > 0 && k.t < D) cuts.add(k.t)
  const bounds = [...cuts].toSorted((a, b) => a - b)
  const segments: SpeedSegment[] = []
  let s = 0
  for (let i = 0; i + 1 < bounds.length; i++) {
    const t0 = bounds[i]!
    const t1 = bounds[i + 1]!
    // Trapezoid integration on a fine grid.
    const steps = Math.max(1, Math.ceil((t1 - t0) / INTEGRATION_STEP_US))
    let area = 0
    for (let j = 0; j < steps; j++) {
      const a = t0 + ((t1 - t0) * j) / steps
      const b = t0 + ((t1 - t0) * (j + 1)) / steps
      area += ((speedAt(a) + speedAt(b)) / 2) * (b - a)
    }
    segments.push({ t0, t1, s0: s, s1: s + area })
    s += area
  }
  const span = Math.max(1, Math.round(s))
  return { sourceSpan: span, constant: undefined, segments }
}

/**
 * `setpts` that maps source time (input pts starting at 0) to clip timeline time.
 * Returns undefined for speed 1.
 */
export function videoSpeedFilter(map: SpeedMap): string | undefined {
  if (map.constant !== undefined) {
    if (Math.abs(map.constant - 1) < 1e-9) return undefined
    return `setpts=(PTS-STARTPTS)/${num(map.constant)}`
  }
  const x = '(T-STARTT)'
  const bounds = map.segments.slice(1).map((g) => g.s0 / 1e6)
  const leaves = map.segments.map((g) => {
    const slope = (g.t1 - g.t0) / Math.max(1e-9, g.s1 - g.s0)
    return `(${num(g.t0 / 1e6)}+(${x}-${num(g.s0 / 1e6)})*${num(slope)})`
  })
  return filter('setpts', { expr: `${piecewise(x, bounds, leaves)}/TB` })
}

/**
 * Audio filters that change tempo by `speed`.
 * - preservePitch + high quality → `rubberband` (best transient handling);
 * - preservePitch otherwise      → `atempo` chain (fast WSOLA; each stage limited to ≥0.5);
 * - !preservePitch               → resample (tape-style: pitch follows speed).
 * The input must already be 48 kHz.
 */
export function tempoFilters(speed: number, preservePitch: boolean, hq: boolean): string[] {
  if (Math.abs(speed - 1) < 1e-9) return []
  if (!preservePitch) return [`asetrate=${num(48_000 * speed)}`, 'aresample=48000']
  if (hq) return [`rubberband=tempo=${num(speed)}`]
  const out: string[] = []
  let rest = speed
  while (rest < 0.5) {
    out.push('atempo=0.5')
    rest /= 0.5
  }
  while (rest > 100) {
    out.push('atempo=100')
    rest /= 100
  }
  out.push(`atempo=${num(rest)}`)
  return out
}

/**
 * Piecewise-constant tempo segments for audio under a speed ramp, merged to at most
 * `maxSegments` pieces (audio cannot follow a continuous ramp without artefacts anyway).
 */
export function audioRampSegments(map: SpeedMap, maxSegments = 12): SpeedSegment[] {
  const segs = map.segments
  if (segs.length <= maxSegments) return segs
  const out: SpeedSegment[] = []
  const per = Math.ceil(segs.length / maxSegments)
  for (let i = 0; i < segs.length; i += per) {
    const a = segs[i]!
    const b = segs[Math.min(segs.length, i + per) - 1]!
    out.push({ t0: a.t0, t1: b.t1, s0: a.s0, s1: b.s1 })
  }
  return out
}

/** Source offset (us from the in-point) shown at clip-relative timeline time `t`. */
export function sourceAt(map: SpeedMap, t: number): number {
  for (const g of map.segments) {
    if (t <= g.t1) {
      const f = g.t1 === g.t0 ? 0 : (Math.max(t, g.t0) - g.t0) / (g.t1 - g.t0)
      return g.s0 + (g.s1 - g.s0) * f
    }
  }
  return map.segments.at(-1)?.s1 ?? 0
}

/**
 * The part of a speed map covering timeline `[t0, t1)`, rebased so both timeline and source
 * start at 0 (used when a render window cuts a clip's head or tail).
 */
export function sliceSpeedMap(map: SpeedMap, t0: number, t1: number): SpeedMap {
  const s0 = sourceAt(map, t0)
  const span = Math.max(1, Math.round(sourceAt(map, t1) - s0))
  if (map.constant !== undefined) {
    return {
      sourceSpan: span,
      constant: map.constant,
      segments: [{ t0: 0, t1: t1 - t0, s0: 0, s1: span }],
    }
  }
  const segments: SpeedSegment[] = []
  for (const g of map.segments) {
    const a = Math.max(g.t0, t0)
    const b = Math.min(g.t1, t1)
    if (b <= a) continue
    segments.push({ t0: a - t0, t1: b - t0, s0: sourceAt(map, a) - s0, s1: sourceAt(map, b) - s0 })
  }
  return { sourceSpan: span, constant: undefined, segments }
}
