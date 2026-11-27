/**
 * Pure timeline geometry: time ↔ content px, main-track playback layout, track row layout,
 * render windows (virtualisation) and adaptive ruler ticks. No DOM, no React — everything
 * here is unit-tested and shared by the components and the gesture controller.
 *
 * Coordinates: "content x" is measured from the left edge of the scrollable content, so
 * `viewportX = contentX - scrollX`. Time 0 sits at `CONTENT_PAD`.
 */
import {
  effectiveOverlap,
  formatTimecode,
  fromFrame,
  type Clip,
  type Project,
  type Track,
} from '@reelforge/core'
import {
  CAPTION_ROW_HEIGHT,
  CONTENT_PAD,
  MARKER_ROW_HEIGHT,
  OVERSCAN,
  ROW_GAP,
  ROWS_PAD,
  TRACK_ROW_HEIGHT,
} from './constants.ts'

export const US_PER_S = 1_000_000

/** Pixels per microsecond for a zoom given in px per second. */
export const pxPerUs = (zoom: number): number => zoom / US_PER_S

export const timeToX = (t: number, ppu: number): number => CONTENT_PAD + t * ppu
export const xToTime = (x: number, ppu: number): number => (x - CONTENT_PAD) / ppu

/* ------------------------------------------------------------------ clip spans */

/**
 * Playback spans of a track's clips, index-aligned with `track.clips`. Both arrays are
 * non-decreasing (clips never overlap within a non-main track, and main-track transition
 * overlaps are at most half a clip), which makes binary search valid for culling.
 */
export interface Spans {
  starts: Float64Array
  ends: Float64Array
  /** Transition overlap of clip i with clip i−1 (main track only, else zeros). */
  overlaps: Float64Array
}

// Keyed by kind too: a track can change kind (extra main → overlay) and keep its clips array.
const mainSpanCache = new WeakMap<readonly Clip[], Spans>()
const freeSpanCache = new WeakMap<readonly Clip[], Spans>()

/**
 * Main-track playback spans for clips in the given order (uncached), e.g. a reorder being
 * dragged. Overlaps are core's `effectiveOverlap` (the same maths as `mainTrackLayout`):
 * clip `start` on the main track is the contiguous cursor and the playback position is
 * shifted left by all overlaps so far.
 */
export const mainSpans = (clips: readonly Clip[]): Spans => {
  const n = clips.length
  const s = {
    starts: new Float64Array(n),
    ends: new Float64Array(n),
    overlaps: new Float64Array(n),
  }
  let cursor = 0
  let prev: number | undefined
  for (let i = 0; i < n; i++) {
    const c = clips[i]!
    // The first clip never has a transition, wherever it came from.
    const overlap =
      i === 0 || (c.type !== 'video' && c.type !== 'image')
        ? 0
        : effectiveOverlap(c.transitionIn, prev, c.duration)
    const start = cursor - overlap
    s.starts[i] = start
    s.ends[i] = start + c.duration
    s.overlaps[i] = overlap
    cursor = start + c.duration
    prev = c.duration
  }
  return s
}

/** Spans of a track (cached per immutable clips array). */
export const trackSpans = (track: Pick<Track, 'kind' | 'clips'>): Spans => {
  const clips = track.clips
  const cache = track.kind === 'main' ? mainSpanCache : freeSpanCache
  let s = cache.get(clips)
  if (s) return s
  const n = clips.length
  if (track.kind === 'main') s = mainSpans(clips)
  else {
    s = { starts: new Float64Array(n), ends: new Float64Array(n), overlaps: new Float64Array(n) }
    for (let i = 0; i < n; i++) {
      const c = clips[i]!
      s.starts[i] = c.start
      s.ends[i] = c.start + c.duration
    }
  }
  cache.set(clips, s)
  return s
}

