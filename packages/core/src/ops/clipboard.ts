/**
 * Multi-clip operations: copy/paste across tracks and atomic group moves.
 *
 * A clipboard is plain JSON (it can be stored and pasted into another project): deep copies
 * of the clips with their track and their offset from the earliest copied clip, in playback
 * time. Pasting gives every clip (and effect) a fresh id, keeps the relative timing and
 * track layering, inserts main-track clips at the main boundary nearest the paste time (the
 * magnetic track has no free positions) and lands the others on their original track when
 * it still exists and has room, otherwise on another or a new track of the same kind.
 */
import type { Clip, Project, Track, TrackKind, Us } from '../schema.ts'
import { newId } from '../ids.ts'
import { OpError, clone } from './errors.ts'
import {
  assertUnlocked,
  defaultTrack,
  getClip,
  getTrack,
  isMediaClip,
  kindForClip,
  mainTrack,
  mainTrackLayout,
  placeClip,
  pruneEmptyTracks,
  trackAccepts,
} from './project.ts'
import { editMain, mainIndexAt } from './main.ts'

export interface ClipboardEntry {
  clip: Clip
  /** Track the clip was copied from (pasting prefers it). */
  trackId: string
  trackKind: TrackKind
  /** Playback start relative to the earliest copied clip. */
  offset: Us
}

export interface ClipboardData {
  version: 1
  entries: ClipboardEntry[]
  /** Playback span of the copied clips (latest end − earliest start). */
  duration: Us
}

/** Deep-copies clips (by id, any tracks) into clipboard data. Does not modify the project. */
export function copyClips(p: Project, clipIds: readonly string[]): ClipboardData {
  const ids = new Set(clipIds)
  const layout = new Map(mainTrackLayout(p).map((e) => [e.clip.id, e.start]))
  const found: Array<{ clip: Clip; track: Track; start: Us; order: number }> = []
  p.tracks.forEach((track, ti) => {
    track.clips.forEach((clip, ci) => {
      if (!ids.has(clip.id)) return
      const start = track.kind === 'main' ? (layout.get(clip.id) ?? clip.start) : clip.start
      found.push({ clip, track, start, order: ti * 1e6 + ci })
    })
  })
  if (found.length === 0) return { version: 1, entries: [], duration: 0 }
  const origin = Math.min(...found.map((f) => f.start))
  const end = Math.max(...found.map((f) => f.start + f.clip.duration))
  found.sort((a, b) => a.order - b.order)
  return {
    version: 1,
    entries: found.map((f) => ({
      clip: clone(f.clip),
      trackId: f.track.id,
      trackKind: f.track.kind,
      offset: f.start - origin,
    })),
    duration: end - origin,
  }
}

/** A copy of a clip with fresh clip and effect ids. */
function freshCopy(c: Clip): Clip {
  const copy = clone(c)
  copy.id = newId('c_')
  if (copy.type === 'video' || copy.type === 'image') {
    copy.effects = copy.effects.map((e) => ({ ...e, id: newId('e_') }))
  }
  return copy
}

/** Track for a pasted non-main clip: its original track when usable, else the default one. */
function pasteTrack(p: Project, entry: ClipboardEntry, clip: Clip): Track {
  const original = p.tracks.find((t) => t.id === entry.trackId)
  if (original && original.kind !== 'main' && trackAccepts(original.kind, clip.type)) {
    return original
  }
  return defaultTrack(p, kindForClip(clip.type))
}

/**
 * Pastes clipboard data with its earliest clip at playback time `at`. Returns the new clips
 * (main-track ones first, in order). Throws `track_locked` when the main track is locked and
 * main clips are pasted; locked free tracks are skipped by placement.
 */
export function pasteClips(p: Project, data: ClipboardData, opts: { at: Us }): Clip[] {
  if (data.entries.length === 0) return []
  const at = Math.max(0, Math.round(opts.at))
  const mainEntries = data.entries.filter((e) => e.trackKind === 'main' && isMediaClip(e.clip))
  const others = data.entries.filter((e) => !mainEntries.includes(e))
  const out: Clip[] = []
  if (mainEntries.length > 0) {
    const main = mainTrack(p)
    assertUnlocked(main)
    const index = mainIndexAt(p, at)
    const copies = mainEntries.map((e) => freshCopy(e.clip))
    editMain(p, () => main.clips.splice(index, 0, ...copies))
    // Read back the draft objects (the spliced copies are proxied once inserted).
    out.push(...main.clips.slice(index, index + copies.length))
  }
  for (const entry of others) {
    const copy = freshCopy(entry.clip)
    if (copy.type === 'video' || copy.type === 'image') delete copy.transitionIn
    copy.start = at + entry.offset
    const track = placeClip(p, pasteTrack(p, entry, copy), copy)
    out.push(track.clips.find((c) => c.id === copy.id)!)
  }
  return out
}

/** One clip of a group move: target playback start and (optionally) a new track. */
export interface ClipMove {
  clipId: string
  start: Us
  trackId?: string
}

/**
 * Moves several non-main clips at once: every clip is lifted first and then placed, so
 * clips of the group never collide with each other's old positions. A clip whose target
 * slot is taken lands on another (or a new) track of the same kind.
 */
export function moveClips(p: Project, moves: readonly ClipMove[]): void {
  const lifted: Array<{ clip: Clip; target: Track; start: Us }> = []
  for (const m of moves) {
    const { track, clip } = getClip(p, m.clipId)
    if (track.kind === 'main') {
      throw new OpError('main_track', 'main-track clips move with moveClip (magnetic reorder)')
    }
    assertUnlocked(track)
    const target = m.trackId !== undefined ? getTrack(p, m.trackId) : track
    assertUnlocked(target)
    if (target.kind === 'main' || !trackAccepts(target.kind, clip.type)) {
      throw new OpError('track_kind', `a ${clip.type} clip cannot go on a ${target.kind} track`)
    }
    lifted.push({ clip, target, start: Math.max(0, Math.round(m.start)) })
  }
  for (const l of lifted) {
    const track = getClip(p, l.clip.id).track
    track.clips = track.clips.filter((c) => c.id !== l.clip.id)
  }
  lifted.sort((a, b) => a.start - b.start)
  for (const l of lifted) {
    const clip = clone(l.clip)
    clip.start = l.start
    placeClip(p, l.target, clip)
  }
  pruneEmptyTracks(p)
}
