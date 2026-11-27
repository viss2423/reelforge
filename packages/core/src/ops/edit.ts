/**
 * Editing ops: split, trim, move, delete, duplicate, speed and source-range removal.
 * Timeline times for main-track clips are PLAYBACK times (see mainTrackLayout).
 */
import type { Asset, Clip, Project, Us } from '../schema.ts'
import { newId } from '../ids.ts'
import { OpError, clamp, clone, type Range } from './errors.ts'
import {
  assertUnlocked,
  getClip,
  getTrack,
  isFree,
  minClipDuration,
  placeClip,
  playbackStart,
  pruneEmptyTracks,
  trackAccepts,
} from './project.ts'
import { editMain, mainIndexAt, normalizeMainTrack } from './main.ts'
import { clipRanges, invertRanges } from './ranges.ts'
import { assignClip, scaleClipContent, shiftClipContent, sliceInPlace, subClip } from './slice.ts'
import { sourceRange, sourceSpan, sourceToClipTimeExact, speedProfile } from './timemap.ts'

/**
 * Split a clip at playback time `t`. The first half keeps the id, head attributes
 * (transitionIn, animationIn, fade-in); the second gets a new id and the tail attributes.
 * Both halves keep an exact source mapping; captions are unaffected.
 */
export function splitClip(p: Project, clipId: string, t: Us): [Clip, Clip] {
  const { track, clip, index } = getClip(p, clipId)
  assertUnlocked(track)
  const tau = t - playbackStart(p, track, clip)
  const min = minClipDuration(p.settings.fps)
  if (tau < min || clip.duration - tau < min) {
    throw new OpError('split_out_of_range', `cannot split ${clipId} at ${t}µs`)
  }
  // The tail is cut from the untouched clip before the head is sliced in place.
  const second = subClip(clip, tau, clip.duration, { keepId: false, head: false, tail: true })
  const first = sliceInPlace(clip, 0, tau, true, false)
  if (track.kind === 'main') {
    track.clips.splice(index, 1, first, second)
    normalizeMainTrack(p)
  } else {
    // A ramp re-solve can lengthen the tail by a few µs; never collide with the next clip.
    const next = track.clips[index + 1]
    if (next && second.start + second.duration > next.start) {
      second.duration = next.start - second.start
    }
    track.clips.splice(index, 1, first, second)
  }
  return [first, second]
}

/**
 * Extend a clip by `head`/`tail` µs, limited by the available source (in-point ≥ 0 and,
 * when `assetDuration` is known, source end ≤ asset duration). Content anchored to clip time
 * (keyframes, ramp, windowed effects) moves with the head extension.
 */
export function extendClip(c: Clip, head: Us, tail: Us, assetDuration: Us | undefined): void {
  const timed = c.type === 'video' || c.type === 'audio'
  const reversed = c.type === 'video' && c.reverse
  if (head > 0) {
    let e = head
    if (timed) {
      // Before the first ramp keyframe the ramp holds its first value.
      const rate = c.speed * (c.type === 'video' ? (c.speedRamp[0]?.value ?? 1) : 1)
      const avail = reversed ? (assetDuration ?? Infinity) - (c.in + sourceSpan(c)) : c.in
      e = Math.max(0, Math.min(e, Math.floor(avail / rate)))
      if (!reversed) c.in = Math.max(0, c.in - Math.round(e * rate))
    }
    if (e > 0) {
      shiftClipContent(c, e)
      c.start -= e
      c.duration += e
    }
  }
  if (tail > 0) {
    let target = c.duration + tail
    if (timed) {
      const prof = speedProfile(c)
      const span = prof.offsetAt(c.duration)
      const avail = reversed ? c.in : (assetDuration ?? Infinity) - (c.in + span)
      if (Number.isFinite(avail)) {
        target = Math.min(target, Math.floor(prof.timeAt(span + Math.max(0, avail))))
      }
      if (reversed && target > c.duration) {
        c.in = Math.max(0, c.in - Math.round(prof.offsetAt(target) - span))
      }
    }
    c.duration = Math.max(c.duration, target)
  }
}

/**
 * Move a clip's edges to playback times `start`/`end` (either may extend or shrink).
 * Non-main clips are clamped to their neighbours; main-track edits ripple. Extensions are
 * limited by the available source: pass `opts.asset` to also bound the source end.
 *
 * With `opts.ripple` a non-main clip trims like a main-track clip: it keeps its start (a
 * head trim cuts or reveals content at the head) and every later clip on its track shifts
 * by the change in duration, so neighbours never limit the trim and gaps are preserved.
 */
