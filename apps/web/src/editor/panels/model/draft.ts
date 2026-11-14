/**
 * Structural helpers over a project (frozen snapshot or Immer draft). They only read the
 * model shape, so property edits in the panels need no core op and stay O(tracks × clips)
 * with no allocation beyond the result.
 */
import type {
  AudioClip,
  Clip,
  MediaClip,
  Project,
  StickerClip,
  TextClip,
  Track,
  Us,
} from '@reelforge/core'

export type VisualClip = MediaClip | TextClip | StickerClip
export type TimedClip = MediaClip | AudioClip

export const isMedia = (c: Clip | undefined): c is MediaClip =>
  c?.type === 'video' || c?.type === 'image'
export const isVideo = (c: Clip | undefined): c is MediaClip => c?.type === 'video'
export const isAudioClip = (c: Clip | undefined): c is AudioClip => c?.type === 'audio'
export const isText = (c: Clip | undefined): c is TextClip => c?.type === 'text'
export const isSticker = (c: Clip | undefined): c is StickerClip => c?.type === 'sticker'
/** Clips with a `transform` (drawn on the canvas). */
export const isVisual = (c: Clip | undefined): c is VisualClip =>
  isMedia(c) || isText(c) || isSticker(c)
/** Clips with an `audio` block (volume, fades, denoise…). */
export const hasAudio = (c: Clip | undefined): c is TimedClip => isVideo(c) || isAudioClip(c)

export interface Located<C extends Clip = Clip> {
  track: Track
  clip: C
  index: number
}

/** Finds a clip by id (works on drafts, unlike the cached selector index). */
export const locate = (p: Project, clipId: string): Located | undefined => {
  for (const track of p.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId)
    if (index !== -1) return { track, clip: track.clips[index]!, index }
  }
  return undefined
}

/** Like `locate` but narrowed by a type guard; undefined when missing or of another type. */
export const clipOf = <C extends Clip>(
  p: Project,
  clipId: string,
  guard: (c: Clip | undefined) => c is C,
): C | undefined => {
  const c = locate(p, clipId)?.clip
  return guard(c) ? c : undefined
}

export const mainOf = (p: Project): Track | undefined => p.tracks.find((t) => t.kind === 'main')

/** Main-track clip whose span contains `t` (the clip "under the playhead"). */
export const mainClipAt = (p: Project, t: Us): MediaClip | undefined => {
  const clips = mainOf(p)?.clips ?? []
  for (const c of clips) {
    if (isMedia(c) && c.start <= t && t < c.start + c.duration) return c
  }
  // At the very end of the timeline the playhead sits on the last frame of the last clip.
  const last = clips.at(-1)
  return isMedia(last) && t === last.start + last.duration ? last : undefined
}

/** All media clips on the main track, in order. */
export const mainMediaClips = (p: Project): MediaClip[] => (mainOf(p)?.clips ?? []).filter(isMedia)

/** Every clip of the project matching `guard`, with its track. */
export const allClips = <C extends Clip>(
  p: Project,
  guard: (c: Clip | undefined) => c is C,
): Array<{ track: Track; clip: C }> => {
  const out: Array<{ track: Track; clip: C }> = []
  for (const track of p.tracks)
    for (const clip of track.clips) if (guard(clip)) out.push({ track, clip })
  return out
}

/** Clip-relative time of the playhead, or undefined when the playhead is outside the clip. */
export const clipTimeAt = (clip: Clip, playhead: Us): Us | undefined => {
  const t = playhead - clip.start
  return t >= 0 && t <= clip.duration ? t : undefined
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
