/**
 * Subject selection and framing for auto-reframe (pure functions, no I/O). Turns per-sample
 * detections into a smooth 9:16 crop path: horizontal centre `x` and, when a group has to
 * stay in frame, a wider visible width `w` (both as fractions of the source width).
 *
 * 1. Candidates — person boxes (D-FINE) carry the face found inside them (YuNet); faces
 *    without a body box (close-ups, or no person model installed) stand on their own.
 * 2. Tracking — candidates are linked across samples by IoU with a centre-distance
 *    fallback; tracks never cross a shot cut.
 * 3. Who to follow — every track scores Σ confidence·√area·centrality (large, central,
 *    persistent subjects win), boosted while it is the active speaker: mouth movement
 *    (frame difference in the mouth region minus the eye region, so head motion cancels)
 *    gated by speech energy in the audio. Switching needs the challenger to win for a
 *    while (hysteresis), scaled by the tracking strength.
 * 4. Groups — when several significant people are visible and fit inside the crop (or a
 *    bounded zoom-out of it), the camera frames all of them; otherwise it follows the
 *    active speaker / main subject.
 * 5. Nobody in shot — the most salient COCO object (animal, vehicle, ball…), else the
 *    saliency-map centroid, else the centre.
 * 6. Camera — dead zone + zero-phase critically damped spring per shot (camera.ts), hard
 *    cuts at shot changes. `strength` (0 calm … 1 tight) sets dead zone, spring speed and
 *    switch hysteresis; 0.5 reproduces the original YuNet-only tuning.
 */
import {
  compressPath,
  deadZone,
  fillGaps,
  median3,
  shotIndices,
  smoothSpring,
  type PathPoint,
} from './camera.ts'
import type { Face } from './yunet.ts'

/** Axis-aligned box in detector-frame pixels. */
export interface Box {
  x: number
  y: number
  w: number
  h: number
  score: number
}

/** A face with optional appearance patches for mouth-activity measurement. */
export interface SampleFace extends Face {
  /** Mean luma of a small grid over the mouth region (0..1), same length every sample. */
  mouth?: Float32Array
  /** Same grid over the eye region: the head-motion baseline. */
  eyes?: Float32Array
}

/** Detections of one sampled frame; `t` is source time in us. */
export interface Sample {
  t: number
  faces: readonly SampleFace[]
  /** Person boxes (empty when the person model is not installed). */
  people?: readonly Box[]
  /** Salient non-person objects (animals, vehicles, balls…). */
  objects?: readonly Box[]
  /** Bounding box of the salient region from the saliency model (score = confidence). */
  saliency?: Box
  /** Speech energy at `t`, 0 (silence) … 1 (loud speech). */
  speech?: number
}

export interface PlanOptions {
  frameWidth: number
  frameHeight: number
  /** Source times (us) of shot cuts. */
  cuts?: readonly number[]
  /** Width of the 9:16 crop as a fraction of the source width (default from aspect). */
  cropFraction?: number
  /** 0 = calm (big dead zone, slow pans) … 1 = tight follow. Default 0.5. */
  strength?: number
  /**
   * Largest visible width relative to the crop when framing a group (1 = never zoom out;
   * default 1.4 → the clip scales down to ≥ 71 % and the blurred background shows).
   */
  maxZoomOut?: number
}

export interface PlannedPoint extends PathPoint {
  /** Visible width as a fraction of the source width; only present when zoomed out. */
  w?: number
}

export type FramingMode = 'subject' | 'group' | 'object' | 'saliency' | 'centre'

export interface PlanResult {
  path: PlannedPoint[]
  /** Distinct persistent people/faces (tracks seen in ≥ 3 samples). */
  subjects: number
  /** Persistent faces only (compatibility with the YuNet-only result). */
  facesFound: number
  /** Fraction of samples in which the framed subject was actually detected. */
  coverage: number
  /** Samples per framing mode. */
  modes: Record<FramingMode, number>
}

interface Candidate {
  box: Box
  face?: SampleFace
  /** Horizontal focus point (px): the face centre, else the upper body centre. */
  fx: number
  /** Horizontal extent that must stay in frame for group shots (px). */
  left: number
  right: number
}

