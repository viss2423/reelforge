/**
 * Clip slicing, extension and re-timing primitives shared by split/trim/remove/speed ops.
 * All times here are CLIP-RELATIVE µs (0 = the clip's first frame).
 */
import { evaluateKeyframes } from '../animation.ts'
import type { Clip, EffectRef, Keyframe, Transform, Us } from '../schema.ts'
import { newId } from '../ids.ts'
import { clone } from './errors.ts'
import { speedProfile, type TimedClip } from './timemap.ts'

const TRANSFORM_KEYS = ['x', 'y', 'scale', 'rotation', 'opacity'] as const

/**
 * Keyframes of the window [a, b] re-based to start at 0. Keyframes inside the window are
 * kept; an interpolated keyframe is inserted at the cut on each side so the animation stays
 * continuous across a split. With `exactTail` the first keyframe past `b` is kept verbatim
 * instead (keyframes may extend beyond a clip), which keeps the curve shape — and therefore
 * a speed ramp's source integral — exact for the window.
 */
export function sliceKeyframes(
  keyframes: readonly Keyframe[],
  a: Us,
  b: Us,
  exactTail = false,
): Keyframe[] {
  const n = keyframes.length
  if (n === 0) return []
  const out: Keyframe[] = []
  if (a > keyframes[0]!.t && !keyframes.some((k) => k.t === a)) {
    out.push({ t: 0, value: evaluateKeyframes(keyframes, a, 0), easing: 'linear' })
  }
  for (const k of keyframes) {
    if (k.t < a) continue
    if (k.t <= b) {
      out.push({ ...k, t: k.t - a })
      continue
    }
    if (exactTail) out.push({ ...k, t: k.t - a })
    else if (out[out.length - 1]?.t !== b - a) {
      out.push({ t: b - a, value: evaluateKeyframes(keyframes, b, 0), easing: k.easing })
    }
    break
  }
  return out
}

/** Shift keyframe times by `delta` (dropping keyframes that would become negative). */
export const shiftKeyframes = (keyframes: readonly Keyframe[], delta: number): Keyframe[] =>
  keyframes.filter((k) => k.t + delta >= 0).map((k) => ({ ...k, t: k.t + delta }))

/** Scale keyframe times by `factor`, keeping times integral and unique (last wins). */
export function scaleKeyframes(keyframes: readonly Keyframe[], factor: number): Keyframe[] {
  const out: Keyframe[] = []
  for (const k of keyframes) {
    const t = Math.round(k.t * factor)
    if (out.length > 0 && out[out.length - 1]!.t === t) out[out.length - 1] = { ...k, t }
    else out.push({ ...k, t })
  }
  return out
}

/** Apply a keyframe transformation to every animatable of a transform. */
export function mapTransformKeyframes(
  transform: Transform,
  fn: (k: readonly Keyframe[]) => Keyframe[],
): void {
  for (const key of TRANSFORM_KEYS) {
    const a = transform[key]
    if (a.keyframes.length > 0) a.keyframes = fn(a.keyframes)
  }
}

/** Effect windows intersected with [a, b], re-based to a. Whole-clip effects stay whole. */
export function sliceEffects(
  effects: readonly EffectRef[],
  clipDuration: Us,
  a: Us,
  b: Us,
  freshIds: boolean,
): EffectRef[] {
  const out: EffectRef[] = []
  for (const e of effects) {
    const end = e.duration === undefined ? clipDuration : e.start + e.duration
    const s = Math.max(e.start, a)
    const t = Math.min(end, b)
    if (t <= s) continue
    const next: EffectRef = { ...e, id: freshIds ? newId('e_') : e.id, start: s - a }
    // An open-ended effect runs to the clip end, and every piece ends at or before it.
    if (e.duration !== undefined) next.duration = t - s
    out.push(next)
  }
  return out
}

export interface SliceOptions {
  /** Keep the original clip id (otherwise a fresh id is generated). */
  keepId: boolean
  /** This piece keeps the clip's head attributes (transitionIn, animationIn, fadeIn). */
  head: boolean
  /** This piece keeps the clip's tail attributes (animationOut, fadeOut). */
  tail: boolean
}

