/**
 * Pure geometry for on-canvas editing: which visual clips are on screen at a time (in draw
 * order), each clip's on-canvas pose (the same layer maths the compositor uses, text boxes
 * from core's layout estimate), hit testing, gesture maths (move / scale / rotate / pinch),
 * snapping to the canvas centre, edges and Reels safe zones, and crop handles.
 *
 * Coordinates are canvas px (1080×1920, y down) unless named otherwise; angles in degrees,
 * clockwise.
 */
import {
  evaluate,
  fontSpec,
  mainTrackLayout,
  measureText,
  wrapText,
  type Asset,
  type Crop,
  type MediaClip,
  type Project,
  type StickerClip,
  type TextClip,
  type Track,
} from '@reelforge/core'
import {
  CANVAS_H,
  CANVAS_W,
  computeLayer,
  createLayerState,
  quadToCanvas,
  type SourceInfo,
} from '@/preview/index.ts'

export { CANVAS_H, CANVAS_W }

export type VisualClip = MediaClip | StickerClip | TextClip

export const isVisualClip = (c: { type: string }): c is VisualClip =>
  c.type === 'video' || c.type === 'image' || c.type === 'sticker' || c.type === 'text'

/** A visual clip on screen at some time. */
export interface Placed {
  clip: VisualClip
  track: Track
  /** Playback start (main track: overlap-adjusted). */
  start: number
  /** Clip-local time. */
  local: number
}

/** On-canvas pose of a clip: an oriented box. */
export interface Pose {
  cx: number
  cy: number
  /** Drawn size (canvas px). */
  w: number
  h: number
  /** Degrees, clockwise. */
  rotation: number
  flipH: boolean
  flipV: boolean
}

/* ------------------------------------------------------------------ visibility */

/**
 * Visual clips visible at playback time `t`, bottom → top as drawn: media and stickers in
 * track order (later tracks on top), then text (libass draws above the video layers).
 * Hidden tracks are skipped.
 */
export function visibleAt(project: Project, t: number): Placed[] {
  const media: Placed[] = []
  const text: Placed[] = []
  for (const track of project.tracks) {
    if (track.hidden) continue
    if (track.kind === 'main') {
      for (const e of mainTrackLayout({ tracks: [track] })) {
        if (e.start <= t && t < e.end)
          media.push({ clip: e.clip, track, start: e.start, local: t - e.start })
      }
      continue
    }
    for (const c of track.clips) {
      if (!isVisualClip(c) || c.start > t || t >= c.start + c.duration) continue
      ;(c.type === 'text' ? text : media).push({
        clip: c,
        track,
        start: c.start,
        local: t - c.start,
      })
    }
  }
  return [...media, ...text]
}

/* ------------------------------------------------------------------ poses */

/** Clockwise display rotation (0/90/180/270) from probe metadata (which may be negative). */
const rightAngle = (deg: number | undefined): 0 | 90 | 180 | 270 => {
  const r = (((Math.round((deg ?? 0) / 90) * 90) % 360) + 360) % 360
  return r as 0 | 90 | 180 | 270
}

/** Displayed source size of a media/sticker clip (rotation folded in). */
export function sourceInfo(
  clip: MediaClip | StickerClip,
  assets: Readonly<Record<string, Asset>>,
  stickerSize?: (ref: string) => { width: number; height: number } | undefined,
): SourceInfo {
  const asset = clip.assetId ? assets[clip.assetId] : undefined
  if (asset?.width && asset.height) {
    const r = rightAngle(asset.rotation)
    const swap = r === 90 || r === 270
    return {
      width: swap ? asset.height : asset.width,
      height: swap ? asset.width : asset.height,
      rotation: 0,
    }
  }
  if (clip.type === 'sticker') {
    const s = clip.ref ? stickerSize?.(clip.ref) : undefined
    return { width: s?.width ?? 512, height: s?.height ?? 512, rotation: 0 }
  }
  // Unprobed media: assume a vertical frame (the canvas).
  return { width: CANVAS_W, height: CANVAS_H, rotation: 0 }
}

const scratch = createLayerState()

/** Text block size at scale 1 (canvas px), including outline and background padding. */
export function textBlockSize(clip: TextClip): { width: number; height: number } {
  const style = clip.style
  const text = style.uppercase ? clip.text.toUpperCase() : clip.text
  const font = fontSpec(style)
  const lines = wrapText(text, font, style.maxWidth)
  const width = Math.min(style.maxWidth, Math.max(0, ...lines.map((l) => measureText(l, font))))
  const height = Math.max(1, lines.length) * style.fontSize * style.lineHeight
  const pad = style.strokeWidth + (style.backgroundColor ? style.backgroundPadding : 0)
  return { width: Math.max(width, style.fontSize * 0.5) + pad * 2, height: height + pad * 2 }
}