interface Track {
  shot: number
  obs: Map<number, Candidate>
  first: number
  last: number
  weight: number
  hasFace: boolean
  /** Per-sample speaking score 0..1 (sparse; smoothed). */
  speaking: Map<number, number>
}

const MIN_TRACK_SAMPLES = 3
const cx = (b: Box): number => b.x + b.w / 2
const cy = (b: Box): number => b.y + b.h / 2

const iou = (a: Box, b: Box): number => {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  if (ix <= 0 || iy <= 0) return 0
  const inter = ix * iy
  return inter / (a.w * a.h + b.w * b.h - inter)
}

/** Association affinity: IoU, else a distance score for similar-size boxes (fast motion). */
const affinity = (a: Box, b: Box): number => {
  const o = iou(a, b)
  if (o > 0.1) return 1 + o
  const ratio = (a.w * a.h) / (b.w * b.h)
  if (ratio < 0.4 || ratio > 2.5) return 0
  const size = Math.max(a.w, a.h, b.w, b.h)
  const d = Math.hypot(cx(a) - cx(b), cy(a) - cy(b)) / size
  return d < 1 ? 1 - d : 0
}

/** Tunables derived from the tracking strength (0.5 = the original constants). */
export const strengthParams = (strength = 0.5) => {
  const s = Math.min(1, Math.max(0, strength))
  return {
    /** Dead zone half-width as a fraction of the crop width. */
    zone: 0.22 - 0.2 * s,
    /** Spring angular frequency (rad/s). */
    omega: 1.5 + 7 * s,
    /** Samples a challenger must win before the camera switches subject. */
    switchAfter: Math.round(8 - 6 * s),
    /** Samples off-centre inside the dead zone before a gentle re-frame. */
    driftAfter: Math.round(16 - 12 * s),
    /** Samples a track may go undetected and still be continued. */
    maxGap: 5,
  }
}

/** People (with their face) and lone faces of one sample. */
export const candidatesOf = (s: Sample): Candidate[] => {
  const out: Candidate[] = []
  const used = new Set<number>()
  for (const p of s.people ?? []) {
    // The face that belongs to this body: centre inside the box's upper 60 %, largest wins.
    let best = -1
    for (let i = 0; i < s.faces.length; i++) {
      const f = s.faces[i]
      if (!f || used.has(i)) continue
      const fx = cx(f)
      const fy = cy(f)
      if (fx < p.x || fx > p.x + p.w || fy < p.y || fy > p.y + 0.6 * p.h) continue
      if (best < 0 || f.w * f.h > (s.faces[best]?.w ?? 0) * (s.faces[best]?.h ?? 0)) best = i
    }
    const face = best >= 0 ? s.faces[best] : undefined
    if (best >= 0) used.add(best)
    out.push(
      face
        ? { box: p, face, fx: cx(face), left: face.x - 0.6 * face.w, right: face.x + 1.6 * face.w }
        : { box: p, fx: cx(p), left: p.x + 0.15 * p.w, right: p.x + 0.85 * p.w },
    )
  }
  for (let i = 0; i < s.faces.length; i++) {
    const f = s.faces[i]
    if (!f || used.has(i)) continue
    out.push({ box: f, face: f, fx: cx(f), left: f.x - 0.6 * f.w, right: f.x + 1.6 * f.w })
  }
  return out
}

/** Greedy best-affinity linking of per-sample boxes into tracks (generic over payload). */
export const linkTracks = <T extends { box: Box }>(
  perSample: readonly (readonly T[])[],
  shots: Int32Array,
  maxGap: number,
): Array<{ shot: number; obs: Map<number, T>; first: number; last: number }> => {
  const tracks: Array<{ shot: number; obs: Map<number, T>; first: number; last: number }> = []
  for (let i = 0; i < perSample.length; i++) {
    const items = perSample[i] ?? []
    const shot = shots[i] ?? 0
    const pairs: Array<{ t: number; f: number; a: number }> = []
    for (let k = 0; k < tracks.length; k++) {
      const t = tracks[k]
      if (!t || t.shot !== shot || i - t.last > maxGap) continue
      const last = t.obs.get(t.last)
      if (!last) continue
      for (let f = 0; f < items.length; f++) {
        const item = items[f]
        if (!item) continue
        const a = affinity(last.box, item.box)
        if (a > 0) pairs.push({ t: k, f, a })
      }
    }
    pairs.sort((p, q) => q.a - p.a)
    const usedT = new Set<number>()
    const usedF = new Set<number>()
    for (const p of pairs) {
      if (usedT.has(p.t) || usedF.has(p.f)) continue
      usedT.add(p.t)
      usedF.add(p.f)
      const t = tracks[p.t]
      const item = items[p.f]
      if (t && item) {
        t.obs.set(i, item)
        t.last = i
      }
    }
    for (let f = 0; f < items.length; f++) {
      const item = items[f]
      if (!usedF.has(f) && item) tracks.push({ shot, obs: new Map([[i, item]]), first: i, last: i })
    }
  }
  return tracks
}

