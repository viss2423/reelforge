/**
 * Clip-local time → source time for media clips.
 *
 * Core's `timelineToSource(clip, t)` measures `t` against `clip.start`, but on the main track
 * a clip's RENDERED start is earlier than `clip.start` when a transition overlaps it. The
 * preview always works in clip-local time (t − rendered start), so it re-bases onto
 * `clip.start` before calling core; this keeps speed ramps / reverse semantics in ONE place.
 */
import { timelineToSource, type MediaClip } from '@reelforge/core'

/** Source time (us) shown by `clip` at clip-local time `local` (us). Images return `in`. */
export function sourceTimeAt(clip: MediaClip, local: number): number {
  if (clip.type === 'image') return clip.in
  const tau = local < 0 ? 0 : local > clip.duration ? clip.duration : local
  return timelineToSource(clip, clip.start + Math.round(tau))
}

/**
 * Signed source-time rate at clip-local time `local` (source us per timeline us) — a decode
 * hint (read-ahead direction and distance), so a central difference over one frame is enough
 * and also captures speed ramps without depending on core internals.
 */
export function sourceRateAt(clip: MediaClip, local: number, frame = 33_333): number {
  if (clip.type === 'image') return 0
  const a = Math.max(0, local - frame / 2)
  const b = Math.min(clip.duration, local + frame / 2)
  if (b <= a) return clip.reverse ? -clip.speed : clip.speed
  return (sourceTimeAt(clip, b) - sourceTimeAt(clip, a)) / (b - a)
}