/** First index whose value is > t in a non-decreasing array (n if none). */
export const upperBound = (arr: ArrayLike<number>, t: number): number => {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid]! > t) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** First index whose value is >= t in a non-decreasing array (n if none). */
export const lowerBound = (arr: ArrayLike<number>, t: number): number => {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid]! < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Index range [from, to) of clips intersecting [t0, t1). O(log n). */
export const visibleRange = (spans: Spans, t0: number, t1: number): [number, number] => {
  const from = upperBound(spans.ends, t0)
  const to = lowerBound(spans.starts, t1)
  return [from, Math.max(from, to)]
}

/** Playback end of the whole project (main track overlap-aware), plus markers. */
export const contentEnd = (project: Project | null): number => {
  if (!project) return 0
  let end = 0
  for (const t of project.tracks) {
    const s = trackSpans(t)
    // Ends are non-decreasing, so the last one is the track end.
    if (s.ends.length) end = Math.max(end, s.ends[s.ends.length - 1]!)
  }
  for (const m of project.markers) end = Math.max(end, m.t)
  return end
}

/* ------------------------------------------------------------------ rows */

export type Row =
  | { type: 'markers'; key: 'markers'; y: number; height: number }
  | { type: 'captions'; key: 'captions'; y: number; height: number }
  | { type: 'track'; key: string; track: Track; y: number; height: number }

export interface RowLayout {
  rows: Row[]
  /** Total height of all rows including padding. */
  height: number
}

/**
 * Vertical order (top → bottom): markers, captions, visual tracks top-most first (later
 * tracks draw on top, so they sit higher), the main track, then audio tracks. This mirrors
 * the stacking order of the preview so the timeline reads like the frame. The marker row is
 * left out when there are no markers (`hasMarkers: false`).
 */
export const layoutRows = (
  tracks: readonly Track[],
  hasCaptions: boolean,
  hasMarkers = true,
): RowLayout => {
  const rows: Row[] = []
  let y = ROWS_PAD
  const push = (r: Row) => {
    rows.push(r)
    y += r.height + ROW_GAP
  }
  const track = (t: Track) => ({
    type: 'track' as const,
    key: t.id,
    track: t,
    y,
    height: TRACK_ROW_HEIGHT[t.kind],
  })
  if (hasMarkers) push({ type: 'markers', key: 'markers', y, height: MARKER_ROW_HEIGHT })
  if (hasCaptions) push({ type: 'captions', key: 'captions', y, height: CAPTION_ROW_HEIGHT })
  for (let i = tracks.length - 1; i >= 0; i--) {
    const t = tracks[i]!
    if (t.kind === 'overlay' || t.kind === 'text') push(track(t))
  }
  for (const t of tracks) if (t.kind === 'main') push(track(t))
  for (const t of tracks) if (t.kind === 'audio') push(track(t))
  return { rows, height: y - ROW_GAP + ROWS_PAD }
}

/**
 * Row index at content y. With `nearest`, gaps and positions above/below all rows resolve to
 * the closest row (for drop targets); otherwise −1 when not inside a row.
 */
export const rowAt = (rows: readonly Row[], y: number, nearest = false): number => {
  let best = -1
  let bestDist = Infinity
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!
    if (y >= r.y && y < r.y + r.height) return i
    if (nearest) {
      const d = y < r.y ? r.y - y : y - (r.y + r.height)
      if (d < bestDist) {
        bestDist = d
        best = i
      }
    }
  }
  return best
}

/* ------------------------------------------------------------------ virtualisation */

/** Time range rendered by the lanes: the viewport plus overscan on both sides. */
export interface TimeWindow {
  start: number
  end: number
}

export const computeWindow = (
  scrollX: number,
  viewWidth: number,
  ppu: number,
  overscan = OVERSCAN,
): TimeWindow => {
  const x0 = scrollX - viewWidth * overscan
  const x1 = scrollX + viewWidth * (1 + overscan)
  return { start: Math.max(0, xToTime(x0, ppu)), end: Math.max(0, xToTime(x1, ppu)) }
}

/**
 * True while the visible viewport plus half the overscan still lies inside `win`, i.e. the
 * lanes do not need to re-render for this scroll position.
 */