/** Pose of a placed clip (its transform, fit, crop, animations and effects at `local`). */
export function poseOf(
  placed: Pick<Placed, 'clip' | 'local'>,
  assets: Readonly<Record<string, Asset>>,
  stickerSize?: (ref: string) => { width: number; height: number } | undefined,
): Pose {
  const { clip, local } = placed
  const tr = clip.transform
  if (clip.type === 'text') {
    const size = textBlockSize(clip)
    const s = Math.max(0, evaluate(tr.scale, local))
    return {
      cx: evaluate(tr.x, local),
      cy: evaluate(tr.y, local),
      w: size.width * s,
      h: size.height * s,
      rotation: evaluate(tr.rotation, local),
      flipH: tr.flipH,
      flipV: tr.flipV,
    }
  }
  const layer = computeLayer(clip, local, sourceInfo(clip, assets, stickerSize), {}, scratch)
  const [cx, cy] = quadToCanvas(layer.m, 0, 0)
  const [ax, ay] = quadToCanvas(layer.m, -0.5, 0)
  const [bx, by] = quadToCanvas(layer.m, 0.5, 0)
  // The quad's x axis points left when flipped horizontally: undo that for the angle.
  const sx = tr.flipH ? -1 : 1
  const rotation = (Math.atan2((by - ay) * sx, (bx - ax) * sx) * 180) / Math.PI
  return {
    cx,
    cy,
    w: Math.abs(layer.width),
    h: Math.abs(layer.height),
    rotation,
    flipH: tr.flipH,
    flipV: tr.flipV,
  }
}

/** Corners of a pose (tl, tr, br, bl in the box's own orientation). */
export function corners(p: Pose): Array<[number, number]> {
  const th = (p.rotation * Math.PI) / 180
  const c = Math.cos(th)
  const s = Math.sin(th)
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([u, v]) => {
    const x = (u! * p.w) / 2
    const y = (v! * p.h) / 2
    return [p.cx + x * c - y * s, p.cy + x * s + y * c] as [number, number]
  })
}

/** Axis-aligned bounds of a pose. */
export function bounds(p: Pose): { x0: number; y0: number; x1: number; y1: number } {
  const cs = corners(p)
  const xs = cs.map((q) => q[0])
  const ys = cs.map((q) => q[1])
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

/** Point in the pose's local, unrotated frame (origin at its centre). */
export function toLocal(p: Pose, x: number, y: number): [number, number] {
  const th = (-p.rotation * Math.PI) / 180
  const dx = x - p.cx
  const dy = y - p.cy
  return [dx * Math.cos(th) - dy * Math.sin(th), dx * Math.sin(th) + dy * Math.cos(th)]
}

/** Whether (x, y) lies inside the pose, grown by `slop` px on every side. */
export function contains(p: Pose, x: number, y: number, slop = 0): boolean {
  const [lx, ly] = toLocal(p, x, y)
  return Math.abs(lx) <= p.w / 2 + slop && Math.abs(ly) <= p.h / 2 + slop
}

/**
 * Top-most entry under the point. Exact hits win over slop hits so a small sticker on top
 * of a full-screen video stays reachable; among equals the later (higher) one wins.
 */
export function topmostAt<T extends { pose: Pose }>(
  items: readonly T[],
  x: number,
  y: number,
  slop = 0,
): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (contains(items[i]!.pose, x, y)) return items[i]
  if (slop > 0)
    for (let i = items.length - 1; i >= 0; i--)
      if (contains(items[i]!.pose, x, y, slop)) return items[i]
  return undefined
}

/* ------------------------------------------------------------------ gesture maths */

const DEG = 180 / Math.PI

/** Normalises an angle to (−180, 180]. */
export const normAngle = (deg: number): number => {
  const a = ((((deg + 180) % 360) + 360) % 360) - 180
  return a === -180 ? 180 : a
}

/** Angle (deg) of the vector from a to b. */
export const angleOf = (ax: number, ay: number, bx: number, by: number): number =>
  Math.atan2(by - ay, bx - ax) * DEG

