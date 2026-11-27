/**
 * Draft recipes for clip and project properties. Each function mutates a project draft
 * (call it inside `dispatch`/`edit`) and never performs I/O. Property edits are plain
 * assignments on the model; anything that changes timing or structure delegates to core
 * ops so timeline invariants stay owned by core.
 */
import {
  addTrack,
  insertStickerClip,
  insertTextClip,
  moveClip,
  newId,
  normalizeMainTrack,
  OpError,
  setClipSpeed,
  trimClip,
  type Adjustments,
  type Asset,
  type AudioClip,
  type AudioProps,
  type ChromaKey,
  type ClipBackground,
  type Clip,
  type Crop,
  type EffectRef,
  type MediaClip,
  type Project,
  type TextAnimation,
  type TextClip,
  type TextPreset,
  type StickerClip,
  type TextStyle,
  type Track,
  type TransitionType,
  type Us,
} from '@reelforge/core'
import {
  clamp,
  clipOf,
  hasAudio,
  isAudioClip,
  isMedia,
  isSticker,
  isText,
  isVideo,
  isVisual,
  locate,
  mainOf,
  type TimedClip,
} from './draft.ts'
import { ANIMATABLE_PROPS, setAnimatable, toggleKeyframe, hasKeyframeAt } from './keyframes.ts'
import type { AnimatableProp } from './keyframes.ts'
import { curveRamp, SPEED_CURVES, type CurveId } from './speed.ts'
import type { AnimationSlot } from './catalog.ts'

const need = <C>(c: C | undefined, clipId: string, what: string): C => {
  if (c === undefined) throw new OpError('not_found', `No ${what} clip ${clipId}`)
  return c
}

/* ------------------------------------------------------------------ defaults */

export const NEUTRAL_ADJUSTMENTS: Readonly<Adjustments> = Object.freeze({
  brightness: 0,
  contrast: 0,
  saturation: 0,
  exposure: 0,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  vibrance: 0,
  sharpen: 0,
  vignette: 0,
  grain: 0,
  blur: 0,
})

/** Schema defaults of a transform (canvas centre, fit size, opaque). */
export const DEFAULT_TRANSFORM = Object.freeze({
  x: 540,
  y: 960,
  scale: 1,
  rotation: 0,
  opacity: 1,
})

export const NO_CROP: Readonly<Crop> = Object.freeze({ left: 0, top: 0, right: 0, bottom: 0 })

export const DEFAULT_CHROMA: Readonly<ChromaKey> = Object.freeze({
  enabled: true,
  color: '#00ff00',
  similarity: 0.3,
  blend: 0.1,
})

/** Transition overlap bounds from the schema. */
export const TRANSITION_MIN: Us = 50_000
export const TRANSITION_MAX: Us = 3_000_000

/* ------------------------------------------------------------------ audio */

/** Patches the audio block of video/audio clips. */
export const setAudio = (
  d: Project,
  clipIds: readonly string[],
  patch: Partial<AudioProps>,
): void => {
  for (const id of clipIds) {
    const c = need(clipOf(d, id, hasAudio), id, 'audio')
    const next = { ...c.audio, ...patch }
    // Fades can never exceed the clip itself.
    next.fadeIn = clamp(Math.round(next.fadeIn), 0, c.duration)
    next.fadeOut = clamp(Math.round(next.fadeOut), 0, c.duration)
    next.volume = clamp(next.volume, 0, 4)
    c.audio = next
  }
}

export const setAudioClipProps = (
  d: Project,
  clipId: string,
  patch: Partial<Pick<AudioClip, 'duckUnderVoice' | 'role'>>,
): void => {
  Object.assign(need(clipOf(d, clipId, isAudioClip), clipId, 'audio'), patch)
}

/* ------------------------------------------------------------------ speed */

/** Applies a speed-curve preset (or removes the ramp with 'none'). Duration is unchanged. */
export const setSpeedCurve = (d: Project, clipId: string, curve: CurveId | 'none'): void => {
  const c = need(clipOf(d, clipId, isVideo), clipId, 'video')
  if (curve === 'none') {
    c.speedRamp = []
    return
  }
  const def = SPEED_CURVES.find((x) => x.id === curve)
  if (!def) throw new OpError('invalid_curve', `Unknown speed curve ${curve}`)
  c.speedRamp = curveRamp(def, c.duration, c.speed)
}

