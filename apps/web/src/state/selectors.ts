/**
 * React bindings for the editor store. Every hook subscribes to the smallest slice it
 * needs; because the project is structurally shared, `useClip(id)` re-renders only when
 * that clip object changes, not when a sibling clip or the playhead moves.
 */
import type { Asset, Clip, Project, Track, Us } from '@reelforge/core'
import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import {
  editorStore,
  type EditorStore,
  type HistoryFlags,
  type Selection,
  type SyncInfo,
} from './editorStore.ts'

/** Subscribe to any derived value of the editor store (compared with Object.is). */
export const useEditor = <T>(selector: (s: EditorStore) => T): T => useStore(editorStore, selector)

/** Like `useEditor` but compares arrays/objects shallowly (for selectors that build new ones). */
export const useEditorShallow = <T>(selector: (s: EditorStore) => T): T =>
  useStore(editorStore, useShallow(selector))

const EMPTY_TRACKS: readonly Track[] = []

/** Location of a clip inside the project. */
export interface ClipLocation {
  track: Track
  clip: Clip
  trackIndex: number
  index: number
}

const clipIndexCache = new WeakMap<Project, Map<string, ClipLocation>>()

/**
 * O(1) clip lookup, built once per project version (WeakMap keyed by the immutable
 * project), so hundreds of clip components can each select their clip cheaply.
 */
export const clipIndex = (project: Project): Map<string, ClipLocation> => {
  let idx = clipIndexCache.get(project)
  if (!idx) {
    idx = new Map()
    for (let ti = 0; ti < project.tracks.length; ti++) {
      const track = project.tracks[ti]!
      for (let ci = 0; ci < track.clips.length; ci++) {
        const clip = track.clips[ci]!
        idx.set(clip.id, { track, clip, trackIndex: ti, index: ci })
      }
    }
    clipIndexCache.set(project, idx)
  }
  return idx
}

export const locateClip = (project: Project | null, clipId: string): ClipLocation | undefined =>
  project ? clipIndex(project).get(clipId) : undefined

const endCache = new WeakMap<Project, Us>()

/** End of the last clip on any track (timeline length). Cached per project version. */
export const timelineEnd = (project: Project | null): Us => {
  if (!project) return 0
  let end = endCache.get(project)
  if (end === undefined) {
    end = 0
    for (const t of project.tracks)
      for (const c of t.clips) end = Math.max(end, c.start + c.duration)
    endCache.set(project, end)
  }
  return end
}

/** Clips whose span contains `t` (start inclusive, end exclusive), top-most track last. */
export const clipsAt = (project: Project | null, t: Us): ClipLocation[] => {
  if (!project) return []
  const out: ClipLocation[] = []
  for (const loc of clipIndex(project).values()) {
    if (loc.clip.start <= t && t < loc.clip.start + loc.clip.duration) out.push(loc)
  }
  return out
}

export const mainTrackOf = (project: Project | null): Track | undefined =>
  project?.tracks.find((t) => t.kind === 'main')

/* ------------------------------------------------------------------ hooks */

export const useProject = (): Project | null => useEditor((s) => s.project)
export const useProjectId = (): string | null => useEditor((s) => s.project?.id ?? null)
export const useProjectName = (): string => useEditor((s) => s.project?.name ?? '')
/** Project frame rate (30 while no project is loaded). */
export const useFps = (): Project['settings']['fps'] =>
  useEditor((s) => s.project?.settings.fps ?? 30)
export const useTracks = (): readonly Track[] => useEditor((s) => s.project?.tracks ?? EMPTY_TRACKS)
export const useTrackIds = (): string[] =>
  useEditorShallow((s) => (s.project?.tracks ?? EMPTY_TRACKS).map((t) => t.id))
export const useTrack = (trackId: string): Track | undefined =>
  useEditor((s) => s.project?.tracks.find((t) => t.id === trackId))
export const useClip = (clipId: string): Clip | undefined =>
  useEditor((s) => locateClip(s.project, clipId)?.clip)
export const useDuration = (): Us => useEditor((s) => timelineEnd(s.project))

export const useSelection = (): Selection => useEditor((s) => s.selection)
export const useIsSelected = (clipId: string): boolean =>
  useEditor((s) => s.selection.clipIds.includes(clipId))
/** The single selected clip, if exactly one is selected. */
export const useSelectedClip = (): Clip | undefined =>
  useEditor((s) =>
    s.selection.clipIds.length === 1
      ? locateClip(s.project, s.selection.clipIds[0]!)?.clip
      : undefined,
  )

export const usePlayhead = (): Us => useEditor((s) => s.playhead)
export const usePlaying = (): boolean => useEditor((s) => s.playing)
export const useZoom = (): number => useEditor((s) => s.zoom)
export const useActivePanel = (): string | null => useEditor((s) => s.activePanel)
export const useActiveTool = (): string | null => useEditor((s) => s.activeTool)
export const useHistoryFlags = (): HistoryFlags => useEditor((s) => s.history)
export const useSyncInfo = (): SyncInfo => useEditor((s) => s.sync)
export const useInTransaction = (): boolean => useEditor((s) => s.transaction !== null)
export const useAsset = (assetId: string | undefined): Asset | undefined =>
  useEditor((s) => (assetId ? s.assets[assetId] : undefined))
export const useAssetsMap = (): Readonly<Record<string, Asset>> => useEditor((s) => s.assets)
