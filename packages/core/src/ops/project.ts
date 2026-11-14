/**
 * Project/track primitives and the main-track playback layout.
 *
 * TRANSITION OVERLAP SEMANTICS
 * Main-track clips are stored contiguously in the MODEL: clip[i].start = Σ duration[0..i).
 * At playback/render time every transition overlaps the incoming clip with the tail of the
 * previous clip, so the EFFECTIVE (playback) start of clip i is
 *   effStart[i] = effStart[i-1] + duration[i-1] − overlap[i]
 * and the total main duration is Σ durations − Σ overlaps. `mainTrackLayout()` returns these
 * effective times; the compiler, the preview and every op that takes a timeline time for a
 * main-track clip use them. All other tracks, captions and markers are already in playback
 * time.
 */
import {
  Project,
  Track,
  type Clip,
  type MediaClip,
  type TrackKind,
  type Transition,
  type Us,
} from '../schema.ts'
import { newId } from '../ids.ts'
import { OpError, clone } from './errors.ts'

/** Shortest transition allowed by the schema; shorter clamps remove the transition. */
export const MIN_TRANSITION: Us = 50_000

/** Minimum clip duration: one frame at the project frame rate (rounded down to whole µs). */
export const minClipDuration = (fps: number): Us => Math.floor(1_000_000 / fps)

export const isMediaClip = (c: Clip): c is MediaClip => c.type === 'video' || c.type === 'image'

/** Whether a track of `kind` may hold a clip of `type`. */
export function trackAccepts(kind: TrackKind, type: Clip['type']): boolean {
  switch (kind) {
    case 'main':
      return type === 'video' || type === 'image'
    case 'overlay':
      return type === 'video' || type === 'image' || type === 'sticker'
    case 'text':
      return type === 'text'
    case 'audio':
      return type === 'audio'
  }
}

/** Natural track kind for a new track created to hold a clip of `type`. */
export const kindForClip = (type: Clip['type']): Exclude<TrackKind, 'main'> =>
  type === 'text' ? 'text' : type === 'audio' ? 'audio' : 'overlay'

const DEFAULT_NAMES: Record<TrackKind, string> = {
  main: 'Main',
  overlay: 'Overlay',
  text: 'Text',
  audio: 'Audio',
}

const makeTrack = (kind: TrackKind, name: string): Track =>
  clone(Track.parse({ id: newId('t_'), kind, name }))

/** New empty project: a main track, a text track and an audio track. */
export function createProject(opts: {
  name: string
  fps?: 24 | 25 | 30 | 50 | 60
  id?: string
  now?: string
}): Project {
  const now = opts.now ?? new Date().toISOString()
  return clone(
    Project.parse({
      id: opts.id ?? newId('p_'),
      name: opts.name,
      createdAt: now,
      updatedAt: now,
      settings: { fps: opts.fps ?? 30 },
      tracks: [makeTrack('main', 'Main'), makeTrack('text', 'Text'), makeTrack('audio', 'Audio')],
    }),
  )
}

/** The single main track. Throws if the project has none. */
export function mainTrack(p: Project): Track {
  const t = p.tracks.find((tr) => tr.kind === 'main')
  if (!t) throw new OpError('no_main_track', 'project has no main track')
  return t
}

export function findClip(
  p: Project,
  clipId: string,
): { track: Track; clip: Clip; index: number } | undefined {
  for (const track of p.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId)
    if (index !== -1) return { track, clip: track.clips[index]!, index }
  }
  return undefined
}

/** findClip that throws `clip_not_found`. */
export function getClip(p: Project, clipId: string): { track: Track; clip: Clip; index: number } {
  const found = findClip(p, clipId)
  if (!found) throw new OpError('clip_not_found', `clip ${clipId} not found`)
  return found
}

export function getTrack(p: Project, trackId: string): Track {
  const t = p.tracks.find((tr) => tr.id === trackId)
  if (!t) throw new OpError('track_not_found', `track ${trackId} not found`)
  return t
}

export function assertUnlocked(track: Track): void {
  if (track.locked) throw new OpError('track_locked', `track ${track.id} is locked`)
}

/**
 * Add a track. Default position keeps the usual stacking: overlays directly above the main
 * track / other overlays (below text), text and audio tracks at the end.
 */
export function addTrack(
  p: Project,
  kind: TrackKind,
  opts?: { name?: string; index?: number },
): Track {
  if (kind === 'main' && p.tracks.some((t) => t.kind === 'main')) {
    throw new OpError('main_exists', 'a project has exactly one main track')
  }
  const sameKind = p.tracks.filter((t) => t.kind === kind).length
  const name = opts?.name ?? `${DEFAULT_NAMES[kind]}${sameKind > 0 ? ` ${sameKind + 1}` : ''}`
  const track = makeTrack(kind, name)
  let index = opts?.index
  if (index === undefined) {
    if (kind === 'main') index = 0
    else if (kind === 'overlay') {
      let last = -1
      p.tracks.forEach((t, i) => {
        if (t.kind === 'main' || t.kind === 'overlay') last = i
      })
      index = last + 1
    } else index = p.tracks.length
  }
  p.tracks.splice(Math.max(0, Math.min(index, p.tracks.length)), 0, track)
  return track
}