/** Sets the constant speed through core (recomputes duration, ripples the main track). */
export const setSpeed = (d: Project, clipId: string, speed: number): void => {
  setClipSpeed(d, clipId, speed)
}

/* ------------------------------------------------------------------ look */

export const setAdjustment = (
  d: Project,
  clipIds: readonly string[],
  key: keyof Adjustments,
  value: number,
): void => {
  for (const id of clipIds) need(clipOf(d, id, isMedia), id, 'media').adjustments[key] = value
}

export const resetAdjustments = (d: Project, clipIds: readonly string[]): void => {
  for (const id of clipIds)
    need(clipOf(d, id, isMedia), id, 'media').adjustments = { ...NEUTRAL_ADJUSTMENTS }
}

/** Sets (or with `ref` undefined, removes) the LUT filter of media clips. */
export const setFilter = (
  d: Project,
  clipIds: readonly string[],
  ref: string | undefined,
  intensity = 1,
): void => {
  for (const id of clipIds) {
    const c = need(clipOf(d, id, isMedia), id, 'media')
    if (ref === undefined) delete c.filter
    else c.filter = { ref, intensity: clamp(intensity, 0, 1) }
  }
}

export const setFilterIntensity = (
  d: Project,
  clipIds: readonly string[],
  intensity: number,
): void => {
  for (const id of clipIds) {
    const f = need(clipOf(d, id, isMedia), id, 'media').filter
    if (f) f.intensity = clamp(intensity, 0, 1)
  }
}

/** Adds a pack effect over the whole clip (skipping clips that have it); returns new effect ids. */
export const addEffect = (
  d: Project,
  clipIds: readonly string[],
  ref: string,
  intensity = 1,
): string[] =>
  clipIds.flatMap((id) => {
    const c = need(clipOf(d, id, isMedia), id, 'media')
    // The same effect twice on one clip is never what anyone wants.
    if (c.effects.some((e) => e.ref === ref)) return []
    const fx: EffectRef = { id: newId('fx'), ref, start: 0, intensity }
    c.effects.push(fx)
    return [fx.id]
  })

export const removeEffect = (d: Project, clipId: string, effectId: string): void => {
  const c = need(clipOf(d, clipId, isMedia), clipId, 'media')
  c.effects = c.effects.filter((e) => e.id !== effectId)
}

/** Removes every effect with `ref` from the clips. */
export const removeEffectRef = (d: Project, clipIds: readonly string[], ref: string): void => {
  for (const id of clipIds) {
    const c = need(clipOf(d, id, isMedia), id, 'media')
    c.effects = c.effects.filter((e) => e.ref !== ref)
  }
}

/** Updates an effect; the window is clamped inside the clip. `duration: undefined` = to the end. */
export const updateEffect = (
  d: Project,
  clipId: string,
  effectId: string,
  patch: Partial<Pick<EffectRef, 'start' | 'duration' | 'intensity'>>,
): void => {
  const c = need(clipOf(d, clipId, isMedia), clipId, 'media')
  const fx = c.effects.find((e) => e.id === effectId)
  if (!fx) throw new OpError('not_found', `No effect ${effectId}`)
  if (patch.intensity !== undefined) fx.intensity = clamp(patch.intensity, 0, 1)
  if (patch.start !== undefined) fx.start = clamp(Math.round(patch.start), 0, c.duration - 1)
  if ('duration' in patch) {
    if (patch.duration === undefined) delete fx.duration
    else fx.duration = clamp(Math.round(patch.duration), 1, c.duration - fx.start)
  } else if (fx.duration !== undefined) {
    fx.duration = clamp(fx.duration, 1, c.duration - fx.start)
  }
}

export const setChroma = (d: Project, clipId: string, patch: Partial<ChromaKey>): void => {
  const c = need(clipOf(d, clipId, isMedia), clipId, 'media')
  c.chromaKey = { ...DEFAULT_CHROMA, ...c.chromaKey, ...patch }
}

/** Schema defaults of an AI background. */
export const DEFAULT_BACKGROUND: Readonly<ClipBackground> = Object.freeze({
  mode: 'keep',
  color: '#000000',
  blur: 50,
  feather: 0,
})

export const setBackground = (d: Project, clipId: string, patch: Partial<ClipBackground>): void => {
  const c = need(clipOf(d, clipId, isMedia), clipId, 'media')
  c.background = { ...DEFAULT_BACKGROUND, ...c.background, ...patch }
}

/* ------------------------------------------------------------------ transitions */

