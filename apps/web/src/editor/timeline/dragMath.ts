/**
 * Pure drag math: main-track reorder index and preview layout, trim limits (minimum
 * duration, neighbours, available source), group moves, pinch/wheel zoom and edge
 * auto-scroll speed. All times in µs, distances in px.
 */
import type { Asset, Clip } from '@reelforge/core'
import { mainSpans, timeToX, type Spans } from './geometry.ts'

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/* ------------------------------------------------------------------ main-track reorder */

/**
 * Insertion index (into the list WITHOUT the dragged clip) for a main-track drag with the
 * pointer at time `t`: the number of other clips whose ORIGINAL midpoint lies before `t`.
 * Measuring against the original layout (not the preview, where clips ripple around the
 * gap) means the index never feeds back into itself (no oscillation), a small wiggle over
 * the clip's own slot never reorders, and the pointer sits in the preview gap. `dragIndex`
 * −1 means the clip comes from another track.
 */
export const reorderIndex = (
  durations: ArrayLike<number>,
  dragIndex: number,
  t: number,
): number => {
  let cursor = 0
  let index = 0
  for (let i = 0; i < durations.length; i++) {
    const d = durations[i]!
    const mid = cursor + d / 2
    cursor += d
    if (i === dragIndex) continue
    if (t <= mid) break
    index++
  }
  return index
}

/** Collapsed-layout time of insertion boundary `index` (where the indicator is drawn). */
export const reorderBoundary = (
  durations: ArrayLike<number>,
  dragIndex: number,
  index: number,
): number => {
  let cursor = 0
  let k = 0
  for (let i = 0; i < durations.length && k < index; i++) {
    if (i === dragIndex) continue
    cursor += durations[i]!
    k++
  }
  return cursor
}

/**
 * Preview layout of the main track with clip `dragIndex` moved to `index`: playback start of
 * every clip, indexed by ORIGINAL position (transitions re-clamped as core would).
 */
export const reorderLayout = (
  clips: readonly Clip[],
  dragIndex: number,
  index: number,
): Float64Array => {
  const order: number[] = []
  for (let i = 0; i < clips.length; i++) if (i !== dragIndex) order.push(i)
  order.splice(clamp(index, 0, order.length), 0, dragIndex)
  const spans: Spans = mainSpans(order.map((i) => clips[i]!))
  const out = new Float64Array(clips.length)
  for (let k = 0; k < order.length; k++) out[order[k]!] = spans.starts[k]!
  return out
}

/* ------------------------------------------------------------------ trim */

/** How far (timeline µs) the source allows a clip to grow at its head and tail. */
export interface Headroom {
  before: number
  after: number
}

const UNBOUNDED: Headroom = { before: Infinity, after: Infinity }

/**
 * Source headroom of a clip. Video/audio are bounded by the asset (in-point ≥ 0, source end
 * ≤ asset duration, mirrored for reversed clips); images, text and stickers are unbounded.
 * With a speed ramp the tail limit is left to core (it solves the ramp exactly).
 */
export const sourceHeadroom = (
  clip: Clip,
  asset: Pick<Asset, 'duration'> | undefined,
): Headroom => {
  if (clip.type !== 'video' && clip.type !== 'audio') return UNBOUNDED
  const ramp = clip.type === 'video' ? clip.speedRamp : []
  const headRate = clip.speed * (ramp[0]?.value ?? 1)
  const tailRate = clip.speed * (ramp.at(-1)?.value ?? 1)
  const span = ramp.length ? undefined : clip.duration * clip.speed
  const total = asset?.duration
  const reversed = clip.type === 'video' && clip.reverse
  const beforeSrc = reversed
    ? total !== undefined && span !== undefined
      ? total - (clip.in + span)
      : Infinity
    : clip.in
  const afterSrc = reversed
    ? clip.in
    : total !== undefined && span !== undefined
      ? total - (clip.in + span)
      : Infinity
  return {
    before: Math.max(0, Math.floor(beforeSrc / headRate)),
    after: Math.max(0, Math.floor(afterSrc / tailRate)),
  }
}

export interface TrimLimits {
  edge: 'start' | 'end'
  /** Current playback span. */
  start: number
  end: number
  minDuration: number
  /** Previous clip end / next clip start on free tracks (±Infinity on the main track). */
  lo: number
  hi: number
  headroom: Headroom
}

/** Allowed range for the moving edge. */
export const trimRange = (l: TrimLimits): { min: number; max: number } => {
  if (l.edge === 'start') {
    const max = l.end - l.minDuration
    const min = Math.min(max, Math.max(l.lo, l.start - l.headroom.before))
    return { min, max: Math.max(min, max) }
  }
  const min = l.start + l.minDuration
  const max = Math.max(min, Math.min(l.hi, l.end + l.headroom.after))
  return { min, max }
}

/** Clamps a proposed edge time to the trim limits. */
export const clampTrim = (proposed: number, l: TrimLimits): number => {
  const r = trimRange(l)
  return clamp(proposed, r.min, r.max)
}

/** Neighbour limits for a clip on a free (non-main) track: [prev end, next start]. */
export const freeNeighbours = (spans: Spans, index: number): { lo: number; hi: number } => ({
  lo: index > 0 ? spans.ends[index - 1]! : 0,
  hi: index < spans.starts.length - 1 ? spans.starts[index + 1]! : Infinity,
})

/* ------------------------------------------------------------------ move */

/** Clamps a group move so no clip starts before 0. */
export const clampGroupDelta = (starts: readonly number[], delta: number): number => {
  let min = Infinity
  for (const s of starts) min = Math.min(min, s)
  return min === Infinity ? delta : Math.max(delta, -min)
}

/* ------------------------------------------------------------------ zoom */

/** Zoom for a pinch whose finger distance went from `startDist` to `dist`. */
export const pinchZoom = (
  startZoom: number,
  startDist: number,
  dist: number,
  min: number,
  max: number,
): number => clamp(startDist > 0 ? (startZoom * dist) / startDist : startZoom, min, max)

/**
 * Scroll that keeps time `anchorT` (captured at gesture start) under viewport x `centerX`:
 * the content zooms around the fingers and follows them when they pan.
 */
export const anchoredScroll = (anchorT: number, ppu: number, centerX: number): number =>
  timeToX(anchorT, ppu) - centerX

/** Normalises wheel deltas to px (line and page modes). */
export const wheelPixels = (delta: number, deltaMode: number, pageSize: number): number =>
  deltaMode === 1 ? delta * 16 : deltaMode === 2 ? delta * pageSize : delta

/**
 * Zoom factor for a ctrl/cmd-wheel or trackpad-pinch event. Trackpads send many small
 * deltas, mouse wheels a few big ones: the per-event delta is capped so one wheel notch is
 * a comfortable step (~0.76× / 1.32×) while pinches stay continuous.
 */
export const wheelZoomFactor = (deltaPx: number): number => 2 ** (-clamp(deltaPx, -60, 60) / 150)

/* ------------------------------------------------------------------ auto-scroll */

/**
 * Edge auto-scroll speed (px per 60 Hz frame) for a pointer at viewport x: negative near
 * the left edge, positive near the right, quadratic ramp, 0 in between.
 */
export const autoScrollSpeed = (x: number, width: number, edge: number, max: number): number => {
  if (width <= edge * 2) return 0
  if (x < edge) return -max * ((edge - Math.max(x, 0)) / edge) ** 2
  if (x > width - edge) return max * ((Math.min(x, width) - (width - edge)) / edge) ** 2
  return 0
}