export function removeTrack(p: Project, trackId: string): void {
  const index = p.tracks.findIndex((t) => t.id === trackId)
  if (index === -1) throw new OpError('track_not_found', `track ${trackId} not found`)
  if (p.tracks[index]!.kind === 'main') {
    throw new OpError('main_required', 'the main track cannot be removed')
  }
  p.tracks.splice(index, 1)
}

/**
 * Remove empty non-main tracks so moves and deletes don't leave dead lanes behind. The
 * default lanes of a new project (the first text and the first audio track) and locked
 * tracks are kept: an empty default lane is where the next text/audio lands, and a lock is
 * an explicit user choice.
 */
export function pruneEmptyTracks(p: Project): void {
  const firstText = p.tracks.find((t) => t.kind === 'text')
  const firstAudio = p.tracks.find((t) => t.kind === 'audio')
  p.tracks = p.tracks.filter(
    (t) =>
      t.kind === 'main' || t.clips.length > 0 || t.locked || t === firstText || t === firstAudio,
  )
}

/** One main-track clip with its effective (overlap-adjusted) playback times. */
export interface MainLayoutEntry {
  clip: MediaClip
  index: number
  /** Effective playback start (µs). */
  start: Us
  /** Effective playback end = start + duration. */
  end: Us
  /** Effective overlap with the previous clip (0 when no transition). */
  overlap: Us
}

/** Effective overlap of a transition between clips of durations `prev` and `cur`. */
export function effectiveOverlap(
  transition: Transition | undefined,
  prev: Us | undefined,
  cur: Us,
): Us {
  if (!transition || prev === undefined) return 0
  const d = Math.min(transition.duration, Math.floor(prev / 2), Math.floor(cur / 2))
  return d >= MIN_TRANSITION ? d : 0
}

/** Effective playback layout of the main track (see module docs). */
export function mainTrackLayout(p: Pick<Project, 'tracks'>): MainLayoutEntry[] {
  const track = p.tracks.find((t) => t.kind === 'main')
  if (!track) return []
  const out: MainLayoutEntry[] = []
  let cursor = 0
  let prevDuration: Us | undefined
  track.clips.forEach((clip, index) => {
    if (!isMediaClip(clip)) return
    const overlap = effectiveOverlap(clip.transitionIn, prevDuration, clip.duration)
    const start = cursor - overlap
    out.push({ clip, index, start, end: start + clip.duration, overlap })
    cursor = start + clip.duration
    prevDuration = clip.duration
  })
  return out
}

/** Playback start of a clip: effective start on the main track, `clip.start` elsewhere. */
export function playbackStart(p: Project, track: Track, clip: Clip): Us {
  if (track.kind !== 'main') return clip.start
  const entry = mainTrackLayout(p).find((e) => e.clip.id === clip.id)
  return entry ? entry.start : clip.start
}

/** Total playback duration: main track (overlap-adjusted) or the latest clip end elsewhere. */
export function projectDuration(p: Project): Us {
  let end = 0
  for (const track of p.tracks) {
    if (track.kind === 'main') {
      const layout = mainTrackLayout(p)
      const last = layout[layout.length - 1]
      if (last && last.end > end) end = last.end
    } else {
      for (const c of track.clips) if (c.start + c.duration > end) end = c.start + c.duration
    }
  }
  return end
}

/** True when [start, end) does not intersect any clip of the track (ignoring `exceptId`). */
export function isFree(track: Track, start: Us, end: Us, exceptId?: string): boolean {
  for (const c of track.clips) {
    if (c.id === exceptId) continue
    if (c.start < end && start < c.start + c.duration) return false
  }
  return true
}

/**
 * Place a non-main clip at its `start`: on `preferred` when that slot is free, otherwise on
 * the first other unlocked track of the same kind with room, otherwise on a new track
 * created directly above `preferred` (CapCut-style auto layering). Returns the track used.
 */
export function placeClip(p: Project, preferred: Track, clip: Clip): Track {
  const end = clip.start + clip.duration
  let target: Track | undefined
  if (!preferred.locked && isFree(preferred, clip.start, end)) target = preferred
  else {
    target = p.tracks.find(
      (t) =>
        t !== preferred && t.kind === preferred.kind && !t.locked && isFree(t, clip.start, end),
    )
  }
  target ??= addTrack(p, preferred.kind, { index: p.tracks.indexOf(preferred) + 1 })
  target.clips.push(clip)
  sortTrack(target)
  return target
}

/** First unlocked track of `kind`, creating one when none exists. */
export function defaultTrack(p: Project, kind: Exclude<TrackKind, 'main'>): Track {
  return p.tracks.find((t) => t.kind === kind && !t.locked) ?? addTrack(p, kind)
}

/** Keep non-main track clips sorted by start (stable). */
export function sortTrack(track: Track): void {
  if (track.kind === 'main') return
  for (let i = 1; i < track.clips.length; i++) {
    if (track.clips[i - 1]!.start > track.clips[i]!.start) {
      track.clips.sort((a, b) => a.start - b.start)
      return
    }
  }
}