/** Longest allowed transition into main clip `index` (half of either neighbour). */
export const maxTransition = (main: Track, index: number): Us => {
  const prev = main.clips[index - 1]
  const cur = main.clips[index]
  if (!prev || !cur) return 0
  return Math.min(TRANSITION_MAX, Math.floor(Math.min(prev.duration, cur.duration) / 2))
}

const applyTransition = (main: Track, index: number, type: TransitionType, duration: Us) => {
  const c = main.clips[index]
  if (!isMedia(c)) return false
  const max = maxTransition(main, index)
  if (max < TRANSITION_MIN) return false
  c.transitionIn = { type, duration: clamp(Math.round(duration), TRANSITION_MIN, max) }
  return true
}

/**
 * Sets (or with `type` undefined, removes) the transition INTO a main-track clip. Returns
 * false when the clips are too short for any transition.
 */
export const setTransition = (
  d: Project,
  clipId: string,
  type: TransitionType | undefined,
  duration: Us,
): boolean => {
  const loc = locate(d, clipId)
  if (!loc || loc.track.kind !== 'main' || loc.index === 0)
    throw new OpError('no_boundary', 'Transitions go between two clips on the main track')
  if (type === undefined) {
    if (isMedia(loc.clip)) delete loc.clip.transitionIn
    normalizeMainTrack(d)
    return true
  }
  const ok = applyTransition(loc.track, loc.index, type, duration)
  normalizeMainTrack(d)
  return ok
}

/** Applies a transition to every main-track boundary. Returns how many boundaries got it. */
export const setTransitionAll = (
  d: Project,
  type: TransitionType | undefined,
  duration: Us,
): number => {
  const main = mainOf(d)
  if (!main) return 0
  let n = 0
  for (let i = 1; i < main.clips.length; i++) {
    const c = main.clips[i]
    if (!isMedia(c)) continue
    if (type === undefined) {
      if (c.transitionIn) n++
      delete c.transitionIn
    } else if (applyTransition(main, i, type, duration)) n++
  }
  normalizeMainTrack(d)
  return n
}

/* ------------------------------------------------------------------ transform */

/** Sets an animatable transform property at the playhead (keyframe-aware). */
export const setTransformProp = (
  d: Project,
  clipId: string,
  prop: AnimatableProp,
  value: number,
  t: Us,
  fps: number,
): void => {
  const c = need(clipOf(d, clipId, isVisual), clipId, 'visual')
  setAnimatable(c.transform[prop], t, value, fps)
}

export const toggleTransformKeyframe = (
  d: Project,
  clipId: string,
  prop: AnimatableProp,
  t: Us,
  fps: number,
): void => {
  toggleKeyframe(need(clipOf(d, clipId, isVisual), clipId, 'visual').transform[prop], t, fps)
}

/**
 * The tool-bar keyframe button: if any property has a keyframe at the playhead, removes
 * them all there; otherwise keyframes every property with its current value.
 */
export const toggleAllKeyframes = (
  d: Project,
  clipId: string,
  t: Us,
  fps: number,
): 'added' | 'removed' => {
  const c = need(clipOf(d, clipId, isVisual), clipId, 'visual')
  const any = ANIMATABLE_PROPS.some((p) => hasKeyframeAt(c.transform[p], t, fps))
  for (const p of ANIMATABLE_PROPS) {
    if (hasKeyframeAt(c.transform[p], t, fps) === any) toggleKeyframe(c.transform[p], t, fps)
  }
  return any ? 'removed' : 'added'
}

export const setFlip = (d: Project, clipId: string, axis: 'flipH' | 'flipV', on: boolean): void => {
  need(clipOf(d, clipId, isVisual), clipId, 'visual').transform[axis] = on
}

export const setCrop = (d: Project, clipId: string, patch: Partial<Crop>): void => {
  const c = need(clipOf(d, clipId, isMedia), clipId, 'media')
  const next = { ...c.crop, ...patch }
  // Keep at least 5 % of the frame visible on each axis.
  next.left = clamp(next.left, 0, 0.95)
  next.top = clamp(next.top, 0, 0.95)
  next.right = clamp(next.right, 0, 0.95 - next.left)
  next.bottom = clamp(next.bottom, 0, 0.95 - next.top)
  c.crop = next
}

export const setMediaProps = (
  d: Project,
  clipId: string,
  patch: Partial<Pick<MediaClip, 'fit' | 'blendMode' | 'autoMotion' | 'reverse'>>,
): void => {
  Object.assign(need(clipOf(d, clipId, isMedia), clipId, 'media'), patch)
}

