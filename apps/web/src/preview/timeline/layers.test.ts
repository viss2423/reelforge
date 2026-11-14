import { EffectPreset, type AnimationPreset, type Easing } from '@reelforge/core'
import { describe, expect, it } from 'vitest'
import { applyEffect, createEffectState, evaluateEffects } from '../effects/effects.ts'
import { image, sticker, video } from '../test/model.ts'
import {
  AUTO_MOTION_ZOOM,
  computeLayer,
  createLayerState,
  displayToTexture,
  quadToCanvas,
  type SourceInfo,
} from './layers.ts'

const S = 1_000_000
const portrait: SourceInfo = { width: 540, height: 960, rotation: 0 }
const landscape: SourceInfo = { width: 960, height: 540, rotation: 0 }
const kf = (t: number, value: number, easing: Easing = 'linear') => ({ t, value, easing })

const corners = (m: Float32Array) => ({
  tl: quadToCanvas(m, -0.5, -0.5),
  br: quadToCanvas(m, 0.5, 0.5),
})

const close = (a: readonly number[], b: readonly number[], eps = 1e-3) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, -Math.log10(eps)))

describe('computeLayer geometry', () => {
  it('cover of a 9:16 source fills the canvas exactly', () => {
    const L = computeLayer(video(), 0, portrait, {}, createLayerState())
    const { tl, br } = corners(L.m)
    close(tl, [0, 0])
    close(br, [1080, 1920])
    expect(L.opacity).toBe(1)
    expect(L.texelsPerPx).toBeCloseTo(0.5)
  })

  it('cover vs contain vs fill for a 16:9 source', () => {
    const cover = computeLayer(video({ fit: 'cover' }), 0, landscape, {}, createLayerState())
    expect(cover.height).toBeCloseTo(1920)
    expect(cover.width).toBeCloseTo((1920 * 960) / 540)
    const contain = computeLayer(video({ fit: 'contain' }), 0, landscape, {}, createLayerState())
    expect(contain.width).toBeCloseTo(1080)
    expect(contain.height).toBeCloseTo(607.5)
    const { tl } = corners(contain.m)
    close(tl, [0, 960 - 607.5 / 2])
    const fill = computeLayer(video({ fit: 'fill' }), 0, landscape, {}, createLayerState())
    expect([fill.width, fill.height]).toEqual([1080, 1920])
  })

  it('crop narrows the UV rect and refits the cropped region', () => {
    const L = computeLayer(
      video({ fit: 'contain', crop: { left: 0.25, right: 0.25, top: 0, bottom: 0 } }),
      0,
      landscape,
      {},
      createLayerState(),
    )
    close([...L.uv], [0.25, 0, 0.75, 1])
    // cropped 480x540 contain-fitted into 1080x1920 → width-limited
    expect(L.width).toBeCloseTo(1080)
    expect(L.height).toBeCloseTo(1215)
  })

  it('applies keyframed transform (position, scale, rotation, opacity) at local time', () => {
    const clip = video({
      transform: {
        x: { value: 540, keyframes: [kf(0, 0), kf(S, 1080)] },
        y: { value: 960, keyframes: [] },
        scale: { value: 0.5, keyframes: [] },
        rotation: { value: 90, keyframes: [] },
        opacity: { value: 1, keyframes: [kf(0, 0), kf(S, 1)] },
        flipH: false,
        flipV: false,
      },
    })
    const L = computeLayer(clip, S / 2, portrait, {}, createLayerState())
    expect(L.opacity).toBeCloseTo(0.5)
    expect(L.width).toBeCloseTo(540)
    // rotated 90° clockwise: top-left of content lands at top-right of its box
    const tl = quadToCanvas(L.m, -0.5, -0.5)
    close(tl, [540 + 480, 960 - 270])
  })

  it('flipH mirrors in place', () => {
    const L = computeLayer(
      video({ transform: { flipH: true } }),
      0,
      portrait,
      {},
      createLayerState(),
    )
    close(quadToCanvas(L.m, -0.5, -0.5), [1080, 0])
    // mirroring flips the orientation (determinant sign) of the layer matrix
    const det = (m: Float32Array) => m[0]! * m[3]! - m[1]! * m[2]!
    const plain = computeLayer(video(), 0, portrait, {}, createLayerState())
    expect(Math.sign(det(L.m))).toBe(-Math.sign(det(plain.m)))
  })

  it('honours display rotation (portrait phone video stored landscape)', () => {
    const L = computeLayer(
      video(),
      0,
      { width: 960, height: 540, rotation: 90 },
      {},
      createLayerState(),
    )
    expect(L.rotation).toBe(90)
    close([L.width, L.height], [1080, 1920])
    expect(displayToTexture(0, 0, 90)).toEqual([0, 1])
    expect(displayToTexture(1, 0, 90)).toEqual([0, 0])
    expect(displayToTexture(0, 0, 180)).toEqual([1, 1])
    expect(displayToTexture(0, 0, 270)).toEqual([1, 0])
  })

  it('image auto motion zooms and pans without exposing borders', () => {
    const zin = image({ autoMotion: 'zoomIn', duration: 2 * S })
    expect(computeLayer(zin, 0, portrait, {}, createLayerState()).width).toBeCloseTo(1080)
    expect(computeLayer(zin, 2 * S, portrait, {}, createLayerState()).width).toBeCloseTo(
      1080 * AUTO_MOTION_ZOOM,
    )
    const pan = image({ autoMotion: 'panLeft', duration: 2 * S })
    for (const t of [0, S, 2 * S]) {
      const L = computeLayer(pan, t, portrait, {}, createLayerState())
      const { tl, br } = corners(L.m)
      expect(tl[0]).toBeLessThanOrEqual(1e-3)
      expect(br[0]).toBeGreaterThanOrEqual(1080 - 1e-3)
    }
    const start = corners(computeLayer(pan, 0, portrait, {}, createLayerState()).m).tl[0]
    const end = corners(computeLayer(pan, 2 * S, portrait, {}, createLayerState()).m).tl[0]
    expect(end).toBeLessThan(start) // moves left
  })

  it('stickers use natural size and pack animations', () => {
    const pop: AnimationPreset = {
      id: 'pop',
      name: 'Pop',
      trendScore: 50,
      tags: [],
      kind: 'in',
      perCharacter: false,
      tracks: {
        scale: [
          { t: 0, value: 0, easing: 'linear' },
          { t: 1, value: 1, easing: 'linear' },
        ],
        opacity: [
          { t: 0, value: 0, easing: 'linear' },
          { t: 1, value: 1, easing: 'linear' },
        ],
      },
    }
    const s = sticker({ animationIn: { ref: 'builtin/pop', duration: 400_000 } })
    const ctx = { resolveAnimation: (r: string) => (r === 'builtin/pop' ? pop : undefined) }
    const src: SourceInfo = { width: 200, height: 100, rotation: 0 }
    const mid = computeLayer(s, 200_000, src, ctx, createLayerState())
    expect(mid.width).toBeCloseTo(100)
    expect(mid.opacity).toBeCloseTo(0.5)
    const after = computeLayer(s, 600_000, src, ctx, createLayerState())
    expect(after.width).toBeCloseTo(200)
    expect(after.opacity).toBe(1)
    const big = computeLayer(
      s,
      S,
      { width: 4000, height: 1000, rotation: 0 },
      {},
      createLayerState(),
    )
    expect(big.width).toBeCloseTo(1080)
  })

  it('does not allocate per call', () => {
    const L = createLayerState()
    const clip = video()
    const m = L.m
    for (let i = 0; i < 100; i++) computeLayer(clip, i * 1000, portrait, {}, L)
    expect(L.m).toBe(m)
  })
})

