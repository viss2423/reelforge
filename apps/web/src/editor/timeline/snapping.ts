/**
 * Snapping: a sorted, de-duplicated index of snap targets (playhead, clip edges, markers,
 * beats, scenes, time 0) built once per gesture, queried with binary search on every
 * pointer move (O(log n)). Final times are always rounded to the frame grid.
 */
import { snapToFrame, type Project } from '@reelforge/core'
import { lowerBound, trackSpans } from './geometry.ts'

export type SnapKind = 'playhead' | 'marker' | 'beat' | 'scene' | 'clip' | 'zero'

export interface SnapTarget {
  t: number
  kind: SnapKind
}

/** Lower = wins ties (several targets at the same time, or equally close). */
const PRIORITY: Readonly<Record<SnapKind, number>> = {
  playhead: 0,
  marker: 1,
  scene: 2,
  beat: 3,
  clip: 4,
  zero: 5,
}

export interface SnapHit {
  target: SnapTarget
  /** Index of the candidate edge that snapped (for multi-edge queries). */
  edge: number
  /** Amount to add to the candidate(s) to land on the target. */
  delta: number
}

export class SnapIndex {
  readonly times: Float64Array
  readonly kinds: readonly SnapKind[]

  constructor(targets: readonly SnapTarget[]) {
    const sorted = targets
      .filter((x) => Number.isFinite(x.t))
      .toSorted((a, b) => a.t - b.t || PRIORITY[a.kind] - PRIORITY[b.kind])
    const times: number[] = []
    const kinds: SnapKind[] = []
    for (const x of sorted) {
      // Same time: the first (highest priority) entry wins.
      if (times.length && times[times.length - 1] === x.t) continue
      times.push(x.t)
      kinds.push(x.kind)
    }
    this.times = Float64Array.from(times)
    this.kinds = kinds
  }

  get size(): number {
    return this.times.length
  }

  /** Closest target within `threshold` of `t`, or null. */
  nearest(t: number, threshold: number): SnapTarget | null {
    const n = this.times.length
    if (n === 0 || !(threshold > 0)) return null
    // Times are unique and sorted: the closest target is one of the two neighbours of the
    // insertion point. Equal distances resolve by priority.
    const i = lowerBound(this.times, t)
    let best = -1
    let bestDist = Infinity
    for (let j = Math.max(0, i - 1); j <= i && j < n; j++) {
      const d = Math.abs(t - this.times[j]!)
      if (d > threshold) continue
      if (
        d < bestDist ||
        (d === bestDist && PRIORITY[this.kinds[j]!] < PRIORITY[this.kinds[best]!])
      ) {
        best = j
        bestDist = d
      }
    }
    return best === -1 ? null : { t: this.times[best]!, kind: this.kinds[best]! }
  }

  /**
   * Snaps a group of edges that move together (a clip's start and end): the edge closest to
   * any target wins and the returned delta applies to all of them.
   */
  snapEdges(edges: readonly number[], threshold: number): SnapHit | null {
    let hit: SnapHit | null = null
    for (let e = 0; e < edges.length; e++) {
      const target = this.nearest(edges[e]!, threshold)
      if (!target) continue
      const delta = target.t - edges[e]!
      if (
        !hit ||
        Math.abs(delta) < Math.abs(hit.delta) ||
        (Math.abs(delta) === Math.abs(hit.delta) &&
          PRIORITY[target.kind] < PRIORITY[hit.target.kind])
      )
        hit = { target, edge: e, delta }
    }
    return hit
  }
}

export interface SnapTargetOptions {
  playhead: number
  /** Clips being dragged: their own edges are not targets. */
  exclude?: ReadonlySet<string>
  /** Include clip edges (default true). */
  clips?: boolean
}

/** Gathers snap targets from the project (playback-time clip edges, markers, playhead, 0). */
export const collectSnapTargets = (project: Project, opts: SnapTargetOptions): SnapTarget[] => {
  const out: SnapTarget[] = [
    { t: 0, kind: 'zero' },
    { t: opts.playhead, kind: 'playhead' },
  ]
  if (opts.clips !== false) {
    for (const track of project.tracks) {
      const s = trackSpans(track)
      for (let i = 0; i < track.clips.length; i++) {
        if (opts.exclude?.has(track.clips[i]!.id)) continue
        out.push({ t: s.starts[i]!, kind: 'clip' }, { t: s.ends[i]!, kind: 'clip' })
      }
    }
  }
  for (const m of project.markers) out.push({ t: m.t, kind: m.kind === 'user' ? 'marker' : m.kind })
  return out
}

/** Snaps `t` to a target within `threshold`, then to the frame grid. */
export const snapTime = (
  t: number,
  index: SnapIndex | null,
  threshold: number,
  fps: number,
): { t: number; target: SnapTarget | null } => {
  const target = index?.nearest(t, threshold) ?? null
  return { t: snapToFrame(target ? target.t : t, fps), target }
}