export function trimClip(
  p: Project,
  clipId: string,
  edges: { start?: Us; end?: Us },
  opts?: { asset?: Pick<Asset, 'duration'>; ripple?: boolean },
): void {
  const { track, clip } = getClip(p, clipId)
  assertUnlocked(track)
  const start = playbackStart(p, track, clip)
  const end = start + clip.duration
  let newStart = edges.start ?? start
  let newEnd = edges.end ?? end
  const ripple = opts?.ripple === true && track.kind !== 'main'
  if (track.kind !== 'main' && !ripple) {
    let lo = 0
    let hi = Infinity
    for (const c of track.clips) {
      if (c.id === clip.id) continue
      if (c.start + c.duration <= start) lo = Math.max(lo, c.start + c.duration)
      else if (c.start >= end) hi = Math.min(hi, c.start)
    }
    newStart = Math.max(newStart, lo)
    newEnd = Math.min(newEnd, hi)
  }
  if (newEnd - newStart < minClipDuration(p.settings.fps)) {
    throw new OpError('too_short', `trim would make ${clipId} shorter than one frame`)
  }
  const apply = () => {
    const cutHead = Math.max(0, newStart - start)
    const cutTail = Math.max(0, end - newEnd)
    if (cutHead > 0 || cutTail > 0) sliceInPlace(clip, cutHead, clip.duration - cutTail)
    extendClip(
      clip,
      Math.max(0, start - newStart),
      Math.max(0, newEnd - end),
      opts?.asset?.duration,
    )
  }
  if (track.kind === 'main') {
    editMain(p, apply)
    return
  }
  if (!ripple) {
    apply()
    return
  }
  const later = track.clips.filter((c) => c.id !== clip.id && c.start >= end)
  const before = clip.duration
  apply()
  clip.start = start
  const shift = clip.duration - before
  for (const c of later) c.start += shift
}

/**
 * Move a clip. On the main track `index` (or the boundary nearest to playback time `start`)
 * reorders it; moving between tracks re-places it at `start` (default: its current playback
 * start). Overlapping drops on non-main tracks land on a free or new track of that kind.
 */
export function moveClip(
  p: Project,
  clipId: string,
  to: { trackId?: string; start?: Us; index?: number },
): void {
  const { track, clip, index } = getClip(p, clipId)
  assertUnlocked(track)
  const target = to.trackId !== undefined ? getTrack(p, to.trackId) : track
  assertUnlocked(target)
  if (!trackAccepts(target.kind, clip.type)) {
    throw new OpError('track_kind', `a ${clip.type} clip cannot go on a ${target.kind} track`)
  }
  const fromStart = playbackStart(p, track, clip)
  if (track.kind !== 'main' && target.kind !== 'main') {
    track.clips.splice(index, 1)
    clip.start = Math.max(0, to.start ?? clip.start)
    placeClip(p, target, clip)
    pruneEmptyTracks(p)
    return
  }
  editMain(p, () => {
    track.clips.splice(index, 1)
    if (target.kind === 'main') {
      const at =
        to.index ??
        (to.start !== undefined
          ? mainIndexAt(p, to.start)
          : track === target
            ? index
            : target.clips.length)
      target.clips.splice(clamp(at, 0, target.clips.length), 0, clip)
    } else {
      if (clip.type === 'video' || clip.type === 'image') delete clip.transitionIn
      clip.start = Math.max(0, to.start ?? fromStart)
      placeClip(p, target, clip)
    }
  })
  pruneEmptyTracks(p)
}

/**
 * Delete clips. The main track always closes the gap (magnetic); with `ripple` other tracks
 * close the gaps on their own track as well.
 */
export function deleteClips(
  p: Project,
  clipIds: readonly string[],
  opts?: { ripple?: boolean },
): void {
  const found = clipIds.map((id) => getClip(p, id))
  for (const f of found) assertUnlocked(f.track)
  const ids = new Set(clipIds)
  const run = () => {
    for (const track of p.tracks) {
      if (!track.clips.some((c) => ids.has(c.id))) continue
      if (opts?.ripple && track.kind !== 'main') {
        let shift = 0
        const kept: Clip[] = []
        for (const c of track.clips) {
          if (ids.has(c.id)) shift += c.duration
          else {
            c.start -= shift
            kept.push(c)
          }
        }
        track.clips = kept
      } else track.clips = track.clips.filter((c) => !ids.has(c.id))
    }
  }
  if (found.some((f) => f.track.kind === 'main')) editMain(p, run)
  else run()
  pruneEmptyTracks(p)
}