/** Resets position/scale/rotation/opacity (dropping keyframes), flips and crop. */
export const resetTransform = (d: Project, clipId: string): void => {
  const c = need(clipOf(d, clipId, isVisual), clipId, 'visual')
  for (const p of ANIMATABLE_PROPS) c.transform[p] = { value: DEFAULT_TRANSFORM[p], keyframes: [] }
  c.transform.flipH = false
  c.transform.flipV = false
  if (isMedia(c)) c.crop = { ...NO_CROP }
}

/* ------------------------------------------------------------------ text & stickers */

export const setText = (d: Project, clipId: string, text: string): void => {
  need(clipOf(d, clipId, isText), clipId, 'text').text = text
}

/** "Text behind subject": the main-track subject (from its matte) is drawn over the text. */
export const setBehindSubject = (d: Project, clipId: string, on: boolean): void => {
  const c = need(clipOf(d, clipId, isText), clipId, 'text')
  if (on) c.behindSubject = true
  else delete c.behindSubject
}

export const setTextStyle = (d: Project, clipId: string, patch: Partial<TextStyle>): void => {
  const c = need(clipOf(d, clipId, isText), clipId, 'text')
  const next: TextStyle = { ...c.style, ...patch }
  if ('backgroundColor' in patch && patch.backgroundColor === undefined) delete next.backgroundColor
  c.style = next
}

const toAnimation = (ref: string | undefined, duration: Us): TextAnimation | undefined =>
  ref ? { ref, duration } : undefined

/** Copies a text preset's style and animations onto a text clip. */
export const applyTextPreset = (
  d: Project,
  clipId: string,
  preset: TextPreset,
  ref: string,
): void => {
  const c = need(clipOf(d, clipId, isText), clipId, 'text')
  c.style = { ...preset.style }
  c.presetRef = ref
  assignAnimations(c, preset)
}

const assignAnimations = (c: TextClip, preset: TextPreset) => {
  const slots: Array<[AnimationSlot, string | undefined]> = [
    ['in', preset.animationIn],
    ['out', preset.animationOut],
    ['loop', preset.animationLoop],
  ]
  for (const [slot, ref] of slots) {
    const key = ANIMATION_KEY[slot]
    const anim = toAnimation(ref, c[key]?.duration ?? DEFAULT_ANIMATION_DURATION)
    if (anim) c[key] = anim
    else delete c[key]
  }
}

const ANIMATION_KEY = { in: 'animationIn', out: 'animationOut', loop: 'animationLoop' } as const
export const DEFAULT_ANIMATION_DURATION: Us = 400_000

/**
 * Sets (or with `ref` undefined, clears) an animation slot of a text/sticker clip. In+out
 * durations never exceed the clip; stickers have no loop slot.
 */
export const setAnimation = (
  d: Project,
  clipId: string,
  slot: AnimationSlot,
  ref: string | undefined,
  duration?: Us,
): void => {
  const loc = locate(d, clipId)
  const c = loc?.clip
  if (!isText(c) && !isSticker(c))
    throw new OpError('not_found', `No text or sticker clip ${clipId}`)
  if (slot === 'loop' && !isText(c)) throw new OpError('no_loop', 'Stickers have no loop animation')
  const key = ANIMATION_KEY[slot]
  // Stickers share the in/out fields; the loop slot was rejected above for them.
  const target = c as TextClip
  const prev = target[key]
  if (ref === undefined) {
    delete target[key]
    return
  }
  const limit = slot === 'loop' ? c.duration : Math.max(1, Math.floor(c.duration / 2))
  const dur = clamp(Math.round(duration ?? prev?.duration ?? DEFAULT_ANIMATION_DURATION), 1, limit)
  target[key] = { ref, duration: dur }
}

/** Default length of new text and sticker clips. */
export const DEFAULT_OVERLAY_DURATION: Us = 3_000_000

/** Inserts a text clip at `at`, styled (and animated) from a pack preset when given. */
export const addText = (
  d: Project,
  at: Us,
  preset?: { item: TextPreset; ref: string },
): TextClip => {
  const clip = insertTextClip(d, {
    at,
    duration: DEFAULT_OVERLAY_DURATION,
    text: preset?.item.sampleText ?? 'Your text',
    ...(preset ? { style: { ...preset.item.style }, presetRef: preset.ref } : {}),
  })
  if (preset) assignAnimations(clip, preset.item)
  return clip
}