/** Two-finger transform: translation of the midpoint, scale and rotation of the pair. */
export function pinchDelta(
  a0: readonly [number, number],
  b0: readonly [number, number],
  a1: readonly [number, number],
  b1: readonly [number, number],
): { dx: number; dy: number; scale: number; rotation: number } {
  const d0 = Math.hypot(b0[0] - a0[0], b0[1] - a0[1])
  const d1 = Math.hypot(b1[0] - a1[0], b1[1] - a1[1])
  return {
    dx: (a1[0] + b1[0]) / 2 - (a0[0] + b0[0]) / 2,
    dy: (a1[1] + b1[1]) / 2 - (a0[1] + b0[1]) / 2,
    scale: d0 > 0 ? d1 / d0 : 1,
    rotation: normAngle(angleOf(...a1, ...b1) - angleOf(...a0, ...b0)),
  }
}

/** Scale factor for a corner-handle drag about the box centre. */
export const cornerScale = (
  cx: number,
  cy: number,
  x0: number,
  y0: number,
  x: number,
  y: number,
) => {
  const d0 = Math.hypot(x0 - cx, y0 - cy)
  return d0 > 0 ? Math.hypot(x - cx, y - cy) / d0 : 1
}

/** Scale limits of on-canvas gestures (the inspector's slider allows 1–500 %). */
export const MIN_SCALE = 0.05
export const MAX_SCALE = 20

/** Snaps a scale to 100 % when within `tol` (relative). */
export const snapScale = (s: number, tol = 0.03): { value: number; snapped: boolean } =>
  Math.abs(s - 1) <= tol ? { value: 1, snapped: true } : { value: s, snapped: false }

/**
 * Snaps an angle: to the nearest multiple of `step` when `step` is given (Shift), otherwise
 * to 0/90/180/270 within `tol` degrees.
 */
export function snapAngle(
  deg: number,
  opts: { step?: number; tol?: number } = {},
): { value: number; snapped: boolean } {
  const a = normAngle(deg)
  if (opts.step) return { value: normAngle(Math.round(a / opts.step) * opts.step), snapped: true }
  const q = Math.round(a / 90) * 90
  return Math.abs(a - q) <= (opts.tol ?? 4)
    ? { value: normAngle(q), snapped: true }
    : { value: a, snapped: false }
}

/* ------------------------------------------------------------------ snapping & safe zones */

/**
 * Reels UI safe zones on the 1080×1920 canvas — the union of Instagram Reels, TikTok and
 * YouTube Shorts overlays (approximate, rounded): the top bar, the right action rail and
 * the bottom caption / account area.
 */
export const SAFE_ZONES = {
  top: 220,
  bottom: 1500,
  railLeft: 920,
  railTop: 880,
  left: 60,
} as const

export interface Zone {
  id: 'top' | 'rail' | 'bottom'
  label: string
  x: number
  y: number
  w: number
  h: number
}

export const SAFE_ZONE_RECTS: readonly Zone[] = [
  { id: 'top', label: 'Top bar', x: 0, y: 0, w: CANVAS_W, h: SAFE_ZONES.top },
  {
    id: 'rail',
    label: 'Buttons',
    x: SAFE_ZONES.railLeft,
    y: SAFE_ZONES.railTop,
    w: CANVAS_W - SAFE_ZONES.railLeft,
    h: SAFE_ZONES.bottom - SAFE_ZONES.railTop,
  },
  {
    id: 'bottom',
    label: 'Caption & account',
    x: 0,
    y: SAFE_ZONES.bottom,
    w: CANVAS_W,
    h: CANVAS_H - SAFE_ZONES.bottom,
  },
]

export type GuideKind = 'center' | 'edge' | 'safe'

export interface Guide {
  axis: 'x' | 'y'
  at: number
  kind: GuideKind
}

const X_LINES: readonly Guide[] = [
  { axis: 'x', at: CANVAS_W / 2, kind: 'center' },
  { axis: 'x', at: 0, kind: 'edge' },
  { axis: 'x', at: CANVAS_W, kind: 'edge' },
  { axis: 'x', at: SAFE_ZONES.left, kind: 'safe' },
  { axis: 'x', at: SAFE_ZONES.railLeft, kind: 'safe' },
]
const Y_LINES: readonly Guide[] = [
  { axis: 'y', at: CANVAS_H / 2, kind: 'center' },
  { axis: 'y', at: 0, kind: 'edge' },
  { axis: 'y', at: CANVAS_H, kind: 'edge' },
  { axis: 'y', at: SAFE_ZONES.top, kind: 'safe' },
  { axis: 'y', at: SAFE_ZONES.bottom, kind: 'safe' },
]

/**
 * Snaps a moved pose: its bounding box's left/centre/right edge to the vertical guide lines
 * and top/centre/bottom to the horizontal ones, each axis independently, when within
 * `threshold` canvas px. Centre lines win ties. Returns the corrected offset and the guides
 * hit.
 */
