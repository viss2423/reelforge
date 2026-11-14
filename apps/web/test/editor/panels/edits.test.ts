/**
 * Panel action mapping: each recipe run through the store (`edit` / `gesture`) produces the
 * expected project change as ONE undo step. Core ops still stubbed on this branch are faked
 * (see fakeCore.ts).
 */
import {
  OpError,
  sec,
  TextStyle,
  type AudioClip,
  type MediaClip,
  type StickerClip,
  type TextClip,
} from '@reelforge/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { baseGesture, describeError, edit, gesture } from '@/editor/panels/model/commands.ts'
import {
  addEffect,
  addSticker,
  addText,
  applyTextPreset,
  maxTransition,
  moveLayer,
  NEUTRAL_ADJUSTMENTS,
  removeEffectRef,
  replaceMedia,
  resetAdjustments,
  resetTransform,
  setAdjustment,
  setAnimation,
  setAudio,
  setAudioClipProps,
  setCanvas,
  setChroma,
  setCrop,
  setFilter,
  setFilterIntensity,
  setFlip,
  setOverlayDuration,
  setSpeed,
  setSpeedCurve,
  setText,
  setTextStyle,
  setTransformProp,
  setTransition,
  setTransitionAll,
  toggleAllKeyframes,
  toggleTransformKeyframe,
  updateEffect,
} from '@/editor/panels/model/edits.ts'
import type { EditorStoreApi } from '@/state/editorStore.ts'
import { makeAsset } from '../../fixtures.ts'
import { clipIn, richStore } from './helpers.ts'

vi.mock('@reelforge/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@reelforge/core')>()
  const { fakeCore } = await import('./fakeCore.ts')
  return { ...real, ...fakeCore(real) }
})

const toasts = vi.hoisted(() => ({
  plain: vi.fn<typeof import('@/components/Toast.tsx').toast>(),
  error: vi.fn<(title: string, description?: string) => number>(),
}))
vi.mock('@/components/Toast.tsx', () => ({
  toast: Object.assign(toasts.plain, { error: toasts.error }),
}))

let store: EditorStoreApi
const s = () => store.getState()
const run = <R>(label: string, recipe: Parameters<typeof edit<R>>[1]) =>
  edit(label, recipe, { store })

beforeEach(() => {
  store = richStore()
})

/** Asserts `fn` records exactly one undo step and that undo restores the project. */
const oneStep = (fn: () => void) => {
  const before = s().project
  fn()
  expect(s().project).not.toBe(before)
  expect(s().history.canUndo).toBe(true)
  s().undo()
  expect(s().project).toEqual(before)
  s().redo()
}

describe('commands', () => {
  it('maps errors to user-facing text', () => {
    expect(describeError(new OpError('not_implemented', 'x'))).toBe(
      'This edit is not available yet',
    )
    expect(describeError(new OpError('bad', 'Nope'))).toBe('Nope')
    expect(describeError(new Error('boom'))).toBe('boom')
    expect(describeError('raw')).toBe('raw')
  })

  it('edit toasts failures, leaves the project alone and returns undefined', () => {
    const before = s().project
    expect(run('Volume', (d) => setAudio(d, ['txt'], { volume: 1 }))).toBeUndefined()
    expect(s().project).toBe(before)
    expect(toasts.error).toHaveBeenCalledWith('Volume failed', 'No audio clip txt')
    expect(edit('X', () => 1, { store, quiet: true })).toBe(1)
  })

  it('edit does nothing without a project', () => {
    s().unload()
    expect(run('Volume', () => 1)).toBeUndefined()
  })

  it('a slider gesture is one undo step however many changes it makes', () => {
    const g = gesture('Volume', (d, v: number) => setAudio(d, ['v1'], { volume: v }), store)
    const before = s().project
    g.onChangeStart()
    for (const v of [0.2, 0.5, 1.5]) g.onChange(v)
    g.onChangeEnd()
    expect(clipIn<MediaClip>(store, 'v1').audio.volume).toBe(1.5)
    s().undo()
    expect(s().project).toEqual(before)
  })

  it('baseGesture re-applies from the gesture base (no accumulated rounding)', () => {
    const g = baseGesture('Speed', (d, v: number) => setSpeed(d, 'v1', v), store)
    g.onChangeStart()
    for (const v of [3, 0.7, 2]) g.onChange(v)
    g.onChangeEnd()
    // From the base (2 s @1×), 2× → 1 s, not 2 s → 0.67 → … chain.
    expect(clipIn<MediaClip>(store, 'v1')).toMatchObject({ speed: 2, duration: sec(1) })
    expect(clipIn<MediaClip>(store, 'v2').start).toBe(sec(1))
    s().undo()
    expect(clipIn<MediaClip>(store, 'v1')).toMatchObject({ speed: 1, duration: sec(2) })
  })
})

