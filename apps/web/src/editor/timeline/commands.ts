/**
 * Timeline edit commands that are not pointer drags: keyboard nudges, track header
 * toggles, adding tracks, dropping library assets and opening the transition tool. Each
 * runs as one `dispatch` (one undo step) and reports failures with a toast.
 */
import {
  OpError,
  addTrack,
  fromFrame,
  insertMediaClip,
  moveClip,
  snapToFrame,
  toFrame,
  type Asset,
  type Project,
  type TrackKind,
} from '@reelforge/core'
import type { Draft } from 'immer'
import { toast } from '@/components/Toast.tsx'
import { addAssetToTimeline, isAssetPlaceable } from '@/editor/actions.ts'
import { locateClip, mainTrackOf, type EditorStoreApi } from '@/state/index.ts'
import { reorderIndex } from './dragMath.ts'
import { trackSpans } from './geometry.ts'

/** `activeTool` id that opens the Transitions panel (owned by the tools panels). */
export const TRANSITIONS_TOOL = 'transitions'

/** User-facing reason for a failed edit. */
export const editFailure = (err: unknown): string =>
  err instanceof OpError
    ? err.code === 'not_implemented'
      ? 'This edit is not available yet'
      : err.message
    : err instanceof Error
      ? err.message
      : String(err)

/**
 * Runs one undoable edit. Returns false (after a toast) if the op rejected it; the project
 * is untouched in that case.
 */
export const runEdit = (
  store: EditorStoreApi,
  label: string,
  recipe: (d: Draft<Project>) => void,
  coalesce?: string,
): boolean => {
  try {
    store.getState().dispatch(label, recipe, coalesce ? { coalesce } : undefined)
    return true
  } catch (err) {
    toast(editFailure(err), { tone: 'error' })
    return false
  }
}

/** Whether a track of `kind` accepts a clip of `type` (core's rule). */
export { trackAccepts } from '@reelforge/core'

/**
 * Keyboard nudge. Free tracks move by `frames` frames (frame-accurate); the magnetic main
 * track has no free position, so a nudge there moves the clip one slot left/right.
 */
export const nudgeClip = (store: EditorStoreApi, clipId: string, frames: number): boolean => {
  const { project } = store.getState()
  const loc = locateClip(project, clipId)
  if (!project || !loc || frames === 0) return false
  if (loc.track.locked) {
    toast('Track is locked')
    return false
  }
  if (loc.track.kind === 'main') {
    const index = loc.index + Math.sign(frames)
    if (index < 0 || index >= loc.track.clips.length) return false
    return runEdit(store, 'Move clip', (d) => moveClip(d, clipId, { index }), `nudge:${clipId}`)
  }
  const fps = project.settings.fps
  const start = Math.max(0, fromFrame(toFrame(loc.clip.start, fps) + frames, fps))
  if (start === loc.clip.start) return false
  return runEdit(store, 'Nudge clip', (d) => moveClip(d, clipId, { start }), `nudge:${clipId}`)
}

export type TrackFlag = 'muted' | 'hidden' | 'locked'

const FLAG_LABEL: Record<TrackFlag, [string, string]> = {
  muted: ['Mute track', 'Unmute track'],
  hidden: ['Hide track', 'Show track'],
  locked: ['Lock track', 'Unlock track'],
}

/** Toggles a track's mute/hide/lock flag. */
export const toggleTrackFlag = (store: EditorStoreApi, trackId: string, flag: TrackFlag): void => {
  const track = store.getState().project?.tracks.find((t) => t.id === trackId)
  if (!track) return
  const on = !track[flag]
  runEdit(store, FLAG_LABEL[flag][on ? 0 : 1], (d) => {
    const t = d.tracks.find((x) => x.id === trackId)
    if (t) t[flag] = on
  })
}

/** Shows/hides the burned-in captions. */
export const toggleCaptions = (store: EditorStoreApi): void => {
  const enabled = store.getState().project?.captions?.enabled
  if (enabled === undefined) return
  runEdit(store, enabled ? 'Hide captions' : 'Show captions', (d) => {
    if (d.captions) d.captions.enabled = !enabled
  })
}

/** Adds an empty track of `kind` (above the others of its group). */
export const addTrackOfKind = (store: EditorStoreApi, kind: Exclude<TrackKind, 'main'>): void => {
  runEdit(store, `Add ${kind} track`, (d) => {
    addTrack(d, kind)
  })
}

/**
 * Drops a library asset at time `t` on `trackId`. Main-track drops insert at the nearest
 * clip boundary (magnetic); other tracks place it at the frame-snapped drop time.
 */
export const dropAsset = (
  store: EditorStoreApi,
  asset: Asset,
  trackId: string | undefined,
  t: number,
): void => {
  const { project } = store.getState()
  if (!project) return
  const fps = project.settings.fps
  const main = mainTrackOf(project)
  const at = snapToFrame(Math.max(0, t), fps)
  if (asset.kind !== 'audio' && main && (trackId === undefined || trackId === main.id)) {
    if (!isAssetPlaceable(asset)) {
      toast(`${asset.name} is still being processed`)
      return
    }
    const index = reorderIndex(
      main.clips.map((c) => c.duration),
      -1,
      at,
    )
    try {
      const clip = store
        .getState()
        .dispatch(`Add ${asset.kind}`, (d) =>
          insertMediaClip(d, { trackId: main.id, asset, index }),
        )
      store.getState().select([clip.id], { trackId: main.id })
    } catch (err) {
      toast(editFailure(err), { tone: 'error' })
    }
    return
  }
  const r = addAssetToTimeline(store, asset, { ...(trackId ? { trackId } : {}), at })
  if (!r.ok) toast(r.reason)
}

/** Opens the Transitions tool for the transition INTO main-track clip `clipId`. */
export const openTransition = (store: EditorStoreApi, clipId: string, trackId: string): void => {
  const s = store.getState()
  s.select([clipId], { trackId })
  s.setActiveTool(TRANSITIONS_TOOL)
}

/** Playback span of a clip (main track overlap-aware). */
export const clipSpan = (
  project: Project,
  clipId: string,
): { start: number; end: number } | null => {
  const loc = locateClip(project, clipId)
  if (!loc) return null
  const s = trackSpans(loc.track)
  return { start: s.starts[loc.index]!, end: s.ends[loc.index]! }
}