export function snapMove(
  pose: Pose,
  dx: number,
  dy: number,
  threshold: number,
): { dx: number; dy: number; guides: Guide[] } {
  const b = bounds({ ...pose, cx: pose.cx + dx, cy: pose.cy + dy })
  const axis = (features: number[], lines: readonly Guide[]) => {
    let best: { d: number; g: Guide } | null = null
    for (const g of lines)
      for (const f of features) {
        const d = g.at - f
        if (Math.abs(d) > threshold) continue
        if (
          !best ||
          Math.abs(d) < Math.abs(best.d) - 1e-9 ||
          (Math.abs(Math.abs(d) - Math.abs(best.d)) <= 1e-9 && g.kind === 'center')
        )
          best = { d, g }
      }
    return best
  }
  const sx = axis([b.x0, (b.x0 + b.x1) / 2, b.x1], X_LINES)
  const sy = axis([b.y0, (b.y0 + b.y1) / 2, b.y1], Y_LINES)
  const guides: Guide[] = []
  if (sx) guides.push(sx.g)
  if (sy) guides.push(sy.g)
  return { dx: dx + (sx?.d ?? 0), dy: dy + (sy?.d ?? 0), guides }
}

/* ------------------------------------------------------------------ crop */

export type CropSide = 'left' | 'top' | 'right' | 'bottom'
/** A crop handle: one side, or a corner (two sides). */
export type CropHandle = readonly CropSide[]

/** Smallest visible fraction of the source per axis (matches the inspector's limit). */
export const MIN_VISIBLE = 0.05

/** The whole (uncropped) source frame, posed where the current crop shows its window. */
export function fullFrame(pose: Pose, crop: Crop): Pose {
  const fw = pose.w / Math.max(1e-6, 1 - crop.left - crop.right)
  const fh = pose.h / Math.max(1e-6, 1 - crop.top - crop.bottom)
  // Offset of the full frame's centre from the window centre, in the box's local frame.
  const ox = (0.5 - (crop.left + 1 - crop.right) / 2) * fw * (pose.flipH ? -1 : 1)
  const oy = (0.5 - (crop.top + 1 - crop.bottom) / 2) * fh * (pose.flipV ? -1 : 1)
  const th = (pose.rotation * Math.PI) / 180
  return {
    ...pose,
    cx: pose.cx + ox * Math.cos(th) - oy * Math.sin(th),
    cy: pose.cy + ox * Math.sin(th) + oy * Math.cos(th),
    w: fw,
    h: fh,
  }
}

/** Source-normalised (u, v) of a canvas point within a full frame (flips undone). */
export function frameUV(full: Pose, x: number, y: number): [number, number] {
  const [lx, ly] = toLocal(full, x, y)
  return [0.5 + (lx / full.w) * (full.flipH ? -1 : 1), 0.5 + (ly / full.h) * (full.flipV ? -1 : 1)]
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** New crop after dragging `handle` to canvas point (x, y) over the full frame. */
export function dragCrop(full: Pose, start: Crop, handle: CropHandle, x: number, y: number): Crop {
  const [u, v] = frameUV(full, x, y)
  const c = { ...start }
  for (const side of handle) {
    if (side === 'left') c.left = clamp(u, 0, 1 - c.right - MIN_VISIBLE)
    if (side === 'right') c.right = clamp(1 - u, 0, 1 - c.left - MIN_VISIBLE)
    if (side === 'top') c.top = clamp(v, 0, 1 - c.bottom - MIN_VISIBLE)
    if (side === 'bottom') c.bottom = clamp(1 - v, 0, 1 - c.top - MIN_VISIBLE)
  }
  return c
}

/** Crop window rectangle in the full frame's DISPLAYED box, as fractions (flips applied). */
export function cropRect(crop: Crop, flipH: boolean, flipV: boolean) {
  return {
    left: flipH ? crop.right : crop.left,
    right: flipH ? crop.left : crop.right,
    top: flipV ? crop.bottom : crop.top,
    bottom: flipV ? crop.top : crop.bottom,
  }
}

/** Which model sides a handle drawn at a displayed side controls (flips swap them). */
export const displayedSide = (side: CropSide, flipH: boolean, flipV: boolean): CropSide => {
  if (flipH && (side === 'left' || side === 'right')) return side === 'left' ? 'right' : 'left'
  if (flipV && (side === 'top' || side === 'bottom')) return side === 'top' ? 'bottom' : 'top'
  return side
}
