/** React hooks shared by panels and the inspector. */
import type { Animatable, Clip } from '@reelforge/core'
import { usePacks } from '@/api/queries.ts'
import type { Packs } from '@/api/schemas.ts'
import { editorStore } from '@/state/editorStore.ts'
import { locateClip, useEditor } from '@/state/selectors.ts'
import { keyframeTime } from './model/keyframes.ts'

/** Synced trend packs (undefined while loading or when the host has none). */
export const usePacksData = (): Packs | undefined => usePacks().data

/** A clip by id, narrowed by a type guard. */
export const useClipAs = <C extends Clip>(
  clipId: string | undefined,
  guard: (c: Clip | undefined) => c is C,
): C | undefined =>
  useEditor((s) => {
    const c = clipId ? locateClip(s.project, clipId)?.clip : undefined
    return guard(c) ? c : undefined
  })

/**
 * Clip-relative, frame-snapped playhead time for keyframe editing. Re-renders at most once
 * per frame, and only while `animated` (a constant property has nothing to follow), so a
 * section full of controls doesn't re-render at display rate during playback.
 */
export const useKeyframeTime = (clip: Clip, animated: boolean): number =>
  useEditor((s) => (animated ? keyframeTime(clip, s.playhead, s.project?.settings.fps ?? 30) : 0))

/** Same as `useKeyframeTime`, read imperatively (event handlers). */
export const keyframeTimeNow = (clip: Clip): number => {
  const s = editorStore.getState()
  return keyframeTime(clip, s.playhead, s.project?.settings.fps ?? 30)
}

/** True when any of the animatables has keyframes. */
export const anyAnimated = (...a: Animatable[]): boolean => a.some((x) => x.keyframes.length > 0)
