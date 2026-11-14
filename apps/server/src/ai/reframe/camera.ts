/**
 * Virtual camera for auto-reframe: turns per-frame face detections into a smooth horizontal
 * subject path (pure functions, no I/O).
 *
 * 1. Tracking — faces are linked across samples by IoU (with a centre-distance fallback for
 *    fast motion at a 5 Hz sample rate); tracks never cross a shot cut.
 * 2. Subject — every track gets a weight Σ score·√(relative area): large AND persistent
 *    faces win. The best visible track becomes the subject, with hysteresis so a passer-by
 *    must dominate for a second before the camera switches.
 * 3. Gaps — short detection drop-outs are held/interpolated; a shot with no face at all is
 *    centred.
 * 4. Camera — a dead zone (the camera re-frames only when the subject leaves it, or sits
 *    off-centre for a while) followed by a zero-phase critically damped spring (forward +
 *    backward pass): pans ease in and out, never overshoot, and — because the analysis is
 *    offline — start slightly before the subject moves, like a human operator. Cuts are
 *    hard: the spring is reset per shot.
 */
import { iou, type Face } from './yunet.ts'

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

interface Track {
  id: number
  shot: number
  /** Sample index → face. */
  obs: Map<number, Face>
  last: number
  weight: number
}

/** Samples a track may go undetected and still be continued (1 s at 5 Hz). */
const MAX_GAP = 5
/** Samples a challenger must be the best track before the camera switches subject. */
const SWITCH_AFTER = 5
/** Samples the subject may sit off-centre inside the dead zone before a gentle re-frame. */
const DRIFT_AFTER = 10
/** Tracks seen in fewer samples are detector noise for `facesFound`. */
const MIN_TRACK_SAMPLES = 3
/** Constant-run tolerance when compressing the path (≈ 0.5 px on a 1080-wide canvas). */
const FLAT_EPS = 5e-4

const centreX = (f: Face): number => f.x + f.w / 2
const centreY = (f: Face): number => f.y + f.h / 2

/** Association affinity in [0, 1+]: IoU, else a distance-based score for similar-size faces. */
const affinity = (a: Face, b: Face): number => {
  const o = iou(a, b)
  if (o > 0.1) return 1 + o
  const size = Math.max(a.w, a.h, b.w, b.h)
  const ratio = (a.w * a.h) / (b.w * b.h)
  if (ratio < 0.4 || ratio > 2.5) return 0
  const d = Math.hypot(centreX(a) - centreX(b), centreY(a) - centreY(b)) / size
  return d < 1 ? 1 - d : 0
}

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

/** Link detections into tracks with greedy best-affinity matching per sample. */
export const buildTracks = (
  frames: readonly FrameFaces[],
  shots: Int32Array,
  frameArea: number,
): Track[] => {
  const tracks: Track[] = []
  for (let i = 0; i < frames.length; i++) {
    const faces = frames[i]?.faces ?? []
    const shot = shots[i] ?? 0
    const active = tracks.filter((t) => t.shot === shot && i - t.last <= MAX_GAP)
    const pairs: Array<{ t: Track; f: number; a: number }> = []
    for (const t of active) {
      const last = t.obs.get(t.last)
      if (!last) continue
      for (let f = 0; f < faces.length; f++) {
        const face = faces[f]
        if (!face) continue
        const a = affinity(last, face)
        if (a > 0) pairs.push({ t, f, a })
      }
    }
    pairs.sort((p, q) => q.a - p.a)
    const usedTracks = new Set<Track>()
    const usedFaces = new Set<number>()
    for (const p of pairs) {
      if (usedTracks.has(p.t) || usedFaces.has(p.f)) continue
      usedTracks.add(p.t)
      usedFaces.add(p.f)
      const face = faces[p.f]
      if (face) {
        p.t.obs.set(i, face)
        p.t.last = i
      }
    }
    for (let f = 0; f < faces.length; f++) {
      const face = faces[f]
      if (usedFaces.has(f) || !face) continue
      tracks.push({ id: tracks.length, shot, obs: new Map([[i, face]]), last: i, weight: 0 })
    }
  }
  for (const t of tracks) {
    let w = 0
    for (const f of t.obs.values()) w += f.score * Math.sqrt((f.w * f.h) / frameArea)
    t.weight = w
  }
  return tracks
}