describe('audio & speed', () => {
  it('clamps volume and fades', () => {
    oneStep(() =>
      run('Volume', (d) => setAudio(d, ['v1', 'mus'], { volume: 9, fadeIn: -5, fadeOut: sec(99) })),
    )
    expect(clipIn<MediaClip>(store, 'v1').audio).toMatchObject({
      volume: 4,
      fadeIn: 0,
      fadeOut: sec(2),
    })
    expect(clipIn<AudioClip>(store, 'mus').audio.fadeOut).toBe(sec(5))
  })

  it('sets audio-clip role and ducking', () => {
    oneStep(() =>
      run('Duck', (d) => setAudioClipProps(d, 'mus', { duckUnderVoice: true, role: 'voiceover' })),
    )
    expect(clipIn<AudioClip>(store, 'mus')).toMatchObject({
      duckUnderVoice: true,
      role: 'voiceover',
    })
  })

  it('writes speed-curve keyframes and removes them with none', () => {
    oneStep(() => run('Curve', (d) => setSpeedCurve(d, 'v2', 'bullet')))
    const ramp = clipIn<MediaClip>(store, 'v2').speedRamp
    expect(ramp.length).toBeGreaterThan(3)
    expect(clipIn<MediaClip>(store, 'v2').duration).toBe(sec(3))
    run('Curve', (d) => setSpeedCurve(d, 'v2', 'none'))
    expect(clipIn<MediaClip>(store, 'v2').speedRamp).toEqual([])
    expect(run('Curve', (d) => setSpeedCurve(d, 'mus', 'hero'))).toBeUndefined()
  })
})

describe('look', () => {
  it('sets and resets adjustments', () => {
    oneStep(() => run('Adjust', (d) => setAdjustment(d, ['v1', 'v2'], 'contrast', 0.4)))
    expect(clipIn<MediaClip>(store, 'v2').adjustments.contrast).toBe(0.4)
    run('Reset', (d) => resetAdjustments(d, ['v1']))
    expect(clipIn<MediaClip>(store, 'v1').adjustments).toEqual(NEUTRAL_ADJUSTMENTS)
  })

  it('applies, adjusts and removes a LUT filter', () => {
    oneStep(() => run('Filter', (d) => setFilter(d, ['v1'], 'trend/warm', 2)))
    expect(clipIn<MediaClip>(store, 'v1').filter).toEqual({ ref: 'trend/warm', intensity: 1 })
    run('Filter', (d) => setFilterIntensity(d, ['v1', 'v2'], 0.3))
    expect(clipIn<MediaClip>(store, 'v1').filter?.intensity).toBe(0.3)
    expect(clipIn<MediaClip>(store, 'v2').filter).toBeUndefined()
    run('Filter', (d) => setFilter(d, ['v1'], undefined))
    expect(clipIn<MediaClip>(store, 'v1').filter).toBeUndefined()
  })

  it('adds an effect once per clip, edits its window and removes it', () => {
    const ids = run('Effect', (d) => addEffect(d, ['v1', 'v2'], 'trend/shake'))!
    expect(ids).toHaveLength(2)
    expect(run('Effect', (d) => addEffect(d, ['v1'], 'trend/shake'))).toEqual([])
    const fx = clipIn<MediaClip>(store, 'v1').effects[0]!
    run('Effect', (d) =>
      updateEffect(d, 'v1', fx.id, { start: sec(1.5), duration: sec(5), intensity: 3 }),
    )
    expect(clipIn<MediaClip>(store, 'v1').effects[0]).toMatchObject({
      start: sec(1.5),
      duration: sec(0.5),
      intensity: 1,
    })
    run('Effect', (d) => updateEffect(d, 'v1', fx.id, { duration: undefined }))
    expect(clipIn<MediaClip>(store, 'v1').effects[0]!.duration).toBeUndefined()
    expect(run('Effect', (d) => updateEffect(d, 'v1', 'nope', {}))).toBeUndefined()
    run('Effect', (d) => removeEffectRef(d, ['v1', 'v2'], 'trend/shake'))
    expect(clipIn<MediaClip>(store, 'v2').effects).toEqual([])
  })

  it('enables chroma key with defaults and patches it', () => {
    oneStep(() => run('Chroma', (d) => setChroma(d, 'ov1', { color: '#0000ff' })))
    expect(clipIn<MediaClip>(store, 'ov1').chromaKey).toEqual({
      enabled: true,
      color: '#0000ff',
      similarity: 0.3,
      blend: 0.1,
    })
  })
})

