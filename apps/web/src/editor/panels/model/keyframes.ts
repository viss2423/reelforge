/**
 * Keyframe editing for animatable transform properties (CapCut semantics):
 * - a property without keyframes is a constant: editing sets `value`;
 * - once it has keyframes, editing at the playhead updates the keyframe there or adds one;
 * - the diamond toggles a keyframe at the playhead (adding it with the current value).
 * Keyframe times are clip-relative, snapped to the frame grid, sorted and unique.
 */
import { evaluate, snapToFrame, type Animatable, type Easing, type Us } from '@reelforge/core'
import { clamp } from './draft.ts'

export const ANIMATABLE_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity'] as const
export type AnimatableProp = (typeof ANIMATABLE_PROPS)[number]

/** Easing for keyframes created in the UI (how the value arrives at the keyframe). */
export const DEFAULT_KEYFRAME_EASING: Easing = 'easeInOut'

/** Clip-relative keyframe time for a playhead position, clamped into the clip and frame-snapped. */
export const keyframeTime = (clip: { start: Us; duration: Us }, playhead: Us, fps: number): Us =>
  clamp(snapToFrame(playhead - clip.start, fps), 0, clip.duration)

/** Index of the keyframe within half a frame of `t`, or -1. */
export const keyframeIndexAt = (a: Animatable, t: Us, fps: number): number => {
  const tol = 500_000 / fps
  return a.keyframes.findIndex((k) => Math.abs(k.t - t) < tol)
}

export const hasKeyframeAt = (a: Animatable, t: Us, fps: number): boolean =>
  keyframeIndexAt(a, t, fps) !== -1

/** Current value of the property at clip time `t`. */
export const valueAt = (a: Animatable, t: Us): number =>
  a.keyframes.length === 0 ? a.value : evaluate(a, t)

const insertKeyframe = (a: Animatable, t: Us, value: number): void => {
  let i = a.keyframes.findIndex((k) => k.t > t)
  if (i === -1) i = a.keyframes.length
  a.keyframes.splice(i, 0, { t, value, easing: DEFAULT_KEYFRAME_EASING })
}

/** Sets the property at clip time `t` (mutates; call on a draft). */
export const setAnimatable = (a: Animatable, t: Us, value: number, fps: number): void => {
  if (a.keyframes.length === 0) {
    a.value = value
    return
  }
  const i = keyframeIndexAt(a, t, fps)
  if (i === -1) insertKeyframe(a, t, value)
  else a.keyframes[i]!.value = value
}

/**
 * Adds a keyframe at `t` holding the current value, or removes the one there. Removing the
 * last keyframe keeps its value as the constant so the property doesn't jump.
 */
export const toggleKeyframe = (a: Animatable, t: Us, fps: number): void => {
  const i = keyframeIndexAt(a, t, fps)
  if (i === -1) {
    insertKeyframe(a, t, valueAt(a, t))
    return
  }
  const [removed] = a.keyframes.splice(i, 1)
  if (a.keyframes.length === 0 && removed) a.value = removed.value
}

/** Removes every keyframe, keeping the value currently shown at `t`. */
export const clearKeyframes = (a: Animatable, t: Us): void => {
  if (a.keyframes.length === 0) return
  a.value = valueAt(a, t)
  a.keyframes.length = 0
}
