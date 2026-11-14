/** Auto-reframe: keyframe a clip's horizontal position to keep a tracked subject centred. */
import type { Keyframe, MediaClip, Project, Us } from '../schema.ts'
import { evaluate } from '../animation.ts'
import { OpError, clamp } from './errors.ts'
import { assertUnlocked, getClip } from './project.ts'
import { clipTimeToSourceExact, sourceToClipTimeExact, speedProfile } from './timemap.ts'

const CANVAS_W = 1080
const CANVAS_H = 1920
/** Default source geometry when the caller does not pass it: landscape 16:9 footage. */
const DEFAULT_SOURCE = { width: 1920, height: 1080 } as const
/** Keyframes closer than this to the straight line through their neighbours are dropped. */
const SIMPLIFY_TOLERANCE_PX = 1.5

/** Source frame geometry needed to compute the displayed size. */
export interface SourceGeometry {
  width: number
  height: number
  /** Rotation metadata in degrees (90/270 swap width and height). */
  rotation?: number
}

/** Displayed width (canvas px) of the clip's cropped source at scale multiplier `scale`. */
function displayedWidth(clip: MediaClip, src: SourceGeometry, scale: number): number {
  const rotated = Math.abs(Math.round((src.rotation ?? 0) / 90)) % 2 === 1
  const w =
    (rotated ? src.height : src.width) * Math.max(1e-6, 1 - clip.crop.left - clip.crop.right)
  const h =
    (rotated ? src.width : src.height) * Math.max(1e-6, 1 - clip.crop.top - clip.crop.bottom)
  const fit =
    clip.fit === 'cover'
      ? Math.max(CANVAS_W / w, CANVAS_H / h)
      : clip.fit === 'contain'
        ? Math.min(CANVAS_W / w, CANVAS_H / h)
        : CANVAS_W / w
  return w * fit * scale
}

/** Ramer–Douglas–Peucker simplification of a keyframe polyline (values in px). */
function simplify(points: Keyframe[], tolerance: number): Keyframe[] {
  if (points.length <= 2) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: Array<[number, number]> = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [i, j] = stack.pop()!
    const a = points[i]!
    const b = points[j]!
    let worst = -1
    let worstErr = tolerance
    for (let k = i + 1; k < j; k++) {
      const pt = points[k]!
      const expected = a.value + ((b.value - a.value) * (pt.t - a.t)) / (b.t - a.t)
      const err = Math.abs(pt.value - expected)
      if (err > worstErr) {
        worstErr = err
        worst = k
      }
    }
    if (worst !== -1) {
      keep[worst] = 1
      stack.push([i, worst], [worst, j])
    }
  }
  return points.filter((_, k) => keep[k] === 1)
}

/** Linear interpolation of the subject path at source time s (path sorted by t). */
function pathAt(path: ReadonlyArray<{ t: Us; x: number }>, s: number): number {
  const first = path[0]!
  if (s <= first.t) return first.x
  for (let i = 1; i < path.length; i++) {
    const b = path[i]!
    if (s <= b.t) {
      const a = path[i - 1]!
      return b.t === a.t ? b.x : a.x + ((b.x - a.x) * (s - a.t)) / (b.t - a.t)
    }
  }
  return path[path.length - 1]!.x
}

/**
 * Keyframe `transform.x` so the subject (path items: SOURCE time µs + subject centre as a
 * 0..1 fraction of the source width) stays centred on the 1080 px canvas under the clip's
 * fit, crop, flip and scale. With fit 'cover' the position is clamped so the frame never
 * reveals empty borders. Dense detector output is simplified to a compact set of linear
 * keyframes (≤ 1.5 px deviation). Pass `source` geometry; landscape 16:9 is assumed otherwise.
 */
export function applyReframe(
  p: Project,
  clipId: string,
  path: ReadonlyArray<{ t: Us; x: number }>,
  source?: SourceGeometry,
): void {
  const { track, clip } = getClip(p, clipId)
  assertUnlocked(track)
  if (clip.type !== 'video' && clip.type !== 'image') {
    throw new OpError('not_media', 'reframe applies to video and image clips')
  }
  const pts = path
    .filter((pt) => Number.isFinite(pt.t) && Number.isFinite(pt.x))
    .toSorted((a, b) => a.t - b.t)
  if (pts.length === 0) throw new OpError('empty_path', 'reframe path is empty')
  const geometry = source ?? DEFAULT_SOURCE
  const prof = speedProfile(clip)
  const { left, right } = clip.crop
  const cropW = Math.max(1e-6, 1 - left - right)

  const xAt = (tau: number, subjectX: number): number => {
    const width = displayedWidth(clip, geometry, evaluate(clip.transform.scale, tau))
    let u = clamp((subjectX - left) / cropW, 0, 1)
    if (clip.transform.flipH) u = 1 - u
    const x = CANVAS_W / 2 - (u - 0.5) * width
    if (clip.fit !== 'cover' || width < CANVAS_W) return x
    return clamp(x, CANVAS_W - width / 2, width / 2)
  }

  const raw = new Map<Us, number>()
  const add = (tau: number) => {
    const t = Math.round(clamp(tau, 0, clip.duration))
    const s = clip.type === 'image' ? clip.in + t : clipTimeToSourceExact(clip, t, prof)
    raw.set(t, Math.round(xAt(t, pathAt(pts, s)) * 100) / 100)
  }
  add(0)
  add(clip.duration)
  for (const pt of pts) {
    const tau = clip.type === 'image' ? pt.t - clip.in : sourceToClipTimeExact(clip, pt.t, prof)
    if (tau !== undefined && tau >= 0 && tau <= clip.duration) add(tau)
  }
  const keyframes = simplify(
    [...raw.entries()]
      .toSorted((a, b) => a[0] - b[0])
      .map(([t, value]): Keyframe => ({ t, value, easing: 'linear' })),
    SIMPLIFY_TOLERANCE_PX,
  )
  const first = keyframes[0]!
  clip.transform.x =
    keyframes.length === 1 || keyframes.every((k) => k.value === first.value)
      ? { value: first.value, keyframes: [] }
      : { value: first.value, keyframes }
}
