/**
 * Main-track maintenance: normalisation (magnetic contiguity + transition clamping) and
 * caption re-anchoring so captions stay in sync with the speech they transcribe when main
 * clips are trimmed, cut, reordered or re-timed.
 */
import type { Project, Us, Word } from '../schema.ts'
import {
  MIN_TRANSITION,
  addTrack,
  defaultTrack,
  isMediaClip,
  kindForClip,
  mainTrackLayout,
  placeClip,
  sortTrack,
  type MainLayoutEntry,
} from './project.ts'
import {
  clipTimeToSourceExact,
  sourceRange,
  sourceToClipTimeExact,
  speedProfile,
  type SpeedProfile,
} from './timemap.ts'
import { clamp } from './errors.ts'

/**
 * Enforce the main-track invariants: exactly one main track (extra ones become overlays,
 * a missing one is created), only media clips on it (others move to a suitable track),
 * clips contiguous from 0 in array order, no transition on the first clip and every other
 * transition clamped to half of both neighbours (removed when that drops below 50 ms).
 * Non-main tracks are kept sorted by start.
 */
export function normalizeMainTrack(p: Project): void {
  const mains = p.tracks.filter((t) => t.kind === 'main')
  const track = mains[0] ?? addTrack(p, 'main', { index: 0 })
  for (const extra of mains.slice(1)) extra.kind = 'overlay'

  const strays = track.clips.filter((c) => !isMediaClip(c))
  if (strays.length > 0) {
    track.clips = track.clips.filter(isMediaClip)
    for (const c of strays) placeClip(p, defaultTrack(p, kindForClip(c.type)), c)
  }

  let cursor = 0
  let prev: Us | undefined
  for (const clip of track.clips) {
    if (!isMediaClip(clip)) continue
    clip.start = cursor
    cursor += clip.duration
    if (clip.transitionIn) {
      const d =
        prev === undefined
          ? 0
          : Math.min(
              clip.transitionIn.duration,
              Math.floor(prev / 2),
              Math.floor(clip.duration / 2),
            )
      if (d < MIN_TRANSITION) delete clip.transitionIn
      else if (d !== clip.transitionIn.duration) clip.transitionIn.duration = d
    }
    prev = clip.duration
  }
  for (const t of p.tracks) sortTrack(t)
}

/**
 * Caption window of each main entry: overlaps are split at their midpoint so that every
 * playback instant belongs to exactly one clip (no duplicated words across transitions).
 */
export function captionWindows(layout: readonly MainLayoutEntry[]): Array<[Us, Us]> {
  return layout.map((e, i) => {
    const next = layout[i + 1]
    return [e.start + e.overlap / 2, e.end - (next ? next.overlap / 2 : 0)]
  })
}

/** Index of the main entry whose caption window contains t (binary search), or −1. */
export function windowIndexAt(windows: ReadonlyArray<readonly [Us, Us]>, t: number): number {
  let lo = 0
  let hi = windows.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const [a, b] = windows[mid]!
    if (t < a) hi = mid - 1
    else if (t >= b) lo = mid + 1
    else return mid
  }
  return -1
}

/** Insertion index for a main-track drop at playback time `at` (nearest clip boundary). */
export function mainIndexAt(p: Project, at: Us): number {
  let index = 0
  for (const e of mainTrackLayout(p)) if ((e.start + e.end) / 2 < at) index = e.index + 1
  return index
}

interface Anchor {
  clipId: string
  assetId: string
  /** Source times (fractional µs) of the word start/mid/end inside the anchoring clip. */
  src: [number, number, number]
  /** Old playback time of the word midpoint (tie-breaker between candidate clips). */
  mid: number
}

const audible = (e: MainLayoutEntry, trackMuted: boolean): boolean =>
  e.clip.type === 'video' && !trackMuted && !e.clip.audio.muted

/**
 * Snapshot the source position of every caption word that falls on an audible main-track
 * video clip. Words elsewhere (voice-over, overlays) are left untouched by re-anchoring.
 */
function anchorCaptions(p: Project): Array<Anchor | undefined> | undefined {
  const words = p.captions?.words
  if (!words || words.length === 0) return undefined
  const track = p.tracks.find((t) => t.kind === 'main')
  if (!track) return undefined
  const layout = mainTrackLayout(p)
  const windows = captionWindows(layout)
  const profiles = new Map<string, SpeedProfile>()
  // Indexed by word position (not identity) so it also works on Immer draft proxies.
  const anchors: Array<Anchor | undefined> = []
  for (const [index, word] of words.entries()) {
    const mid = (word.start + word.end) / 2
    const i = windowIndexAt(windows, mid)
    if (i < 0) continue
    const e = layout[i]!
    if (!audible(e, track.muted)) continue
    let prof = profiles.get(e.clip.id)
    if (!prof) profiles.set(e.clip.id, (prof = speedProfile(e.clip)))
    const at = (t: number) =>
      clipTimeToSourceExact(e.clip, clamp(t - e.start, 0, e.clip.duration), prof)
    anchors[index] = {
      clipId: e.clip.id,
      assetId: e.clip.assetId,
      src: [at(word.start), at(mid), at(word.end)],
      mid,
    }
  }
  return anchors
}

/** Re-map anchored words through the current main layout; words whose source is gone drop. */
function reanchorCaptions(p: Project, anchors: ReadonlyArray<Anchor | undefined>): void {
  const captions = p.captions
  if (!captions) return
  const layout = mainTrackLayout(p)
  const byAsset = new Map<string, Array<{ e: MainLayoutEntry; prof: SpeedProfile }>>()
  for (const e of layout) {
    if (e.clip.type !== 'video') continue
    const list = byAsset.get(e.clip.assetId) ?? []
    list.push({ e, prof: speedProfile(e.clip) })
    byAsset.set(e.clip.assetId, list)
  }
  const out: Word[] = []
  for (const [index, word] of captions.words.entries()) {
    const anchor = anchors[index]
    if (!anchor) {
      out.push(word)
      continue
    }
    let best: { e: MainLayoutEntry; prof: SpeedProfile; tau: number } | undefined
    let bestScore = Infinity
    for (const cand of byAsset.get(anchor.assetId) ?? []) {
      const tau = sourceToClipTimeExact(cand.e.clip, anchor.src[1], cand.prof)
      if (tau === undefined) continue
      const score =
        cand.e.clip.id === anchor.clipId ? -1 : Math.abs(cand.e.start + tau - anchor.mid)
      if (score < bestScore) {
        bestScore = score
        best = { ...cand, tau }
      }
    }
    if (!best) continue
    const { e, prof } = best
    const range = sourceRange(e.clip, prof)
    const map = (s: number) =>
      e.start + (sourceToClipTimeExact(e.clip, clamp(s, range.start, range.end), prof) ?? 0)
    let a = map(anchor.src[0])
    let b = map(anchor.src[2])
    if (a > b) [a, b] = [b, a]
    const start = Math.round(a)
    out.push({ ...word, start, end: Math.max(start + 1, Math.round(b)) })
  }
  out.sort((x, y) => x.start - y.start || x.end - y.end)
  captions.words = out
}

/**
 * Run a main-track edit: snapshot caption anchors, apply `fn`, renormalise the main track
 * and re-map captions through the new layout.
 */
export function editMain<T>(p: Project, fn: () => T): T {
  const anchors = anchorCaptions(p)
  const result = fn()
  normalizeMainTrack(p)
  if (anchors) reanchorCaptions(p, anchors)
  return result
}
