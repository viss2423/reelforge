/** Automatic music: place a library/generated track as the reel's music bed. */
import {
  AudioClip,
  type Asset,
  type AudioClip as AudioClipT,
  type Project,
  type Us,
} from '../schema.ts'
import { newId } from '../ids.ts'
import { OpError, clone } from './errors.ts'
import {
  defaultTrack,
  mainTrackLayout,
  minClipDuration,
  placeClip,
  projectDuration,
} from './project.ts'

/** Fade-in used when the music starts mid-track (at the chorus) rather than at its intro. */
export const MUSIC_FADE_IN: Us = 300_000
/** Longest fade-out at the end of the reel. */
export const MUSIC_FADE_OUT_MAX: Us = 1_500_000
/** Music length used when the project has no video yet. */
export const MUSIC_DEFAULT_LENGTH: Us = 30_000_000

export interface InsertMusicArgs {
  asset: Asset
  /**
   * Source time to start from (usually the most energetic section). Defaults to
   * `asset.music.section.start`, else 0. Moved earlier when the rest of the track is shorter
   * than the reel.
   */
  sourceStart?: Us
  /** Timeline length to fill. Default: the main track's length (the reel), else 30 s. */
  length?: Us
  /** Duck under speech on other tracks. */
  duck?: boolean
  /** Beat times in SOURCE time (default `asset.beats`) → beat markers on the timeline. */
  beats?: readonly Us[]
  /** Bar starts in source time (default `asset.music.downbeats`), labelled as bars. */
  downbeats?: readonly Us[]
  /** Remove the project's other music clips first (default true). */
  replaceExisting?: boolean
  /** Replace the project's beat markers with this track's (default true). */
  markers?: boolean
}

/** Length of the reel's picture: the main track, falling back to everything else. */
export function reelLength(p: Project): Us {
  const layout = mainTrackLayout(p)
  const main = layout.at(-1)?.end ?? 0
  return main > 0 ? main : projectDuration(p)
}

/**
 * Insert `asset` as the music bed: starts at timeline 0, trimmed to the reel, entering at
 * `sourceStart` (the chorus) with a short fade-in, fading out at the end, ducked under
 * speech when asked, and with the track's beats as timeline markers (so beat-sync and
 * snapping line up with it). Returns the new clip.
 */
export function insertMusicClip(p: Project, args: InsertMusicArgs): AudioClipT {
  const { asset } = args
  if (asset.kind !== 'audio' && !(asset.kind === 'video' && asset.hasAudio)) {
    throw new OpError('asset_kind', `asset ${asset.id} has no audio`)
  }
  const total = asset.duration
  if (!total) throw new OpError('asset_not_ready', `asset ${asset.id} has no duration`)
  const min = minClipDuration(p.settings.fps)
  if (total < min) throw new OpError('too_short', `asset ${asset.id} is shorter than one frame`)

  const wanted = Math.max(min, args.length ?? (reelLength(p) || MUSIC_DEFAULT_LENGTH))
  let start = Math.max(
    0,
    Math.min(args.sourceStart ?? asset.music?.section?.start ?? 0, total - min),
  )
  // Not enough music left after the chorus: start earlier so the whole reel has music.
  if (total - start < wanted) start = Math.max(0, total - wanted)
  start = Math.round(start)
  const duration = Math.round(Math.min(wanted, total - start))

  if (args.replaceExisting ?? true) {
    for (const t of p.tracks) {
      if (t.kind !== 'audio' || t.locked) continue
      t.clips = t.clips.filter((c) => !(c.type === 'audio' && c.role === 'music'))
    }
  }

  const clip = clone(
    AudioClip.parse({
      id: newId('c_'),
      type: 'audio',
      assetId: asset.id,
      start: 0,
      duration,
      in: start,
      role: 'music',
      duckUnderVoice: args.duck ?? false,
      name: (asset.music?.title ?? asset.name).slice(0, 200),
      audio: {
        fadeIn: start > 0 ? Math.min(MUSIC_FADE_IN, Math.floor(duration / 4)) : 0,
        fadeOut: Math.min(MUSIC_FADE_OUT_MAX, Math.floor(duration / 4)),
      },
    }),
  )
  placeClip(p, defaultTrack(p, 'audio'), clip)

  if (args.markers ?? true) {
    const beats = args.beats ?? asset.beats ?? []
    if (beats.length > 0) {
      const bars = new Set(args.downbeats ?? asset.music?.downbeats ?? [])
      p.markers = p.markers.filter((m) => m.kind !== 'beat')
      for (const b of beats) {
        const t = b - start
        if (t < 0 || t >= duration) continue
        p.markers.push({
          id: newId('m_'),
          t,
          kind: 'beat',
          ...(bars.has(b) ? { label: 'bar' } : {}),
        })
      }
      p.markers.sort((a, b) => a.t - b.t)
    }
  }
  return clip
}

/**
 * Credit lines for the music used in a project, for the post caption (licences such as
 * CC BY require them). Deduplicated, in timeline order.
 */
export function musicCredits(p: Project, assets: Readonly<Record<string, Asset>>): string[] {
  const clips: AudioClipT[] = []
  for (const t of p.tracks)
    for (const c of t.clips) if (c.type === 'audio' && !c.audio.muted) clips.push(c)
  clips.sort((a, b) => a.start - b.start)
  const out: string[] = []
  for (const c of clips) {
    const m = assets[c.assetId]?.music
    if (!m) continue
    const line =
      m.attribution ??
      (m.licence.attributionRequired
        ? `"${m.title}" by ${m.artist || 'unknown artist'} (${m.licence.name})`
        : undefined)
    if (line && !out.includes(line)) out.push(line)
  }
  return out
}

/** Copy of the project without its music bed (export option "No music"). */
export function withoutMusic(p: Project): Project {
  const out = clone(p)
  for (const t of out.tracks)
    t.clips = t.clips.filter((c) => !(c.type === 'audio' && c.role === 'music'))
  return out
}