/** Inserts a sticker (pack sticker ref or user image asset) at `at`. */
export const addSticker = (
  d: Project,
  at: Us,
  source: { ref: string } | { assetId: string },
): StickerClip => insertStickerClip(d, { at, duration: DEFAULT_OVERLAY_DURATION, ...source })

/** Sets the timeline length of a text/sticker clip through core (keeps its start). */
export const setOverlayDuration = (d: Project, clipId: string, duration: Us): void => {
  const loc = locate(d, clipId)
  if (!loc || (!isText(loc.clip) && !isSticker(loc.clip)))
    throw new OpError('not_found', `No text or sticker clip ${clipId}`)
  trimClip(d, clipId, { end: loc.clip.start + Math.max(1, Math.round(duration)) })
}

/* ------------------------------------------------------------------ canvas */

export const setCanvas = (
  d: Project,
  patch: Partial<Pick<Project['settings'], 'background' | 'backgroundBlur' | 'fps'>>,
): void => {
  Object.assign(d.settings, patch)
}

/* ------------------------------------------------------------------ replace */

/**
 * Swaps the media of a clip, keeping its place and timing. A shorter replacement shortens
 * the clip (the main track ripples) instead of running past the end of the new media.
 */
export const replaceMedia = (d: Project, clipId: string, asset: Asset): void => {
  const loc = locate(d, clipId)
  const c = loc?.clip
  if (!c || (!isMedia(c) && !isAudioClip(c)))
    throw new OpError('not_found', `No media clip ${clipId}`)
  const wantAudio = isAudioClip(c)
  if (wantAudio !== (asset.kind === 'audio'))
    throw new OpError('kind_mismatch', wantAudio ? 'Pick an audio file' : 'Pick a video or photo')
  c.assetId = asset.id
  if (isMedia(c)) c.type = asset.kind === 'image' ? 'image' : 'video'
  if (asset.kind === 'image') {
    if (isMedia(c)) {
      c.in = 0
      c.speedRamp = []
      c.reverse = false
    }
    return
  }
  const timed = c as TimedClip
  const available = asset.duration ?? 0
  const span = Math.round(timed.duration * timed.speed)
  timed.in = span <= available - timed.in ? timed.in : 0
  if (span > available) {
    timed.duration = Math.max(1, Math.floor(available / timed.speed))
    if (isMedia(c)) c.speedRamp = []
  }
  if (loc?.track.kind === 'main') normalizeMainTrack(d)
}

/* ------------------------------------------------------------------ layers */

const LAYER_KIND: Record<Clip['type'], Track['kind'] | undefined> = {
  video: 'overlay',
  image: 'overlay',
  sticker: 'overlay',
  text: 'text',
  audio: undefined,
}

const isFree = (track: Track, start: Us, end: Us, exceptId: string) =>
  track.clips.every((c) => c.id === exceptId || c.start + c.duration <= start || c.start >= end)

/**
 * Bring forward / send backward. Visual stacking follows track order, so the clip moves
 * past the nearest visual layer (overlay or text track) in that direction: onto it when it
 * is a compatible, unlocked layer with room, otherwise onto a new layer created just beyond
 * it. Nothing goes below the main track. Returns false when there is no layer to pass (the
 * clip is already front/back-most) or the clip lives on the main/audio track.
 */
export const moveLayer = (d: Project, clipId: string, dir: 'forward' | 'backward'): boolean => {
  const loc = locate(d, clipId)
  if (!loc) return false
  const kind = LAYER_KIND[loc.clip.type]
  if (!kind || loc.track.kind !== kind) return false
  const { clip, track } = loc
  const from = d.tracks.indexOf(track)
  const step = dir === 'forward' ? 1 : -1
  let j = from + step
  while (j >= 0 && j < d.tracks.length && d.tracks[j]!.kind === 'audio') j += step
  const neighbour = d.tracks[j]
  if (!neighbour || neighbour.kind === 'main') return false
  if (
    neighbour.kind === kind &&
    !neighbour.locked &&
    isFree(neighbour, clip.start, clip.start + clip.duration, clip.id)
  ) {
    moveClip(d, clipId, { trackId: neighbour.id, start: clip.start })
    return true
  }
  const created = addTrack(d, kind, { index: dir === 'forward' ? j + 1 : j })
  moveClip(d, clipId, { trackId: created.id, start: clip.start })
  return true
}
