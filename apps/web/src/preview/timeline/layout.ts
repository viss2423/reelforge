/**
 * Main-track layout with transition overlap, in the typed-array form the per-frame lookups
 * use. The overlap maths is core's `mainTrackLayout` (shared with the ops and the export
 * compiler): a transition into clip i overlaps it with the tail of clip i-1, so the rendered
 * total is `Σ durations − Σ effective transitions` — exactly what FFmpeg's `xfade` chain
 * produces.
 */
import {
  mainTrackLayout as coreMainTrackLayout,
  type MediaClip,
  type Track,
  type TransitionType,
} from '@reelforge/core'

export interface MainLayout {
  readonly clips: readonly MediaClip[]
  /** Rendered start of clip i (timeline us). */
  readonly starts: Float64Array
  /** Rendered end of clip i (timeline us, exclusive). */
  readonly ends: Float64Array
  /** Effective (clamped) transition duration INTO clip i; 0 for the first clip. */
  readonly transIn: Float64Array
  /** Transition type into clip i, or null. */
  readonly transType: ReadonlyArray<TransitionType | null>
  /** Rendered duration of the whole main track. */
  readonly total: number
}

/** Compute the rendered layout of the main track. */
export function mainTrackLayout(track: Track | undefined): MainLayout {
  const entries = track ? coreMainTrackLayout({ tracks: [track] }) : []
  const n = entries.length
  const starts = new Float64Array(n)
  const ends = new Float64Array(n)
  const transIn = new Float64Array(n)
  const transType: Array<TransitionType | null> = Array.from({ length: n }, () => null)
  const clips: MediaClip[] = []
  for (let i = 0; i < n; i++) {
    const e = entries[i]!
    clips.push(e.clip)
    starts[i] = e.start
    ends[i] = e.end
    transIn[i] = e.overlap
    transType[i] = e.overlap > 0 ? (e.clip.transitionIn?.type ?? null) : null
  }
  return { clips, starts, ends, transIn, transType, total: n > 0 ? ends[n - 1]! : 0 }
}

/**
 * Index of the main clip that is "current" at t: the last clip whose rendered start <= t.
 * During a transition into clip i this returns i (the incoming clip). -1 when empty or t < 0.
 * Allocation-free binary search.
 */
export function mainClipIndexAt(layout: MainLayout, t: number): number {
  const s = layout.starts
  let lo = 0
  let hi = s.length - 1
  if (hi < 0 || t < 0) return -1
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (s[mid]! <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}
