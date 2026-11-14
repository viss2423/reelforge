/**
 * Geometric hit testing for the lanes: which row, clip and clip zone (body / trim handle)
 * a content-space point is over. Pointer handling runs on this instead of DOM targets so
 * it works for virtualised (unmounted) clips, generous touch slop and handles that extend
 * past the clip edges.
 */
import type { Clip, Marker, Track, Word } from '@reelforge/core'
import { HANDLE_SLOP_MOUSE, HANDLE_SLOP_TOUCH, HANDLE_WIDTH } from './constants.ts'
import { rowAt, timeToX, trackSpans, upperBound, xToTime, type Row } from './geometry.ts'

export type ClipZone = 'body' | 'trim-start' | 'trim-end'

export type Hit =
  | { kind: 'markers'; row: number; t: number; marker: Marker | null }
  | { kind: 'captions'; row: number; t: number; word: number }
  | {
      kind: 'clip'
      row: number
      track: Track
      index: number
      clip: Clip
      zone: ClipZone
      /** Playback span of the clip. */
      start: number
      end: number
      t: number
    }
  | { kind: 'track'; row: number; track: Track; t: number }
  | { kind: 'empty'; t: number }

export interface HitContext {
  rows: readonly Row[]
  ppu: number
  selected: ReadonlySet<string>
  /** Touch input: handles only on selected clips, with a larger slop. */
  touch: boolean
  markers: readonly Marker[]
  words: readonly Word[]
}

const wordStartCache = new WeakMap<readonly Word[], Float64Array>()

/** Index of the caption word containing `t`, or −1. Words are sorted by start. */
export const wordAt = (words: readonly Word[], t: number): number => {
  let starts = wordStartCache.get(words)
  if (!starts) {
    starts = Float64Array.from(words, (w) => w.start)
    wordStartCache.set(words, starts)
  }
  const i = upperBound(starts, t) - 1
  return i >= 0 && words[i]!.end > t ? i : -1
}

/** Marker closest to `t` within `slopUs`, or null. */
export const markerNear = (
  markers: readonly Marker[],
  t: number,
  slopUs: number,
): Marker | null => {
  let best: Marker | null = null
  let bestDist = slopUs
  for (const m of markers) {
    const d = Math.abs(m.t - t)
    if (d <= bestDist) {
      best = m
      bestDist = d
    }
  }
  return best
}

/** Hit test at content coordinates (`y` measured from the top of the lanes, below the ruler). */
export const hitTest = (ctx: HitContext, x: number, y: number): Hit => {
  const t = xToTime(x, ctx.ppu)
  const ri = rowAt(ctx.rows, y)
  if (ri === -1) return { kind: 'empty', t }
  const row = ctx.rows[ri]!
  if (row.type === 'markers')
    return { kind: 'markers', row: ri, t, marker: markerNear(ctx.markers, t, 10 / ctx.ppu) }
  if (row.type === 'captions') return { kind: 'captions', row: ri, t, word: wordAt(ctx.words, t) }
  return hitTrack(ctx, ri, row.track, x, t)
}

const hitTrack = (ctx: HitContext, ri: number, track: Track, x: number, t: number): Hit => {
  const spans = trackSpans(track)
  const n = track.clips.length
  const outerSlopPx = ctx.touch ? HANDLE_SLOP_TOUCH : HANDLE_SLOP_MOUSE
  const slopUs = outerSlopPx / ctx.ppu
  // Candidates: clips whose span ± slop contains t (a handful at most).
  const from = Math.max(0, upperBound(spans.ends, t - slopUs) - 1)
  let inside = -1
  for (let i = from; i < n && spans.starts[i]! <= t; i++) {
    // Later clips win where main-track transitions overlap (they draw on top).
    if (t < spans.ends[i]!) inside = i
  }
  const clipHit = (i: number, zone: ClipZone): Hit => ({
    kind: 'clip',
    row: ri,
    track,
    index: i,
    clip: track.clips[i]!,
    zone,
    start: spans.starts[i]!,
    end: spans.ends[i]!,
    t,
  })
  const handles = (i: number) => !ctx.touch || ctx.selected.has(track.clips[i]!.id)

  if (inside !== -1) {
    const sx = timeToX(spans.starts[inside]!, ctx.ppu)
    const ex = timeToX(spans.ends[inside]!, ctx.ppu)
    if (handles(inside)) {
      const selected = ctx.selected.has(track.clips[inside]!.id)
      // Inner handle zone: the visible handle for selected clips, a thin edge otherwise,
      // never more than a third of the clip so tiny clips can still be moved.
      const inner = Math.min(selected ? HANDLE_WIDTH : HANDLE_SLOP_MOUSE, (ex - sx) / 3)
      if (x - sx <= inner) return clipHit(inside, 'trim-start')
      if (ex - x <= inner) return clipHit(inside, 'trim-end')
    }
    return clipHit(inside, 'body')
  }
  // Outside every clip: edges within the outer slop still grab the nearest handle.
  let best: Hit | null = null
  let bestDist = outerSlopPx
  for (let i = from; i < n && spans.starts[i]! <= t + slopUs; i++) {
    if (!handles(i)) continue
    const ds = timeToX(spans.starts[i]!, ctx.ppu) - x
    const de = x - timeToX(spans.ends[i]!, ctx.ppu)
    if (ds >= 0 && ds <= bestDist) {
      best = clipHit(i, 'trim-start')
      bestDist = ds
    }
    if (de >= 0 && de <= bestDist) {
      best = clipHit(i, 'trim-end')
      bestDist = de
    }
  }
  return best ?? { kind: 'track', row: ri, track, t }
}