/** Duplicate a clip right after itself (main: next index; elsewhere: next free slot). */
export function duplicateClip(p: Project, clipId: string): Clip {
  const { track, clip, index } = getClip(p, clipId)
  assertUnlocked(track)
  const copy = clone(clip)
  copy.id = newId('c_')
  if (copy.type === 'video' || copy.type === 'image') {
    copy.effects = copy.effects.map((e) => ({ ...e, id: newId('e_') }))
    delete copy.transitionIn
  }
  if (track.kind === 'main') editMain(p, () => track.clips.splice(index + 1, 0, copy))
  else {
    copy.start = clip.start + clip.duration
    placeClip(p, track, copy)
  }
  return copy
}

/**
 * Change playback speed (clamped to 0.1–16). The source span is preserved, so the duration
 * becomes duration × old/new; keyframes, ramp and effect windows scale along. The start is
 * kept; a non-main clip that would now overlap its neighbour is re-placed.
 */
export function setClipSpeed(p: Project, clipId: string, speed: number): void {
  const { track, clip, index } = getClip(p, clipId)
  assertUnlocked(track)
  if (clip.type !== 'video' && clip.type !== 'audio') {
    throw new OpError('not_timed', `${clip.type} clips have no playback speed`)
  }
  if (!Number.isFinite(speed)) throw new OpError('invalid_speed', `invalid speed ${speed}`)
  const s = clamp(speed, 0.1, 16)
  if (s === clip.speed) return
  const factor = clip.speed / s
  // Floor so the new source span never exceeds the old one (stays within the asset).
  const duration = Math.floor(clip.duration * factor)
  if (duration < minClipDuration(p.settings.fps)) {
    throw new OpError('too_short', `speed ${s} makes ${clipId} shorter than one frame`)
  }
  const apply = () => {
    scaleClipContent(clip, factor)
    clip.speed = s
    clip.duration = duration
    clip.audio.fadeIn = Math.min(clip.audio.fadeIn, duration)
    clip.audio.fadeOut = Math.min(clip.audio.fadeOut, duration)
  }
  if (track.kind === 'main') {
    editMain(p, apply)
    return
  }
  apply()
  if (!isFree(track, clip.start, clip.start + clip.duration, clip.id)) {
    track.clips.splice(index, 1)
    placeClip(p, track, clip)
  }
}

/**
 * Remove ranges given in the asset's SOURCE time from a video/audio clip (silence and filler
 * cuts). The clip is split into the kept pieces (exact source mapping for any speed, ramp or
 * reverse); main-track pieces ripple and captions are re-mapped (words inside removed spans
 * drop, later words shift). Non-main pieces are packed from the clip's start.
 */
export function removeSourceRanges(p: Project, clipId: string, ranges: readonly Range[]): void {
  const { track, clip, index } = getClip(p, clipId)
  assertUnlocked(track)
  if (clip.type !== 'video' && clip.type !== 'audio') {
    throw new OpError('not_timed', `${clip.type} clips have no source time`)
  }
  const prof = speedProfile(clip)
  const src = sourceRange(clip, prof)
  const removed = clipRanges(ranges, src.start, src.end)
  if (removed.length === 0) return
  const min = minClipDuration(p.settings.fps)
  const intervals = invertRanges(removed, src.start, src.end)
    .map((r) => {
      const a = sourceToClipTimeExact(clip, r.start, prof) ?? 0
      const b = sourceToClipTimeExact(clip, r.end, prof) ?? clip.duration
      return a <= b
        ? { a: Math.round(a), b: Math.round(b) }
        : { a: Math.round(b), b: Math.round(a) }
    })
    .filter((iv) => iv.b - iv.a >= min)
    .toSorted((x, y) => x.a - y.a)
  const last = intervals.length - 1
  const pieces: Clip[] = intervals.map((iv, k) =>
    subClip(clip, iv.a, iv.b, { keepId: k === 0, head: k === 0, tail: k === last }),
  )
  // The first piece keeps the clip's id and object identity. Captions are anchored (inside
  // editMain) before the clip is touched.
  const origin = clip.start
  const replace = () => {
    if (pieces[0]) pieces[0] = assignClip(clip, pieces[0] as typeof clip)
    track.clips.splice(index, 1, ...pieces)
  }
  if (track.kind === 'main') {
    editMain(p, replace)
    return
  }
  let cursor = origin
  for (const piece of pieces) {
    piece.start = cursor
    cursor += piece.duration
  }
  replace()
}