describe('transitions', () => {
  it('limits duration to half the shorter neighbour and needs a boundary', () => {
    const main = s().project!.tracks[0]!
    expect(maxTransition(main, 1)).toBe(sec(1))
    expect(maxTransition(main, 0)).toBe(0)
    oneStep(() => run('Transition', (d) => setTransition(d, 'v2', 'whip', sec(5))))
    expect(clipIn<MediaClip>(store, 'v2').transitionIn).toEqual({ type: 'whip', duration: sec(1) })
    expect(run('Transition', (d) => setTransition(d, 'v1', 'whip', sec(1)))).toBeUndefined()
    expect(run('Transition', (d) => setTransition(d, 'ov1', 'whip', sec(1)))).toBeUndefined()
    run('Transition', (d) => setTransition(d, 'v2', undefined, 0))
    expect(clipIn<MediaClip>(store, 'v2').transitionIn).toBeUndefined()
  })

  it('applies to every boundary and reports how many', () => {
    expect(run('All', (d) => setTransitionAll(d, 'fade', 10))).toBe(1)
    expect(clipIn<MediaClip>(store, 'v2').transitionIn).toEqual({ type: 'fade', duration: 50_000 })
    expect(run('All', (d) => setTransitionAll(d, undefined, 0))).toBe(1)
  })
})

describe('transform & keyframes', () => {
  const fps = 30

  it('sets constants, and keyframes once animated', () => {
    oneStep(() => run('Move', (d) => setTransformProp(d, 'v1', 'x', 100, 0, fps)))
    expect(clipIn<MediaClip>(store, 'v1').transform.x).toEqual({ value: 100, keyframes: [] })
    run('Keyframe', (d) => toggleTransformKeyframe(d, 'v1', 'x', 0, fps))
    run('Move', (d) => setTransformProp(d, 'v1', 'x', 300, sec(1), fps))
    expect(clipIn<MediaClip>(store, 'v1').transform.x.keyframes.map((k) => [k.t, k.value])).toEqual(
      [
        [0, 100],
        [sec(1), 300],
      ],
    )
  })

  it('the tool-bar keyframe toggles all properties at the playhead', () => {
    expect(run('Keyframe', (d) => toggleAllKeyframes(d, 'txt', 0, fps))).toBe('added')
    const t = clipIn<TextClip>(store, 'txt').transform
    for (const p of ['x', 'y', 'scale', 'rotation', 'opacity'] as const)
      expect(t[p].keyframes).toHaveLength(1)
    expect(run('Keyframe', (d) => toggleAllKeyframes(d, 'txt', 0, fps))).toBe('removed')
    expect(clipIn<TextClip>(store, 'txt').transform.x.keyframes).toEqual([])
  })

  it('crops within bounds, flips and resets everything', () => {
    run('Crop', (d) => setCrop(d, 'v1', { left: 0.9, right: 0.5 }))
    expect(clipIn<MediaClip>(store, 'v1').crop.left).toBe(0.9)
    expect(clipIn<MediaClip>(store, 'v1').crop.right).toBeCloseTo(0.05, 9)
    run('Flip', (d) => setFlip(d, 'v1', 'flipH', true))
    run('Scale', (d) => setTransformProp(d, 'v1', 'scale', 2, 0, fps))
    oneStep(() => run('Reset', (d) => resetTransform(d, 'v1')))
    const c = clipIn<MediaClip>(store, 'v1')
    expect(c.crop).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
    expect(c.transform).toMatchObject({ flipH: false, scale: { value: 1, keyframes: [] } })
  })
})