describe('effects', () => {
  const preset = (effect: EffectPreset['effect'], params: Record<string, number> = {}) =>
    EffectPreset.parse({ id: effect, name: effect, effect, params })

  it('shake is deterministic, bounded and zero at t=0 phase', () => {
    const s = createEffectState()
    applyEffect(preset('shake'), 0, 1, s)
    expect(s.dx).toBeCloseTo(0.4 * 24 * Math.sin(1.3))
    let max = 0
    for (let t = 0; t < 2; t += 0.01) {
      const st = createEffectState()
      applyEffect(preset('shake', { amplitude: 10 }), t, 0.5, st)
      max = Math.max(max, Math.abs(st.dx), Math.abs(st.dy))
    }
    expect(max).toBeLessThanOrEqual(5 + 1e-9)
  })

  it('zoomPulse/beatZoom scale, flash/strobe white, blurIn decays', () => {
    const s = createEffectState()
    applyEffect(preset('zoomPulse'), 0.25, 1, s) // f=2 → peak at 0.25s
    expect(s.scale).toBeCloseTo(1.08)
    const b = createEffectState()
    applyEffect(preset('beatZoom', { bpm: 60 }), 1, 1, b) // on the beat
    expect(b.scale).toBeCloseTo(1.1)
    const f = createEffectState()
    applyEffect(preset('flash'), 0.15, 1, f)
    expect(f.white).toBeCloseTo(0.5)
    const st = createEffectState()
    applyEffect(preset('strobe'), 0.1, 1, st) // 8 Hz: second half-cycle is off
    expect(st.white).toBe(0)
    const bi = createEffectState()
    applyEffect(preset('blurIn'), 0.25, 1, bi)
    expect(bi.blur).toBeCloseTo(15)
  })

  it('evaluateEffects honours windows, intensity and unknown refs', () => {
    const presets: Record<string, EffectPreset> = {
      'p/split': preset('rgbSplit'),
      'p/grain': preset('filmGrain'),
    }
    const s = createEffectState()
    const effects = [
      { id: 'e1', ref: 'p/split', start: 0, duration: S, intensity: 0.5 },
      { id: 'e2', ref: 'p/grain', start: S, intensity: 1 },
      { id: 'e3', ref: 'p/missing', start: 0, intensity: 1 },
    ]
    evaluateEffects(effects, S / 2, 3 * S, (r) => presets[r], s)
    expect(s.rgbSplit).toBe(6)
    expect(s.grain).toBe(0)
    evaluateEffects(effects, 2 * S, 3 * S, (r) => presets[r], s)
    expect(s.rgbSplit).toBe(0)
    expect(s.grain).toBeCloseTo(0.12)
    evaluateEffects(effects, 2 * S, 3 * S, undefined, s)
    expect(s.grain).toBe(0)
  })
})
