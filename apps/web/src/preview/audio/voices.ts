/**
 * Pure audio planning: which clips sound when (voices), their gain envelopes (volume,
 * fades, transition crossfades, ducking) and how a time window maps onto decoded source
 * segments (pieces). The WebAudio engine turns these into scheduled nodes.
 *
 * Mix semantics shared with the export compiler:
 * - Main-track transitions crossfade audio linearly over the overlap (acrossfade, tri curve):
 *   the incoming clip fades in and the outgoing clip fades out over the transition.
 * - Fades are linear (afade default `tri`). Volume is linear gain.
 * - Ducking approximates the sidechain compressor: clips with `duckUnderVoice` are lowered to
 *   {@link DUCK_GAIN} while any dialogue source (video audio or a voiceover clip) is active,
 *   with {@link DUCK_ATTACK_US}/{@link DUCK_RELEASE_US} ramps. (The export reacts to actual
 *   speech level; the preview reacts to clip presence.)
 */
import type { Asset, AudioClip, MediaClip, Project } from '@reelforge/core'
import type { MainLayout } from '../timeline/layout.ts'

export const DUCK_GAIN = 0.3
export const DUCK_ATTACK_US = 150_000
export const DUCK_RELEASE_US = 400_000

export interface Voice {
  clipId: string
  assetId: string
  trackId: string
  /** Rendered timeline span [start, end) in us. */
  start: number
  end: number
  /** Source in-point (us) and playback speed. */
  in: number
  speed: number
  reverse: boolean
  volume: number
  /** Effective linear fade lengths (us), including transition crossfades. */
  fadeIn: number
  fadeOut: number
  /** This voice is lowered under dialogue. */
  duck: boolean
  /** This voice is dialogue (drives ducking). */
  dialogue: boolean
  preservePitch: boolean
}

export interface CollectOptions {
  /** When non-empty, only these tracks are heard. */
  solo?: ReadonlySet<string> | undefined
}

const audible = (c: MediaClip | AudioClip, assets: Readonly<Record<string, Asset>>): boolean => {
  if (c.audio.muted || c.audio.volume <= 0) return false
  const a = assets[c.assetId]
  return !!a && a.hasAudio
}