describe('text & stickers', () => {
  it('adds text at the playhead, styled from a preset with its animations', () => {
    const preset = {
      id: 'neon',
      name: 'Neon',
      trendScore: 1,
      tags: [],
      style: TextStyle.parse({ color: '#FF00FF' }),
      animationIn: 'builtin/pop',
      sampleText: 'NEON',
    }
    const clip = run('Add text', (d) => addText(d, sec(2), { item: preset, ref: 'trend/neon' }))!
    const live = clipIn<TextClip>(store, clip.id)
    expect(live).toMatchObject({
      text: 'NEON',
      start: sec(2),
      presetRef: 'trend/neon',
      animationIn: { ref: 'builtin/pop', duration: 400_000 },
      style: { color: '#FF00FF' },
    })
    expect(live.animationOut).toBeUndefined()
    const plain = run('Add text', (d) => addText(d, 0))!
    expect(clipIn<TextClip>(store, plain.id).text).toBe('Your text')
  })

  it('edits text, style (clearing the box) and applies presets', () => {
    run('Text', (d) => setText(d, 'txt', 'Bye'))
    run('Style', (d) => setTextStyle(d, 'txt', { backgroundColor: '#000000', fontSize: 90 }))
    expect(clipIn<TextClip>(store, 'txt').style).toMatchObject({
      backgroundColor: '#000000',
      fontSize: 90,
    })
    run('Style', (d) => setTextStyle(d, 'txt', { backgroundColor: undefined }))
    expect('backgroundColor' in clipIn<TextClip>(store, 'txt').style).toBe(false)
    run('Preset', (d) =>
      applyTextPreset(
        d,
        'txt',
        {
          id: 'p',
          name: 'P',
          trendScore: 1,
          tags: [],
          style: TextStyle.parse({ italic: true }),
          animationLoop: 'builtin/pulse',
          sampleText: '',
        },
        'trend/p',
      ),
    )
    expect(clipIn<TextClip>(store, 'txt')).toMatchObject({
      text: 'Bye',
      presetRef: 'trend/p',
      style: { italic: true },
      animationLoop: { ref: 'builtin/pulse' },
    })
  })

  it('sets animations with duration limits; stickers have no loop', () => {
    run('Anim', (d) => setAnimation(d, 'txt', 'in', 'builtin/fade', sec(5)))
    expect(clipIn<TextClip>(store, 'txt').animationIn).toEqual({
      ref: 'builtin/fade',
      duration: sec(0.5),
    })
    run('Anim', (d) => setAnimation(d, 'txt', 'loop', 'builtin/pulse', sec(5)))
    expect(clipIn<TextClip>(store, 'txt').animationLoop?.duration).toBe(sec(1))
    run('Anim', (d) => setAnimation(d, 'txt', 'in', undefined))
    expect(clipIn<TextClip>(store, 'txt').animationIn).toBeUndefined()
    run('Anim', (d) => setAnimation(d, 'stk', 'out', 'builtin/zoomOut'))
    expect(clipIn<StickerClip>(store, 'stk').animationOut?.ref).toBe('builtin/zoomOut')
    expect(run('Anim', (d) => setAnimation(d, 'stk', 'loop', 'builtin/pulse'))).toBeUndefined()
    expect(run('Anim', (d) => setAnimation(d, 'v1', 'in', 'builtin/fade'))).toBeUndefined()
  })

  it('adds stickers from packs or user images and sets overlay duration', () => {
    const st = run('Sticker', (d) => addSticker(d, sec(1), { ref: 'trend/fire' }))!
    expect(clipIn<StickerClip>(store, st.id)).toMatchObject({
      ref: 'trend/fire',
      start: sec(1),
      duration: sec(3),
    })
    const img = run('Sticker', (d) => addSticker(d, 0, { assetId: 'a1' }))!
    expect(clipIn<StickerClip>(store, img.id).assetId).toBe('a1')
    oneStep(() => run('Duration', (d) => setOverlayDuration(d, 'txt', sec(4))))
    expect(clipIn<TextClip>(store, 'txt').duration).toBe(sec(4))
    expect(run('Duration', (d) => setOverlayDuration(d, 'v1', sec(4)))).toBeUndefined()
  })
})

