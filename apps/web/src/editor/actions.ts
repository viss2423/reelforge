/**
 * Editor commands shared by keyboard shortcuts, the media library, the tool bar and the
 * timeline. Each command reads the store, runs core ops through `dispatch` (one undo step)
 * and returns a result instead of throwing, so callers can show a toast on failure.
 */
import {
  OpError,
  deleteClips,
  duplicateClip,
  fromFrame,
  insertAudioClip,
  insertMediaClip,
  splitClip,
  toFrame,
  type Asset,
  type Clip,
  type Project,
  type Us,
} from '@reelforge/core'
import { mainTrackOf, timelineEnd } from '@/state/selectors.ts'
import type { EditorStoreApi } from '@/state/editorStore.ts'

export type CommandResult = { ok: true } | { ok: false; reason: string }

const OK: CommandResult = { ok: true }
const fail = (reason: string): CommandResult => ({ ok: false, reason })

/** Converts an op failure into a user-facing reason. */
const describe = (err: unknown): string =>
  err instanceof OpError
    ? err.code === 'not_implemented'
      ? 'This edit is not available yet'
      : err.message
    : err instanceof Error
      ? err.message
      : String(err)

const run = (fn: () => void): CommandResult => {
  try {
    fn()
    return OK
  } catch (err) {
    return fail(describe(err))
  }
}

const draftEnd = (p: Project): Us => {
  let end = 0
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.duration)
  return end
}

/** True once the host has probed the asset enough to place it on a timeline. */
export const isAssetPlaceable = (a: Asset): boolean =>
  a.kind === 'image' || (a.duration !== undefined && a.duration > 0)

/**
 * Main-track insertion index for the playhead: before the clip that starts at/after it, or
 * right after the clip it is inside (CapCut behaviour — never splits silently).
 */
export const mainInsertIndex = (project: Project, playhead: Us): number => {
  const clips = mainTrackOf(project)?.clips ?? []
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]!
    if (c.start >= playhead) return i
    if (playhead < c.start + c.duration) return i + 1
  }
  return clips.length
}

export interface AddAssetOptions {
  /** 'playhead' (default) inserts at the playhead; 'end' appends (imports). */
  position?: 'playhead' | 'end'
  /** Explicit track (e.g. a drop target); otherwise main for visuals, audio track for audio. */
  trackId?: string
  at?: Us
}

/** Places an asset on the timeline: visuals on the main track, audio on an audio track. */
export const addAssetToTimeline = (
  store: EditorStoreApi,
  asset: Asset,
  opts: AddAssetOptions = {},
): CommandResult & { clipId?: string } => {
  const { project, playhead } = store.getState()
  if (!project) return fail('No project open')
  if (!isAssetPlaceable(asset)) return fail(`${asset.name} is still being processed`)
  const end = opts.position === 'end'
  try {
    const clip = store.getState().dispatch(`Add ${asset.kind}`, (d) => {
      if (asset.kind === 'audio') {
        return insertAudioClip(d, {
          asset,
          // Computed on the draft directly: the cached selector is keyed by frozen projects.
          at: opts.at ?? (end ? draftEnd(d) : playhead),
          ...(opts.trackId ? { trackId: opts.trackId } : {}),
        })
      }
      const main = mainTrackOf(d)
      const trackId = opts.trackId ?? main?.id
      if (!trackId) throw new OpError('no_main_track', 'Project has no main track')
      const onMain = trackId === main?.id
      return insertMediaClip(d, {
        trackId,
        asset,
        ...(onMain
          ? { index: end ? (main?.clips.length ?? 0) : mainInsertIndex(d, playhead) }
          : { at: opts.at ?? playhead }),
      })
    }) as Clip
    store.getState().select([clip.id])
    return { ok: true, clipId: clip.id }
  } catch (err) {
    return fail(describe(err))
  }
}

/** Ids to act on: the selection, or else the main-track clip under the playhead. */
const targetsAtPlayhead = (store: EditorStoreApi): string[] => {
  const { project, playhead, selection } = store.getState()
  if (!project) return []
  const hit = (c: Clip) => c.start < playhead && playhead < c.start + c.duration
  const all = project.tracks.flatMap((t) => t.clips)
  const selected = all.filter((c) => selection.clipIds.includes(c.id) && hit(c))
  if (selected.length) return selected.map((c) => c.id)
  const main = mainTrackOf(project)?.clips.find(hit)
  return main ? [main.id] : []
}

/** Splits the selected clips (or the main clip) at the playhead. */
export const splitAtPlayhead = (store: EditorStoreApi): CommandResult => {
  const ids = targetsAtPlayhead(store)
  if (!ids.length) return fail('Move the playhead over a clip to split it')
  const t = store.getState().playhead
  return run(() =>
    store.getState().dispatch('Split', (d) => {
      for (const id of ids) splitClip(d, id, t)
    }),
  )
}

/** Deletes the selected clips. Main-track gaps always close (magnetic). */
export const deleteSelection = (store: EditorStoreApi, ripple = false): CommandResult => {
  const ids = store.getState().selection.clipIds
  if (!ids.length) return fail('Nothing selected')
  const r = run(() =>
    store
      .getState()
      .dispatch(ids.length > 1 ? `Delete ${ids.length} clips` : 'Delete clip', (d) =>
        deleteClips(d, ids, { ripple }),
      ),
  )
  if (r.ok) store.getState().clearSelection()
  return r
}

/** Duplicates the selected clips; the copies become the selection. */
export const duplicateSelection = (store: EditorStoreApi): CommandResult => {
  const ids = store.getState().selection.clipIds
  if (!ids.length) return fail('Nothing selected')
  try {
    const copies = store
      .getState()
      .dispatch('Duplicate', (d) => ids.map((id) => duplicateClip(d, id).id))
    store.getState().select(copies)
    return OK
  } catch (err) {
    return fail(describe(err))
  }
}

/** Moves the playhead by whole frames, snapping to the frame grid. Clamped to the timeline. */
export const stepFrames = (store: EditorStoreApi, frames: number): void => {
  const { project, playhead } = store.getState()
  if (!project) return
  const fps = project.settings.fps
  const end = timelineEnd(project)
  const t = fromFrame(toFrame(playhead, fps) + frames, fps)
  store.getState().setPlaying(false)
  store.getState().setPlayhead(Math.min(end, Math.max(0, t)))
}

/** Moves the playhead by a time delta (us), clamped to the timeline. */
export const seekBy = (store: EditorStoreApi, delta: Us): void => {
  const { project, playhead } = store.getState()
  if (!project) return
  store.getState().setPlayhead(Math.min(timelineEnd(project), Math.max(0, playhead + delta)))
}
