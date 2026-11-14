/**
 * Main-track render layout (transition-overlap semantics).
 *
 * The overlap maths lives in one place, core's `mainTrackLayout` (ops/project.ts), shared
 * by the ops, the preview and this compiler: each transition overlaps the incoming clip with
 * the tail of the previous one, so the rendered main track is `Σ durations − Σ transitions`
 * long. This module only adds the render-specific framing (track flags, frame windows).
 * Overlay/text/audio clips and captions are placed on that rendered timeline as-is.
 */
import type { Project, Track, Us } from '../schema.ts'
import { mainTrackLayout, type MainLayoutEntry } from '../ops/project.ts'

/** The main track together with its overlap-adjusted clip layout. */
export interface MainLayout {
  track: Track | undefined
  items: MainLayoutEntry[]
  /** Rendered length of the main track (us). */
  duration: Us
}

/** Compute the rendered layout of the main track (see core `mainTrackLayout`). */
export function renderLayout(p: Project): MainLayout {
  const items = mainTrackLayout(p)
  return {
    track: p.tracks.find((t) => t.kind === 'main'),
    items,
    duration: items.at(-1)?.end ?? 0,
  }
}

/**
 * Rendered project duration: the main track's rendered length or the end of the last clip
 * on any other track, whichever is later.
 */
export function renderDuration(p: Project, layout: MainLayout = renderLayout(p)): Us {
  let end = layout.duration
  for (const track of p.tracks) {
    if (track.kind === 'main') continue
    for (const clip of track.clips) end = Math.max(end, clip.start + clip.duration)
  }
  return end
}

/** Timeline microseconds → output frame index (nearest frame boundary). */
export const usToFrame = (us: number, fps: number): number => Math.round((us * fps) / 1_000_000)

/** Output frame index → microseconds. */
export const frameToUs = (frame: number, fps: number): number =>
  Math.round((frame * 1_000_000) / fps)

/** Half-open frame interval [start, end) on the output timeline. */
export interface FrameSpan {
  start: number
  end: number
}

/** The rendered output window in frames: the whole project or `settings.range`. */
export function renderWindow(
  totalUs: Us,
  range: { start: Us; end: Us } | undefined,
  fps: number,
): FrameSpan {
  const total = usToFrame(totalUs, fps)
  if (!range) return { start: 0, end: total }
  const start = Math.min(total, usToFrame(range.start, fps))
  const end = Math.min(total, usToFrame(range.end, fps))
  return { start, end: Math.max(start, end) }
}

/**
 * Visible part of a clip occupying output frames `[start, end)` inside `window`.
 * `head` is the number of frames cut from the clip's beginning by the window.
 */
export interface ClipWindow {
  /** First visible frame on the output timeline (absolute). */
  start: number
  /** Number of visible frames. */
  frames: number
  /** Frames cut from the clip head. */
  head: number
}

/** Intersect a clip's frame span with the window (undefined when not visible). */
export function clipWindow(span: FrameSpan, window: FrameSpan): ClipWindow | undefined {
  const start = Math.max(span.start, window.start)
  const end = Math.min(span.end, window.end)
  if (end <= start) return undefined
  return { start, frames: end - start, head: start - span.start }
}

/** Frame span of a clip placed at [startUs, startUs + durationUs). */
export const frameSpan = (startUs: number, durationUs: number, fps: number): FrameSpan => {
  const start = usToFrame(startUs, fps)
  return { start, end: Math.max(start + 1, usToFrame(startUs + durationUs, fps)) }
}