describe('canvas, replace & layers', () => {
  it('patches canvas settings', () => {
    oneStep(() =>
      run('Canvas', (d) => setCanvas(d, { background: '#112233', backgroundBlur: true, fps: 60 })),
    )
    expect(s().project!.settings).toMatchObject({
      background: '#112233',
      backgroundBlur: true,
      fps: 60,
    })
  })

  it('replaces media keeping timing, shortening when the new media is shorter', () => {
    const long = makeAsset({ id: 'long', duration: sec(20) })
    oneStep(() => run('Replace', (d) => replaceMedia(d, 'v2', long)))
    expect(clipIn<MediaClip>(store, 'v2')).toMatchObject({ assetId: 'long', duration: sec(3) })
    const short = makeAsset({ id: 'short', duration: sec(1) })
    run('Replace', (d) => replaceMedia(d, 'v1', short))
    expect(clipIn<MediaClip>(store, 'v1')).toMatchObject({
      assetId: 'short',
      duration: sec(1),
      in: 0,
    })
    expect(clipIn<MediaClip>(store, 'v2').start).toBe(sec(1))
    const photo = makeAsset({ id: 'img', kind: 'image', mime: 'image/png' })
    run('Replace', (d) => replaceMedia(d, 'v2', photo))
    expect(clipIn<MediaClip>(store, 'v2').type).toBe('image')
    expect(run('Replace', (d) => replaceMedia(d, 'mus', photo))).toBeUndefined()
    expect(toasts.error).toHaveBeenLastCalledWith('Replace failed', 'Pick an audio file')
  })

  it('moves layers forward onto new tracks and refuses at the back', () => {
    // Overlay clip at index 1: forward passes the text track (incompatible) → new overlay above it.
    expect(run('Forward', (d) => moveLayer(d, 'ov1', 'forward'))).toBe(true)
    const kinds = s().project!.tracks.map((t) => t.kind)
    expect(kinds).toEqual(['main', 'overlay', 'text', 'overlay', 'audio'])
    expect(s().project!.tracks[3]!.clips.map((c) => c.id)).toEqual(['ov1'])
    // Backward: passing the text track again needs a new overlay just below it…
    expect(run('Back', (d) => moveLayer(d, 'ov1', 'backward'))).toBe(true)
    const tracks = s().project!.tracks
    expect(tracks.map((t) => t.kind)).toEqual([
      'main',
      'overlay',
      'overlay',
      'text',
      'overlay',
      'audio',
    ])
    expect(tracks[2]!.clips.map((c) => c.id)).toEqual(['ov1'])
    // …then the original overlay (compatible, free at that time) takes it back.
    expect(run('Back', (d) => moveLayer(d, 'ov1', 'backward'))).toBe(true)
    expect(
      s()
        .project!.tracks[1]!.clips.map((c) => c.id)
        .toSorted(),
    ).toEqual(['ov1', 'stk'])
    // Nothing goes below main.
    expect(run('Back', (d) => moveLayer(d, 'ov1', 'backward'))).toBe(false)
    expect(run('Back', (d) => moveLayer(d, 'v1', 'backward'))).toBe(false)
    expect(run('Back', (d) => moveLayer(d, 'mus', 'forward'))).toBe(false)
  })
})