/**
 * A new clip showing the clip-time window [a, b] of `clip` with an exact source mapping
 * (in-point, speed, reverse and speed ramp). `start` is set to clip.start + a; main-track
 * callers renormalise afterwards. When the window starts inside a curved speed-ramp segment
 * the re-based ramp is continuous but not identical in shape; the piece's duration is then
 * re-solved so that it covers exactly the same source frames as the window did.
 */
export function subClip<C extends Clip>(clip: C, a: Us, b: Us, opts: SliceOptions): C {
  const c = clone(clip)
  c.id = opts.keepId ? clip.id : newId('c_')
  c.start = clip.start + a
  c.duration = b - a

  if (c.type !== 'audio') mapTransformKeyframes(c.transform, (k) => sliceKeyframes(k, a, b))

  switch (c.type) {
    case 'video':
    case 'image':
    case 'audio': {
      const src = clip as TimedClip
      const profile = speedProfile(src)
      const oA = profile.offsetAt(a)
      const oB = profile.offsetAt(b)
      if (c.type !== 'image') {
        // A reversed clip plays its source backwards, so the window's source START is the
        // source position shown at clip time b.
        const reversed = c.type === 'video' && c.reverse
        c.in = src.in + Math.round(reversed ? profile.offsetAt(clip.duration) - oB : oA)
      }
      if (c.type === 'video' && c.speedRamp.length > 0) {
        c.speedRamp = sliceKeyframes(c.speedRamp, a, b, true)
        const piece = speedProfile(c)
        const target = oB - oA
        if (Math.abs(piece.offsetAt(c.duration) - target) > 0.5) {
          c.duration = Math.max(1, Math.round(piece.timeAt(target)))
        }
      }
      if (c.type !== 'audio') {
        c.effects = sliceEffects(c.effects, clip.duration, a, b, !opts.keepId)
        if (!opts.head) delete c.transitionIn
      }
      if (!opts.head) c.audio.fadeIn = 0
      if (!opts.tail) c.audio.fadeOut = 0
      c.audio.fadeIn = Math.min(c.audio.fadeIn, c.duration)
      c.audio.fadeOut = Math.min(c.audio.fadeOut, c.duration)
      break
    }
    case 'text':
    case 'sticker':
      if (!opts.head) delete c.animationIn
      if (!opts.tail) delete c.animationOut
      break
  }
  return c
}

/**
 * Overwrite `target` with the contents of `source` in place (keys missing from `source` are
 * deleted). Ops use it so a re-sliced clip keeps its object identity for callers holding a
 * reference; it works the same on plain objects and Immer drafts.
 */
export function assignClip<C extends Clip>(target: C, source: C): C {
  const t = target as Record<string, unknown>
  for (const key of Object.keys(t)) if (!(key in source)) delete t[key]
  return Object.assign(target, source)
}

/** In-place variant of subClip that keeps the clip's id and object identity. */
export const sliceInPlace = <C extends Clip>(clip: C, a: Us, b: Us, head = true, tail = true): C =>
  assignClip(clip, subClip(clip, a, b, { keepId: true, head, tail }))

/**
 * Shift everything anchored to clip time by `delta` µs (used when extending a clip's head):
 * transform keyframes, speed ramp and windowed effects move with the content.
 */
export function shiftClipContent(clip: Clip, delta: number): void {
  if (clip.type === 'audio') return
  mapTransformKeyframes(clip.transform, (k) => shiftKeyframes(k, delta))
  if (clip.type === 'video' || clip.type === 'image') {
    clip.speedRamp = shiftKeyframes(clip.speedRamp, delta)
    for (const e of clip.effects) {
      if (e.start === 0 && e.duration === undefined) continue
      e.start = Math.max(0, e.start + delta)
    }
  }
}

/** Scale everything anchored to clip time by `factor` (used by speed changes). */
export function scaleClipContent(clip: Clip, factor: number): void {
  if (clip.type === 'audio') return
  mapTransformKeyframes(clip.transform, (k) => scaleKeyframes(k, factor))
  if (clip.type === 'video' || clip.type === 'image') {
    clip.speedRamp = scaleKeyframes(clip.speedRamp, factor)
    for (const e of clip.effects) {
      e.start = Math.round(e.start * factor)
      if (e.duration !== undefined) e.duration = Math.max(1, Math.round(e.duration * factor))
    }
  }
}
