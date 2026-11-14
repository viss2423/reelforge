import { Adjustments, ChromaKey } from '@reelforge/core'
import { describe, expect, it } from 'vitest'
import {
  BLEND_ID,
  blendChannel,
  chromaKeyAlpha,
  compositeChannel,
  keyUV,
  type BlendMode,
} from './keying.ts'
import { adjustUniforms, chromaKeyUniforms, hexToRgb } from './uniforms.ts'

const nine = (v: number): number[] => Array.from({ length: 9 }, () => v)

describe('chroma key (vf_chromakey)', () => {
  it('converts the key colour to BT.709 limited chroma code values', () => {
    const [u, v] = keyUV('#00ff00')
    expect(u).toBeCloseTo(128 - (224 * 0.7152) / 1.8556, 6)
    expect(v).toBeCloseTo(128 - (224 * 0.7152) / 1.5748, 6)
    const [gu, gv] = keyUV('#808080')
    expect(gu).toBeCloseTo(128, 6)
    expect(gv).toBeCloseTo(128, 6)
  })

  it('is transparent on the key, opaque far from it, and ramps over `blend`', () => {
    const key = keyUV('#00ff00')
    expect(chromaKeyAlpha(nine(key[0]), nine(key[1]), key, 0.3, 0.1)).toBe(0)
    // magenta-ish chroma, far from green
    expect(chromaKeyAlpha(nine(230), nine(230), key, 0.3, 0.1)).toBe(1)
    // distance exactly similarity + blend/2 → alpha 0.5
    const target = 0.35
    const du = target * 255 * Math.SQRT2
    const a = chromaKeyAlpha(nine(key[0] + du), nine(key[1]), key, 0.3, 0.1)
    expect(a).toBeCloseTo(0.5, 9)
  })

  it('uses a hard threshold when blend is ~0 and averages the 3×3 neighbourhood', () => {
    const key = keyUV('#00ff00')
    const near = key[0] + 0.2 * 255 * Math.SQRT2
    expect(chromaKeyAlpha(nine(near), nine(key[1]), key, 0.3, 0)).toBe(0)
    expect(chromaKeyAlpha(nine(near), nine(key[1]), key, 0.1, 0)).toBe(1)
    // one far neighbour out of nine moves the mean distance by 1/9 of its distance
    const us = nine(key[0])
    us[4] = key[0] + 0.9 * 255 * Math.SQRT2
    expect(chromaKeyAlpha(us, nine(key[1]), key, 0, 1)).toBeCloseTo(0.1, 9)
  })
})

describe('blend modes', () => {
  const modes = Object.keys(BLEND_ID) as BlendMode[]

  it('have stable, unique shader ids', () => {
    expect(new Set(Object.values(BLEND_ID)).size).toBe(modes.length)
    expect(BLEND_ID.normal).toBe(0)
  })

  it('follow the W3C compositing definitions', () => {
    for (const [d, s] of [
      [0.2, 0.7],
      [0.8, 0.4],
      [0.5, 0.5],
    ] as const) {
      expect(blendChannel('normal', d, s)).toBe(s)
      expect(blendChannel('screen', d, s)).toBeCloseTo(d + s - d * s, 12)
      expect(blendChannel('multiply', d, s)).toBeCloseTo(d * s, 12)
      expect(blendChannel('lighten', d, s)).toBe(Math.max(d, s))
      expect(blendChannel('darken', d, s)).toBe(Math.min(d, s))
      expect(blendChannel('add', d, s)).toBe(Math.min(1, d + s))
    }
    // overlay keys on the destination: multiply below 0.5, screen above
    expect(blendChannel('overlay', 0.25, 0.5)).toBeCloseTo(0.25, 12)
    expect(blendChannel('overlay', 0.75, 0.5)).toBeCloseTo(0.75, 12)
    expect(blendChannel('overlay', 0.25, 1)).toBeCloseTo(0.5, 12)
  })

  it('identities: black screens/adds to nothing, white multiplies to nothing', () => {
    for (const d of [0, 0.3, 1]) {
      expect(blendChannel('screen', d, 0)).toBeCloseTo(d, 12)
      expect(blendChannel('add', d, 0)).toBeCloseTo(d, 12)
      expect(blendChannel('multiply', d, 1)).toBeCloseTo(d, 12)
    }
  })

  it('composite mixes by alpha', () => {
    for (const m of modes) {
      expect(compositeChannel(m, 0.4, 0.9, 0)).toBeCloseTo(0.4, 12)
      expect(compositeChannel(m, 0.4, 0.9, 1)).toBeCloseTo(blendChannel(m, 0.4, 0.9), 12)
    }
    expect(compositeChannel('normal', 0, 1, 0.25)).toBeCloseTo(0.25, 12)
  })
})

describe('uniform caches', () => {
  it('adjustUniforms is neutral-off and cached per adjustments object', () => {
    const neutral = Adjustments.parse({})
    expect(adjustUniforms(neutral).on).toBe(false)
    const a = Adjustments.parse({ contrast: 20, blur: 50 })
    const u = adjustUniforms(a)
    expect(u.on).toBe(true)
    expect(u.blurPx).toBeGreaterThan(0)
    expect(adjustUniforms(a)).toBe(u)
    expect(adjustUniforms(Adjustments.parse({ contrast: 20, blur: 50 }))).not.toBe(u)
  })

  it('chromaKeyUniforms packs (U, V, similarity, blend) once per key object', () => {
    const k = ChromaKey.parse({ enabled: true, color: '#0000ff', similarity: 0.2, blend: 0.05 })
    const u = chromaKeyUniforms(k)
    const [ku, kv] = keyUV('#0000ff')
    expect(Array.from(u)).toEqual([
      Math.fround(ku),
      Math.fround(kv),
      Math.fround(0.2),
      Math.fround(0.05),
    ])
    expect(chromaKeyUniforms(k)).toBe(u)
  })

  it('hexToRgb parses #rrggbb and #rrggbbaa, and falls back to black', () => {
    expect(hexToRgb('#ff8000')).toEqual([1, 128 / 255, 0])
    expect(hexToRgb('#00000080')).toEqual([0, 0, 0])
    expect(hexToRgb('nope')).toEqual([0, 0, 0])
    expect(hexToRgb('#ff8000')).toBe(hexToRgb('#ff8000'))
  })
})
