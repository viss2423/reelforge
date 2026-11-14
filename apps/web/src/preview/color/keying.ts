/**
 * Chroma key and blend modes — CPU references of the layer shader's math (gl/shaders.ts),
 * kept identical to the FFmpeg filters the export uses.
 */
import { rgbToYuv709 } from './adjustments.ts'

/* ------------------------------------------------------------------ chroma key (vf_chromakey.c) */

/** Key colour `#rrggbb` → its (U, V) 8-bit code values (BT.709 limited, like the proxy). */
export function keyUV(hex: string): [number, number] {
  const n = Number.parseInt(hex.slice(1, 7), 16)
  const yuv = rgbToYuv709(
    ((n >> 16) & 255) / 255,
    ((n >> 8) & 255) / 255,
    (n & 255) / 255,
    new Float64Array(3),
  )
  return [yuv[1]!, yuv[2]!]
}

/**
 * vf_chromakey alpha (0..1) from the chroma of a 3×3 neighbourhood: mean normalised UV
 * distance to the key, mapped through similarity/blend. `us`/`vs` are 8-bit code values.
 */
export function chromaKeyAlpha(
  us: readonly number[],
  vs: readonly number[],
  key: readonly [number, number],
  similarity: number,
  blend: number,
): number {
  let diff = 0
  for (let i = 0; i < us.length; i++) {
    const du = us[i]! - key[0]
    const dv = vs[i]! - key[1]
    diff += Math.sqrt((du * du + dv * dv) / (255 * 255 * 2))
  }
  diff /= us.length
  if (blend > 0.0001) return Math.min(1, Math.max(0, (diff - similarity) / blend))
  return diff > similarity ? 1 : 0
}

/* ------------------------------------------------------------------ blend modes */

export const BLEND_ID = {
  normal: 0,
  screen: 1,
  multiply: 2,
  overlay: 3,
  lighten: 4,
  darken: 5,
  add: 6,
} as const

export type BlendMode = keyof typeof BLEND_ID

/**
 * Blend of source `s` over destination `d` (one channel, 0..1) before opacity, using the
 * conventional (Photoshop/W3C compositing) definitions; `overlay` keys on the DESTINATION.
 */
export function blendChannel(mode: BlendMode, d: number, s: number): number {
  switch (mode) {
    case 'normal':
      return s
    case 'screen':
      return 1 - (1 - d) * (1 - s)
    case 'multiply':
      return d * s
    case 'overlay':
      return d < 0.5 ? 2 * d * s : 1 - 2 * (1 - d) * (1 - s)
    case 'lighten':
      return Math.max(d, s)
    case 'darken':
      return Math.min(d, s)
    case 'add':
      return Math.min(1, d + s)
  }
}

/** Final composite: mix(d, blend(d, s), alpha). */
export const compositeChannel = (mode: BlendMode, d: number, s: number, alpha: number): number =>
  d + (blendChannel(mode, d, s) - d) * alpha
