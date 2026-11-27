/**
 * Virtual camera building blocks for auto-reframe (pure functions, no I/O): shot indexing,
 * gap filling, glitch removal, a dead zone with re-centring and a zero-phase critically
 * damped spring — pans ease in and out, never overshoot, and (the analysis being offline)
 * start slightly before the subject moves, like a human operator. Cuts are hard: every
 * filter runs per shot. Subject selection lives in planner.ts; `planCamera` is the
 * faces-only entry point kept for the YuNet fallback.
 */
import { planReframe } from './planner.ts'
import type { Face } from './yunet.ts'

/** Detections of one sampled frame; `t` is source time in us. */
export interface FrameFaces {
  t: number
  faces: readonly Face[]
}

export interface PathPoint {
  /** Source time (us). */
  t: number
  /** Subject centre as a fraction 0..1 of the source width. */
  x: number
}

export interface CameraOptions {
  /** Detector frame size in px (the coordinate space of the faces). */
  frameWidth: number
  frameHeight: number
  /** Source times (us) of shot cuts; the camera jumps instead of panning across them. */
  cuts?: readonly number[]
  /**
   * Width of the 9:16 crop as a fraction of the source width (sizes the dead zone).
   * Default: derived from the frame aspect ratio, capped at 1.
   */
  cropFraction?: number
  /** Spring angular frequency (rad/s); higher follows faster. */
  omega?: number
}

export interface CameraResult {
  path: PathPoint[]
  /** Distinct, persistent faces (tracks seen in ≥ 3 samples). */
  facesFound: number
  /** Fraction of samples in which the chosen subject was detected. */
  coverage: number
}

/** Samples the subject may sit off-centre inside the dead zone before a gentle re-frame. */
const DRIFT_AFTER = 10
/** Constant-run tolerance when compressing the path (≈ 0.5 px on a 1080-wide canvas). */
const FLAT_EPS = 5e-4

/** Shot index of every sample (cuts split shots; a cut at time c starts a shot at c). */
export const shotIndices = (times: readonly number[], cuts: readonly number[] = []): Int32Array => {
  const sorted = cuts.toSorted((a, b) => a - b)
  const out = new Int32Array(times.length)
  let shot = 0
  for (let i = 0; i < times.length; i++) {
    while (shot < sorted.length && (times[i] ?? 0) >= (sorted[shot] ?? Infinity)) shot++
    out[i] = shot
  }
  return out
}

/** Fill NaN gaps per shot: hold the previous value (or the next one at a shot start); empty shots → `fallback`. */
export const fillGaps = (x: Float64Array, shots: Int32Array, fallback: number): void => {
  const n = x.length
  for (let s = 0; s < n;) {
    let e = s
    while (e < n && shots[e] === shots[s]) e++
    let prev = Number.NaN
    for (let i = s; i < e; i++) {
      if (Number.isNaN(x[i] ?? Number.NaN)) x[i] = prev
      else prev = x[i] ?? prev
    }
    let next = Number.NaN
    for (let i = e - 1; i >= s; i--) {
      if (Number.isNaN(x[i] ?? Number.NaN)) x[i] = next
      else next = x[i] ?? next
    }
    for (let i = s; i < e; i++) if (Number.isNaN(x[i] ?? Number.NaN)) x[i] = fallback
    s = e
  }
}

/** 3-tap median within shots: removes single-sample detector glitches without lag. */
export const median3 = (x: Float64Array, shots: Int32Array): Float64Array => {
  const out = Float64Array.from(x)
  for (let i = 1; i < x.length - 1; i++) {
    if (shots[i - 1] !== shots[i] || shots[i + 1] !== shots[i]) continue
    const a = x[i - 1] ?? 0
    const b = x[i] ?? 0
    const c = x[i + 1] ?? 0
    out[i] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))
  }
  return out
}

/**
 * Dead zone with re-centring: the camera target stays put while the subject is within
 * ±`zone` of it, and jumps to the subject when it leaves the zone (the spring turns jumps
 * into pans) or lingers beyond half the zone for `DRIFT_AFTER` samples.
 */
export const deadZone = (
  x: Float64Array,
  shots: Int32Array,
  zone: number,
  driftAfter = DRIFT_AFTER,
): Float64Array => {
  const out = new Float64Array(x.length)
  let cam = x[0] ?? 0.5
  let drift = 0
  for (let i = 0; i < x.length; i++) {
    const v = x[i] ?? cam
    if (i === 0 || shots[i] !== shots[i - 1]) {
      cam = v
      drift = 0
    }
    const d = Math.abs(v - cam)
    if (d > zone) {
      cam = v
      drift = 0
    } else if (d > zone / 2) {
      if (++drift >= driftAfter) {
        cam = v
        drift = 0
      }
    } else {
      drift = 0
    }
    out[i] = cam
  }
  return out
}

/** One exact step of a critically damped spring towards `goal` (stable for any dt). */
const springStep = (
  pos: number,
  vel: number,
  goal: number,
  omega: number,
  dt: number,
): [number, number] => {
  const y = pos - goal
  const e = Math.exp(-omega * dt)
  const c = vel + omega * y
  return [goal + (y + c * dt) * e, (vel - omega * c * dt) * e]
}

/**
 * Zero-phase critically damped smoothing within shots: forward pass, then the same filter
 * run backwards over its output (like filtfilt) — no lag, no overshoot.
 */
export const smoothSpring = (
  x: Float64Array,
  times: readonly number[],
  shots: Int32Array,
  omega: number,
): Float64Array => {
  const out = Float64Array.from(x)
  const n = x.length
  for (let s = 0; s < n;) {
    let e = s
    while (e < n && shots[e] === shots[s]) e++
    for (const dir of [1, -1] as const) {
      const from = dir === 1 ? s : e - 1
      let pos = out[from] ?? 0
      let vel = 0
      for (let i = from + dir; dir === 1 ? i < e : i >= s; i += dir) {
        const dt = Math.abs((times[i] ?? 0) - (times[i - dir] ?? 0)) / 1_000_000
        ;[pos, vel] = springStep(pos, vel, out[i] ?? pos, omega, dt)
        out[i] = pos
      }
    }
    s = e
  }
  return out
}

/** Drop interior points of constant runs (exact under any keyframe easing). */
export const compressPath = (path: readonly PathPoint[], eps = FLAT_EPS): PathPoint[] => {
  const out: PathPoint[] = []
  for (let i = 0; i < path.length; i++) {
    const p = path[i]
    if (!p) continue
    const prev = path[i - 1]
    const next = path[i + 1]
    const flat =
      prev !== undefined &&
      next !== undefined &&
      Math.abs(prev.x - p.x) <= eps &&
      Math.abs(next.x - p.x) <= eps
    if (!flat) out.push(p)
  }
  return out
}

/**
 * Plan the reframe camera path from per-sample face detections (YuNet only). Delegates to
 * the full planner (planner.ts) without people, objects or zoom.
 */
export const planCamera = (frames: readonly FrameFaces[], opts: CameraOptions): CameraResult => {
  const r = planReframe(
    frames.map((f) => ({ t: f.t, faces: f.faces })),
    {
      frameWidth: opts.frameWidth,
      frameHeight: opts.frameHeight,
      maxZoomOut: 1,
      ...(opts.cuts ? { cuts: opts.cuts } : {}),
      ...(opts.cropFraction !== undefined ? { cropFraction: opts.cropFraction } : {}),
    },
  )
  return {
    path: r.path.map(({ t, x }) => ({ t, x })),
    facesFound: r.facesFound,
    coverage: r.coverage,
  }
}