const patchDiff = (a: Float32Array | undefined, b: Float32Array | undefined): number => {
  if (!a || !b || a.length !== b.length || a.length === 0) return Number.NaN
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs((a[i] ?? 0) - (b[i] ?? 0))
  return s / a.length
}

/**
 * Speaking score per sample of one face track: mouth-region change minus eye-region change
 * between consecutive observations, gated by speech energy, smoothed over ±`radius`.
 */
export const speakingScores = (
  track: { obs: Map<number, Candidate> },
  speech: (i: number) => number,
  radius = 3,
): Map<number, number> => {
  const raw = new Map<number, number>()
  for (const [i, c] of track.obs) {
    const prev = track.obs.get(i - 1)
    if (!prev?.face || !c.face) continue
    const m = patchDiff(c.face.mouth, prev.face.mouth)
    if (Number.isNaN(m)) continue
    const e = patchDiff(c.face.eyes, prev.face.eyes)
    const act = Math.max(0, m - (Number.isNaN(e) ? 0 : e))
    raw.set(i, act * speech(i))
  }
  const out = new Map<number, number>()
  for (const i of track.obs.keys()) {
    let s = 0
    let n = 0
    for (let k = i - radius; k <= i + radius; k++) {
      const v = raw.get(k)
      if (v !== undefined) {
        s += v
        n++
      }
    }
    if (n > 0) out.set(i, s / n)
  }
  return out
}

/** Track value at sample i: observed, or linearly interpolated inside a short gap. */
const at = <T>(
  t: { obs: Map<number, T> },
  i: number,
  maxGap: number,
  get: (c: T) => number,
): number | undefined => {
  const o = t.obs.get(i)
  if (o) return get(o)
  let before = -1
  for (let k = i - 1; k >= i - maxGap; k--) {
    if (t.obs.has(k)) {
      before = k
      break
    }
  }
  if (before < 0) return undefined
  for (let k = i + 1; k <= i + maxGap; k++) {
    const b = t.obs.get(k)
    const a = t.obs.get(before)
    if (b && a) return get(a) + ((i - before) / (k - before)) * (get(b) - get(a))
  }
  return undefined
}

