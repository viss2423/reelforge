/** Beat sync: cut on the beat. */
import type { Project, Track, Us } from '../schema.ts'
import {
  assertUnlocked,
  effectiveOverlap,
  getTrack,
  mainTrack,
  mainTrackLayout,
  minClipDuration,
} from './project.ts'
import { editMain } from './main.ts'
import { sliceInPlace } from './slice.ts'

/** Latest beat in [lo, hi] (beats sorted ascending), or undefined. */
function latestBeat(beats: readonly Us[], lo: number, hi: number): Us | undefined {
  let a = 0
  let b = beats.length - 1
  let found: Us | undefined
  while (a <= b) {
    const mid = (a + b) >>> 1
    const v = beats[mid]!
    if (v <= hi) {
      if (v >= lo) found = v
      a = mid + 1
    } else b = mid - 1
  }
  return found
}

/** Nearest beat to t (beats sorted ascending), or undefined when there are none. */
function nearestBeat(beats: readonly Us[], t: number): Us | undefined {
  let best: Us | undefined
  for (const b of beats) {
    if (best === undefined || Math.abs(b - t) < Math.abs(best - t)) best = b
    else if (b > t) break
  }
  return best
}

/**
 * Re-time clip boundaries to beat markers (playback µs). Only `every`-th beat is used
 * (1, 2 or 4 → every beat, half-bar, bar). Clips are only ever SHORTENED so no source
 * beyond what the user picked is needed: each cut moves back to the latest usable beat.
 *
 * Main track: each clip's end — or, with a transition into the next clip, the transition
 * midpoint — lands on a beat; the track ripples. Other tracks: each clip start snaps to the
 * nearest beat (when it is within half the clip's length and does not collide) and its end
 * moves back to the latest beat.
 */
export function syncToBeats(
  p: Project,
  beats: readonly Us[],
  opts?: { every?: 1 | 2 | 4; trackId?: string },
): void {
  const every = opts?.every ?? 1
  const grid = [...new Set(beats)]
    .filter((b) => Number.isFinite(b) && b > 0)
    .toSorted((a, b) => a - b)
    .filter((_, i) => i % every === 0)
  if (grid.length === 0) return
  const track = opts?.trackId !== undefined ? getTrack(p, opts.trackId) : mainTrack(p)
  assertUnlocked(track)
  const min = minClipDuration(p.settings.fps)
  if (track.kind === 'main') syncMain(p, track, grid, min)
  else syncFree(track, grid, min)
}

function syncMain(p: Project, track: Track, grid: readonly Us[], min: Us): void {
  editMain(p, () => {
    for (let k = 0; k < track.clips.length; k++) {
      const layout = mainTrackLayout(p)
      const e = layout[k]
      if (!e) break
      const next = layout[k + 1]
      const half = next ? next.overlap / 2 : 0
      const cut = e.end - half
      const beat = latestBeat(grid, e.start + Math.max(min, e.overlap) + half, cut)
      if (beat === undefined || cut - beat < 1) continue
      let duration = e.clip.duration - Math.round(cut - beat)
      // Shortening can shrink the next transition (clamped to half this clip); compensate
      // so the transition midpoint still lands on the beat.
      if (next?.clip.transitionIn) {
        const ov = effectiveOverlap(next.clip.transitionIn, duration, next.clip.duration)
        duration = Math.round(beat - e.start + ov / 2)
      }
      if (duration < min || duration >= e.clip.duration) continue
      sliceInPlace(e.clip, 0, duration)
    }
  })
}

function syncFree(track: Track, grid: readonly Us[], min: Us): void {
  let prevEnd = 0
  track.clips.forEach((c, i) => {
    const limit = track.clips[i + 1]?.start ?? Infinity
    let start = c.start
    let duration = c.duration
    const snapped = nearestBeat(grid, c.start)
    // Only snap to a beat inside half the clip's length: a far beat would drag the clip away.
    if (
      snapped !== undefined &&
      Math.abs(snapped - c.start) <= c.duration / 2 &&
      snapped >= prevEnd &&
      snapped + min <= limit
    ) {
      start = snapped
      duration = Math.min(duration, limit - snapped)
    }
    const beat = latestBeat(grid, start + min, start + duration)
    if (beat !== undefined) duration = beat - start
    // Slicing keeps reversed/ramped source mappings exact when the tail is shortened.
    if (duration < c.duration) sliceInPlace(c, 0, duration)
    c.start = start
    // A ramp re-solve may move the end by a few µs; never collide with the next clip.
    c.duration = Math.min(c.duration, limit - start)
    prevEnd = start + c.duration
  })
}
