/**
 * Timeline index: answers "what is visible at time t?" and "what media is needed soon?"
 * in O(tracks · log clips) without allocating, so it can run every animation frame.
 * Rebuilt (cheaply) whenever the project's tracks change.
 */
import type { MediaClip, Project, StickerClip, TransitionType } from '@reelforge/core'
import { mainClipIndexAt, mainTrackLayout, type MainLayout } from './layout.ts'

export type VisualClip = MediaClip | StickerClip

/** A clip instance at a given time. Mutated in place by the resolver (never reallocated). */
export interface Slot {
  clip: VisualClip | null
  /** Index of the clip's track in `project.tracks` (z-order). */
  trackIndex: number
  /** Rendered timeline start of the clip (us). */
  start: number
  /** Clip-local time: t - start (us). */
  local: number
}

export interface FramePlan {
  t: number
  /** The only main clip, or the OUTGOING clip during a transition. */
  readonly mainA: Slot
  /** The INCOMING main clip during a transition (clip null otherwise). */
  readonly mainB: Slot
  transition: TransitionType | null
  /** Forward transition progress 0..1 (0 = all A, 1 = all B). */
  progress: number
  /** Overlay layers (media + stickers) in z-order; only the first `overlayCount` are valid. */
  readonly overlays: Slot[]
  overlayCount: number
  /** Number of overlay layers drawn BELOW the main track (tracks before main in the array). */
  overlaysBelowMain: number
}

const emptySlot = (): Slot => ({ clip: null, trackIndex: -1, start: 0, local: 0 })

export function createFramePlan(): FramePlan {
  return {
    t: 0,
    mainA: emptySlot(),
    mainB: emptySlot(),
    transition: null,
    progress: 0,
    overlays: [],
    overlayCount: 0,
    overlaysBelowMain: 0,
  }
}

interface FreeTrack {
  trackIndex: number
  clips: VisualClip[]
  starts: Float64Array
  ends: Float64Array
}

const setSlot = (s: Slot, clip: VisualClip, trackIndex: number, start: number, t: number): void => {
  s.clip = clip
  s.trackIndex = trackIndex
  s.start = start
  s.local = t - start
}

function pushSlot(
  out: Slot[],
  n: number,
  clip: VisualClip,
  trackIndex: number,
  start: number,
  t: number,
): number {
  if (n === out.length) out.push(emptySlot())
  setSlot(out[n]!, clip, trackIndex, start, t)
  return n + 1
}

/** Last index with starts[i] <= t, or -1. */
function lastStartAtOrBefore(starts: Float64Array, t: number): number {
  let lo = 0
  let hi = starts.length - 1
  if (hi < 0 || starts[0]! > t) return -1
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (starts[mid]! <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

export class TimelineIndex {
  readonly layout: MainLayout
  readonly mainTrackIndex: number
  readonly mainHidden: boolean
  readonly #overlays: FreeTrack[]
  /** Rendered project duration: max(main total, end of any clip on other tracks, captions). */
  readonly duration: number

  constructor(project: Project) {
    const mainIdx = project.tracks.findIndex((t) => t.kind === 'main')
    this.mainTrackIndex = mainIdx
    const main = mainIdx >= 0 ? project.tracks[mainIdx] : undefined
    this.mainHidden = main?.hidden ?? true
    this.layout = mainTrackLayout(main)
    let duration = this.layout.total
    this.#overlays = []
    project.tracks.forEach((track, trackIndex) => {
      if (track.kind === 'main') return
      for (const c of track.clips) duration = Math.max(duration, c.start + c.duration)
      if (track.kind !== 'overlay' || track.hidden) return
      const clips = track.clips
        .filter(
          (c): c is VisualClip => c.type === 'video' || c.type === 'image' || c.type === 'sticker',
        )
        .sort((a, b) => a.start - b.start)
      const starts = new Float64Array(clips.length)
      const ends = new Float64Array(clips.length)
      clips.forEach((c, i) => {
        starts[i] = c.start
        ends[i] = c.start + c.duration
      })
      this.#overlays.push({ trackIndex, clips, starts, ends })
    })
    const words = project.captions?.enabled ? project.captions.words : undefined
    if (words && words.length > 0) duration = Math.max(duration, words[words.length - 1]!.end)
    this.duration = duration
  }

  /** Fill `plan` with everything visible at time t. Allocation-free after warm-up. */
  resolve(t: number, plan: FramePlan): FramePlan {
    plan.t = t
    plan.mainA.clip = null
    plan.mainB.clip = null
    plan.transition = null
    plan.progress = 0
    const L = this.layout
    if (!this.mainHidden) {
      const i = mainClipIndexAt(L, t)
      if (i >= 0 && t < L.ends[i]!) {
        const tr = L.transIn[i]!
        if (tr > 0 && t < L.starts[i]! + tr) {
          setSlot(plan.mainA, L.clips[i - 1]!, this.mainTrackIndex, L.starts[i - 1]!, t)
          setSlot(plan.mainB, L.clips[i]!, this.mainTrackIndex, L.starts[i]!, t)
          plan.transition = L.transType[i]!
          plan.progress = (t - L.starts[i]!) / tr
        } else {
          setSlot(plan.mainA, L.clips[i]!, this.mainTrackIndex, L.starts[i]!, t)
        }
      }
    }
    let n = 0
    let below = 0
    const ov = plan.overlays
    for (const track of this.#overlays) {
      const k = lastStartAtOrBefore(track.starts, t)
      if (k < 0 || t >= track.ends[k]!) continue
      if (n === ov.length) ov.push(emptySlot())
      setSlot(ov[n]!, track.clips[k]!, track.trackIndex, track.starts[k]!, t)
      if (track.trackIndex < this.mainTrackIndex) below++
      n++
    }
    plan.overlayCount = n
    plan.overlaysBelowMain = below
    return plan
  }

  /**
   * Collect every media clip (video/image/sticker) that is visible in [t, t + horizon] into
   * `out` (reused; grows only when needed). Returns the count. Used to pre-roll decoders and
   * preload images so clip boundaries are seamless.
   */
  collect(t: number, horizon: number, out: Slot[]): number {
    let n = 0
    const end = t + horizon
    const L = this.layout
    if (!this.mainHidden && L.clips.length > 0) {
      let i = Math.max(0, mainClipIndexAt(L, t))
      // the outgoing clip of an active transition is still visible
      if (i > 0 && t < L.starts[i]! + L.transIn[i]!) i--
      for (; i < L.clips.length && L.starts[i]! <= end; i++) {
        if (L.ends[i]! > t) n = pushSlot(out, n, L.clips[i]!, this.mainTrackIndex, L.starts[i]!, t)
      }
    }
    for (const track of this.#overlays) {
      let k = Math.max(0, lastStartAtOrBefore(track.starts, t))
      for (; k < track.clips.length && track.starts[k]! <= end; k++) {
        if (track.ends[k]! > t)
          n = pushSlot(out, n, track.clips[k]!, track.trackIndex, track.starts[k]!, t)
      }
    }
    return n
  }
}