export const windowCovers = (
  win: TimeWindow,
  scrollX: number,
  viewWidth: number,
  ppu: number,
  overscan = OVERSCAN,
): boolean => {
  const margin = (viewWidth * overscan) / 2
  const t0 = Math.max(0, xToTime(scrollX - margin, ppu))
  const t1 = xToTime(scrollX + viewWidth + margin, ppu)
  return t0 >= win.start && t1 <= win.end
}

/* ------------------------------------------------------------------ scroll */

/** Largest horizontal scroll offset: content end plus tail space, at least one viewport. */
export const maxScrollX = (endUs: number, ppu: number, viewWidth: number, tail: number): number =>
  Math.max(0, timeToX(endUs, ppu) + viewWidth * tail - viewWidth)

/** New scrollX that keeps the time under viewport x `anchorX` fixed across a zoom change. */
export const zoomAnchoredScroll = (
  scrollX: number,
  anchorX: number,
  oldPpu: number,
  newPpu: number,
): number => {
  const t = xToTime(scrollX + anchorX, oldPpu)
  return timeToX(t, newPpu) - anchorX
}

/* ------------------------------------------------------------------ ruler ticks */

export interface TickSpec {
  /** Minor tick spacing: µs, or frames when `inFrames`. */
  unit: number
  inFrames: boolean
  /** Every n-th minor tick is a labelled major tick. */
  majorEvery: number
  /** Major spacing in µs (drives the label format). */
  majorUs: number
}

const FRAME_STEPS = [1, 2, 5, 10] as const
const SECOND_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600] as const
const SUBDIVISIONS = [10, 5, 4, 2] as const

/**
 * Picks ruler ticks so labels are at least `minMajorPx` apart and minor ticks at least
 * `minMinorPx`. Below one second majors are whole frames so labels land on real frames.
 */
export const tickSpec = (ppu: number, fps: number, minMajorPx = 72, minMinorPx = 8): TickSpec => {
  const frameUs = US_PER_S / fps
  for (const k of FRAME_STEPS) {
    const majorUs = k * frameUs
    if (majorUs >= US_PER_S / 2) break
    if (majorUs * ppu >= minMajorPx) {
      const minorOk = k > 1 && frameUs * ppu >= minMinorPx
      return minorOk
        ? { unit: 1, inFrames: true, majorEvery: k, majorUs }
        : { unit: k, inFrames: true, majorEvery: 1, majorUs }
    }
  }
  for (const s of SECOND_STEPS) {
    const majorUs = s * US_PER_S
    if (majorUs * ppu >= minMajorPx || s === SECOND_STEPS[SECOND_STEPS.length - 1]) {
      for (const n of SUBDIVISIONS) {
        if ((majorUs / n) * ppu >= minMinorPx && Number.isInteger(majorUs / n))
          return { unit: majorUs / n, inFrames: false, majorEvery: n, majorUs }
      }
      return { unit: majorUs, inFrames: false, majorEvery: 1, majorUs }
    }
  }
  return { unit: 3600 * US_PER_S, inFrames: false, majorEvery: 1, majorUs: 3600 * US_PER_S }
}

/** Time of minor tick `i`. */
export const tickTime = (spec: TickSpec, i: number, fps: number): number =>
  spec.inFrames ? fromFrame(i * spec.unit, fps) : i * spec.unit

/** Index of the first minor tick at or after `t`. */
export const firstTickIndex = (spec: TickSpec, t: number, fps: number): number =>
  Math.max(0, Math.ceil(spec.inFrames ? (t * fps) / US_PER_S / spec.unit : t / spec.unit))

/**
 * Ruler label for a major tick: "m:ss" on whole seconds, "Nf" for frames within a second
 * (CapCut-style), "m:ss.c" for half seconds.
 */
export const tickLabel = (t: number, spec: TickSpec, fps: number): string => {
  const whole = t % US_PER_S === 0
  if (spec.majorUs >= US_PER_S || whole) return formatTimecode(t, false)
  if (spec.inFrames) return `${Math.round(((t % US_PER_S) * fps) / US_PER_S)}f`
  return `${formatTimecode(t, false)}.${Math.floor((t % US_PER_S) / 100_000)}`
}