/** Track position at sample `i`: observed, or linearly interpolated inside a short gap. */
const trackX = (t: Track, i: number): number | undefined => {
  const f = t.obs.get(i)
  if (f) return centreX(f)
  let before = -1
  let after = -1
  for (let k = i - 1; k >= i - MAX_GAP; k--) {
    if (t.obs.has(k)) {
      before = k
      break
    }
  }
  if (before < 0) return undefined
  for (let k = i + 1; k <= i + MAX_GAP; k++) {
    if (t.obs.has(k)) {
      after = k
      break
    }
  }
  const a = t.obs.get(before)
  const b = t.obs.get(after)
  if (!a || !b) return undefined
  const u = (i - before) / (after - before)
  return centreX(a) + u * (centreX(b) - centreX(a))
}

/**
 * Subject centre per sample in detector px (NaN when no subject), choosing the heaviest
 * visible track with switch hysteresis. Also returns whether the subject was truly detected.
 */
export const subjectPath = (
  n: number,
  tracks: readonly Track[],
): { x: Float64Array; detected: Uint8Array } => {
  const x = new Float64Array(n).fill(Number.NaN)
  const detected = new Uint8Array(n)
  // Index tracks by the samples they cover (observed or bridged) to avoid an O(n·tracks) scan.
  const bySample: Track[][] = Array.from({ length: n }, () => [])
  for (const t of tracks) {
    const keys = [...t.obs.keys()]
    const first = keys[0] ?? 0
    for (let i = first; i <= t.last; i++) bySample[i]?.push(t)
  }
  let current: Track | undefined
  let challenger: Track | undefined
  let challengerRun = 0
  for (let i = 0; i < n; i++) {
    let best: Track | undefined
    let bestX = 0
    let currentX: number | undefined
    for (const t of bySample[i] ?? []) {
      const tx = trackX(t, i)
      if (tx === undefined) continue
      if (t === current) currentX = tx
      if (!best || t.weight > best.weight) {
        best = t
        bestX = tx
      }
    }
    if (!best) {
      current = undefined
      challengerRun = 0
      continue
    }
    if (current === undefined || currentX === undefined) {
      current = best
      currentX = bestX
      challengerRun = 0
    } else if (best !== current) {
      challengerRun = best === challenger ? challengerRun + 1 : 1
      challenger = best
      if (challengerRun >= SWITCH_AFTER) {
        current = best
        currentX = bestX
        challengerRun = 0
      }
    } else {
      challengerRun = 0
    }
    x[i] = currentX
    detected[i] = current.obs.has(i) ? 1 : 0
  }
  return { x, detected }
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
export const deadZone = (x: Float64Array, shots: Int32Array, zone: number): Float64Array => {
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
      if (++drift >= DRIFT_AFTER) {
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

/** Plan the reframe camera path from per-sample detections. */
export const planCamera = (frames: readonly FrameFaces[], opts: CameraOptions): CameraResult => {
  const n = frames.length
  if (n === 0) return { path: [], facesFound: 0, coverage: 0 }
  const { frameWidth: W, frameHeight: H } = opts
  const times = frames.map((f) => f.t)
  const cuts = (opts.cuts ?? []).toSorted((a, b) => a - b)
  const shots = shotIndices(times, cuts)
  const tracks = buildTracks(frames, shots, W * H)
  const { x: px, detected } = subjectPath(n, tracks)

  const x = new Float64Array(n)
  for (let i = 0; i < n; i++) x[i] = (px[i] ?? Number.NaN) / W
  fillGaps(x, shots, 0.5)
  const crop = Math.min(1, opts.cropFraction ?? (H * 9) / 16 / W)
  // A dead zone of ~12 % of the crop keeps small head movements from moving the camera.
  const zoned = deadZone(median3(x, shots), shots, 0.12 * crop)
  const smooth = smoothSpring(zoned, times, shots, opts.omega ?? 5)

  const path: PathPoint[] = []
  const round = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 10_000) / 10_000
  for (let i = 0; i < n; i++) {
    const t = times[i] ?? 0
    // Hard cut: pin the previous shot's framing right up to the cut, then jump.
    if (i > 0 && shots[i] !== shots[i - 1]) {
      const cut = cuts.find((c) => c > (times[i - 1] ?? 0) && c <= t) ?? t
      if (cut - 1 > (times[i - 1] ?? 0)) path.push({ t: cut - 1, x: round(smooth[i - 1] ?? 0.5) })
      if (cut < t) path.push({ t: cut, x: round(smooth[i] ?? 0.5) })
    }
    path.push({ t, x: round(smooth[i] ?? 0.5) })
  }
  let hits = 0
  for (let i = 0; i < n; i++) hits += detected[i] ?? 0
  return {
    path: compressPath(path),
    facesFound: tracks.filter((t) => t.obs.size >= MIN_TRACK_SAMPLES).length,
    coverage: Math.round((hits / n) * 1000) / 1000,
  }
}