/** Every audible clip of the project as a {@link Voice}, ordered by start. */
export function collectVoices(
  project: Project,
  layout: MainLayout,
  assets: Readonly<Record<string, Asset>>,
  opts: CollectOptions = {},
): Voice[] {
  const out: Voice[] = []
  const solo = opts.solo && opts.solo.size > 0 ? opts.solo : undefined
  for (const track of project.tracks) {
    if (track.muted || (solo && !solo.has(track.id))) continue
    if (track.kind === 'main') {
      for (let i = 0; i < layout.clips.length; i++) {
        const c = layout.clips[i]!
        if (c.type !== 'video' || !audible(c, assets)) continue
        const xIn = layout.transIn[i]!
        const xOut = i + 1 < layout.clips.length ? layout.transIn[i + 1]! : 0
        out.push(voiceOf(c, track.id, layout.starts[i]!, layout.ends[i]!, xIn, xOut, false, true))
      }
    } else if (track.kind === 'overlay' || track.kind === 'audio') {
      for (const c of track.clips) {
        if (c.type === 'video' && audible(c, assets)) {
          out.push(voiceOf(c, track.id, c.start, c.start + c.duration, 0, 0, false, true))
        } else if (c.type === 'audio' && audible(c, assets)) {
          out.push(
            voiceOf(
              c,
              track.id,
              c.start,
              c.start + c.duration,
              0,
              0,
              c.duckUnderVoice,
              c.role === 'voiceover',
            ),
          )
        }
      }
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

function voiceOf(
  c: MediaClip | AudioClip,
  trackId: string,
  start: number,
  end: number,
  crossIn: number,
  crossOut: number,
  duck: boolean,
  dialogue: boolean,
): Voice {
  return {
    clipId: c.id,
    assetId: c.assetId,
    trackId,
    start,
    end,
    in: c.in,
    speed: c.speed,
    reverse: c.type === 'video' ? c.reverse : false,
    volume: c.audio.volume,
    fadeIn: Math.min(end - start, Math.max(c.audio.fadeIn, crossIn)),
    fadeOut: Math.min(end - start, Math.max(c.audio.fadeOut, crossOut)),
    duck: duck && !dialogue,
    dialogue,
    preservePitch: c.audio.preservePitch,
  }
}

/** Linear fade/volume gain of a voice at timeline time t (0 outside the voice). */
export function voiceGainAt(v: Voice, t: number): number {
  if (t < v.start || t >= v.end) return 0
  let g = v.volume
  if (v.fadeIn > 0 && t < v.start + v.fadeIn) g *= (t - v.start) / v.fadeIn
  if (v.fadeOut > 0 && t > v.end - v.fadeOut) g *= (v.end - t) / v.fadeOut
  return g
}

export interface Interval {
  start: number
  end: number
}

/**
 * Time ranges during which dialogue is active, merged when the gap is shorter than the
 * release (so music does not pump between sentences).
 */
export function duckIntervals(voices: readonly Voice[]): Interval[] {
  const spans = voices
    .filter((v) => v.dialogue)
    .map((v) => ({ start: v.start, end: v.end }))
    .sort((a, b) => a.start - b.start)
  const out: Interval[] = []
  for (const s of spans) {
    const last = out[out.length - 1]
    if (last && s.start - last.end < DUCK_RELEASE_US) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

/** Duck gain factor (DUCK_GAIN..1) at time t for the given dialogue intervals. */
export function duckFactorAt(intervals: readonly Interval[], t: number): number {
  let f = 1
  for (const iv of intervals) {
    if (t < iv.start) break
    if (t < iv.end) {
      const k = Math.min(1, (t - iv.start) / DUCK_ATTACK_US)
      f = Math.min(f, 1 - (1 - DUCK_GAIN) * k)
    } else if (t < iv.end + DUCK_RELEASE_US) {
      const k = (t - iv.end) / DUCK_RELEASE_US
      f = Math.min(f, DUCK_GAIN + (1 - DUCK_GAIN) * k)
    }
  }
  return f
}

/** A contiguous run of one source segment to play. */
export interface Piece {
  /** Segment index on the uniform source grid (segment j = [j·seg, (j+1)·seg)). */
  seg: number
  /** Timeline time (us) at which the piece starts sounding. */
  when: number
  /** Source range [srcStart, srcEnd) in us. Played backwards when the voice is reversed. */
  srcStart: number
  srcEnd: number
}

/**
 * Split the part of voice `v` audible in timeline window [from, to) into per-segment pieces,
 * in timeline order. Writes into `out` (reused) and returns the count.
 */
export function planPieces(v: Voice, from: number, to: number, seg: number, out: Piece[]): number {
  const a = Math.max(from, v.start)
  const b = Math.min(to, v.end)
  if (b <= a) return 0
  let n = 0
  const push = (j: number, when: number, s0: number, s1: number): void => {
    if (s1 - s0 <= 0.5) return // sub-microsecond slivers from float boundaries
    const p = out[n] ?? (out[n] = { seg: 0, when: 0, srcStart: 0, srcEnd: 0 })
    p.seg = j
    p.when = when
    p.srcStart = s0
    p.srcEnd = s1
    n++
  }
  if (!v.reverse) {
    const s0 = v.in + (a - v.start) * v.speed
    const s1 = v.in + (b - v.start) * v.speed
    for (let j = Math.floor(s0 / seg); j * seg < s1; j++) {
      const p0 = Math.max(s0, j * seg)
      const p1 = Math.min(s1, (j + 1) * seg)
      push(j, v.start + (p0 - v.in) / v.speed, p0, p1)
    }
  } else {
    // source runs backwards: s(t) = in + (end − t)·speed
    const sHi = v.in + (v.end - a) * v.speed
    const sLo = v.in + (v.end - b) * v.speed
    for (let j = Math.ceil(sHi / seg) - 1; (j + 1) * seg > sLo && j >= 0; j--) {
      const p1 = Math.min(sHi, (j + 1) * seg)
      const p0 = Math.max(sLo, j * seg)
      push(j, v.end - (p1 - v.in) / v.speed, p0, p1)
    }
  }
  return n
}