/** Plan the reframe path from per-sample detections. */
export const planReframe = (samples: readonly Sample[], opts: PlanOptions): PlanResult => {
  const modes: Record<FramingMode, number> = {
    subject: 0,
    group: 0,
    object: 0,
    saliency: 0,
    centre: 0,
  }
  const n = samples.length
  if (n === 0) return { path: [], subjects: 0, facesFound: 0, coverage: 0, modes }
  const W = opts.frameWidth
  const H = opts.frameHeight
  const P = strengthParams(opts.strength)
  const crop = Math.min(1, opts.cropFraction ?? (H * 9) / 16 / W)
  const maxZoom = Math.max(1, opts.maxZoomOut ?? 1.4)
  const times = samples.map((s) => s.t)
  const cuts = (opts.cuts ?? []).toSorted((a, b) => a - b)
  const shots = shotIndices(times, cuts)
  const frameArea = W * H

  // --- people / faces
  const cands = samples.map(candidatesOf)
  const tracks: Track[] = linkTracks(cands, shots, P.maxGap).map((t) => {
    let w = 0
    let hasFace = false
    for (const c of t.obs.values()) {
      const centrality = 1 - Math.min(0.5, Math.abs(cx(c.box) / W - 0.5))
      w += c.box.score * Math.sqrt((c.box.w * c.box.h) / frameArea) * centrality
      if (c.face) hasFace = true
    }
    return { ...t, weight: w, hasFace, speaking: new Map<number, number>() }
  })
  const speechAt = (i: number): number => {
    const v = samples[i]?.speech
    return v === undefined ? 1 : Math.min(1, Math.max(0, v))
  }
  for (const t of tracks) if (t.hasFace) t.speaking = speakingScores(t, speechAt)
  // Normalise speaking per shot so the boost is relative to the shot's loudest mouth.
  const shotMaxSpeak = new Map<number, number>()
  for (const t of tracks)
    for (const v of t.speaking.values())
      shotMaxSpeak.set(t.shot, Math.max(shotMaxSpeak.get(t.shot) ?? 0, v))
  const shotMaxWeight = new Map<number, number>()
  for (const t of tracks)
    shotMaxWeight.set(t.shot, Math.max(shotMaxWeight.get(t.shot) ?? 0, t.weight))

  const bySample: Track[][] = Array.from({ length: n }, () => [])
  for (const t of tracks) for (let i = t.first; i <= t.last; i++) bySample[i]?.push(t)

  const score = (t: Track, i: number): number => {
    const base = t.weight / (shotMaxWeight.get(t.shot) || 1)
    const maxS = shotMaxSpeak.get(t.shot) ?? 0
    // Below a noise floor nobody counts as speaking.
    const sp = maxS > 0.004 ? (t.speaking.get(i) ?? 0) / maxS : 0
    return base * (1 + 2 * sp)
  }

  const x = new Float64Array(n).fill(Number.NaN)
  const w = new Float64Array(n).fill(crop)
  const detected = new Uint8Array(n)
  const mode: FramingMode[] = Array.from({ length: n }, () => 'centre')
  let current: Track | undefined
  let challenger: Track | undefined
  let run = 0
  for (let i = 0; i < n; i++) {
    if (i > 0 && shots[i] !== shots[i - 1]) {
      current = undefined
      run = 0
    }
    const visible: Array<{ t: Track; fx: number; left: number; right: number; area: number }> = []
    for (const t of bySample[i] ?? []) {
      const fx = at(t, i, P.maxGap, (c) => c.fx)
      if (fx === undefined) continue
      const left = at(t, i, P.maxGap, (c) => c.left) ?? fx
      const right = at(t, i, P.maxGap, (c) => c.right) ?? fx
      const area = at(t, i, P.maxGap, (c) => c.box.w * c.box.h) ?? 0
      visible.push({ t, fx, left, right, area })
    }
    if (visible.length === 0) {
      current = undefined
      run = 0
      continue
    }
    let best = visible[0]
    for (const v of visible) if (best && score(v.t, i) > score(best.t, i)) best = v
    if (!best) continue
    const cur = visible.find((v) => v.t === current)
    let chosen = cur
    if (!cur) {
      current = best.t
      chosen = best
      run = 0
    } else if (best.t !== current) {
      run = best.t === challenger ? run + 1 : 1
      challenger = best.t
      if (run >= P.switchAfter) {
        current = best.t
        chosen = best
        run = 0
      }
    } else run = 0
    if (!chosen) continue

    // Group framing: significant people = comparable size and weight to the largest.
    const maxArea = Math.max(...visible.map((v) => v.area))
    const maxW = Math.max(...visible.map((v) => v.t.weight))
    const group = visible.filter(
      (v) => v.area >= 0.35 * maxArea && v.t.weight >= 0.25 * maxW && v.t.obs.size >= 2,
    )
    if (group.length >= 2) {
      const left = Math.min(...group.map((v) => v.left)) / W
      const right = Math.max(...group.map((v) => v.right)) / W
      const span = (right - left) / 0.92 // keep a margin either side
      if (span <= crop * maxZoom) {
        x[i] = (left + right) / 2
        w[i] = Math.max(crop, span)
        mode[i] = 'group'
        detected[i] = 1
        continue
      }
    }
    x[i] = chosen.fx / W
    mode[i] = 'subject'
    detected[i] = chosen.t.obs.has(i) ? 1 : 0
  }

  // --- shots without people: salient objects, then the saliency map, then the centre.
  const peopleShots = new Set<number>()
  for (let i = 0; i < n; i++) if (!Number.isNaN(x[i] ?? Number.NaN)) peopleShots.add(shots[i] ?? 0)
  const objects = samples.map((s, i) =>
    peopleShots.has(shots[i] ?? 0) ? [] : (s.objects ?? []).map((box) => ({ box })),
  )
  const objectTracks = linkTracks(objects, shots, P.maxGap).map((t) => {
    let wgt = 0
    for (const o of t.obs.values()) wgt += o.box.score * Math.sqrt((o.box.w * o.box.h) / frameArea)
    return { ...t, weight: wgt }
  })
  const objectsBySample: (typeof objectTracks)[] = Array.from({ length: n }, () => [])
  for (const t of objectTracks) for (let i = t.first; i <= t.last; i++) objectsBySample[i]?.push(t)
  for (let i = 0; i < n; i++) {
    if (peopleShots.has(shots[i] ?? 0)) continue
    let bestX: number | undefined
    let bestW = -1
    for (const t of objectsBySample[i] ?? []) {
      const ox = at(t, i, P.maxGap, (o) => cx(o.box))
      if (ox !== undefined && t.obs.size >= 2 && t.weight > bestW) {
        bestW = t.weight
        bestX = ox
      }
    }
    if (bestX !== undefined) {
      x[i] = bestX / W
      mode[i] = 'object'
      continue
    }
    const sal = samples[i]?.saliency
    if (sal && sal.score > 0.3) {
      x[i] = cx(sal) / W
      mode[i] = 'saliency'
    }
  }
  for (let i = 0; i < n; i++) modes[mode[i] ?? 'centre']++

  fillGaps(x, shots, 0.5)
  const zoned = deadZone(median3(x, shots), shots, P.zone * crop, P.driftAfter)
  const sx = smoothSpring(zoned, times, shots, P.omega)
  // Zoom: median over 5 samples removes flicker between group/subject framing, then the
  // same spring as the pan.
  const wm = median3(median3(w, shots), shots)
  const sw = smoothSpring(wm, times, shots, P.omega)

  const round = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 10_000) / 10_000
  const point = (t: number, k: number): PlannedPoint => {
    const width = sw[k] ?? crop
    const p: PlannedPoint = { t, x: round(sx[k] ?? 0.5) }
    if (width > crop + 0.005) p.w = round(width)
    return p
  }
  const path: PlannedPoint[] = []
  for (let i = 0; i < n; i++) {
    const t = times[i] ?? 0
    if (i > 0 && shots[i] !== shots[i - 1]) {
      const cut = cuts.find((c) => c > (times[i - 1] ?? 0) && c <= t) ?? t
      if (cut - 1 > (times[i - 1] ?? 0)) path.push(point(cut - 1, i - 1))
      if (cut < t) path.push(point(cut, i))
    }
    path.push(point(t, i))
  }
  let hits = 0
  for (let i = 0; i < n; i++) hits += detected[i] ?? 0
  const persistent = tracks.filter((t) => t.obs.size >= MIN_TRACK_SAMPLES)
  return {
    path: compressPlanned(path),
    subjects: persistent.length,
    facesFound: persistent.filter((t) => t.hasFace).length,
    coverage: Math.round((hits / n) * 1000) / 1000,
    modes,
  }
}

/** Drop interior points of runs where both x and w are constant. */
const compressPlanned = (path: readonly PlannedPoint[]): PlannedPoint[] => {
  if (path.every((p) => p.w === undefined)) return compressPath(path)
  const out: PlannedPoint[] = []
  const same = (a: PlannedPoint, b: PlannedPoint) =>
    Math.abs(a.x - b.x) <= 5e-4 && Math.abs((a.w ?? 0) - (b.w ?? 0)) <= 5e-4
  for (let i = 0; i < path.length; i++) {
    const p = path[i]
    const prev = path[i - 1]
    const next = path[i + 1]
    if (p && !(prev && next && same(prev, p) && same(next, p))) out.push(p)
  }
  return out
}
