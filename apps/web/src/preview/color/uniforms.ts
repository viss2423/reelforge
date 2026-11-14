/**
 * Per-object uniform caches. The project model is immutable between edits (Immer keeps
 * unchanged sub-objects by reference), so the slider → shader-uniform conversion runs once
 * per edited object instead of once per layer per frame.
 */
import type { Adjustments, ChromaKey } from '@reelforge/core'
import { ADJ_FLOATS, adjustParams, packAdjustUniforms } from './adjustments.ts'
import { keyUV } from './keying.ts'

export interface AdjustUniforms {
  /** False when every slider is neutral (shader skips the pipeline). */
  on: boolean
  /** sharpen, vignette angle, grain, curves-on (see packAdjustUniforms). */
  adj: Float32Array
  /** 256×1 RGBA8 Y/U/V curve table (the export's lutyuv), or null when neutral. */
  curves: Uint8Array | null
  /** Gaussian blur σ in canvas px (applied as a pre-pass). */
  blurPx: number
}

const adjCache = new WeakMap<Adjustments, AdjustUniforms>()

export function adjustUniforms(a: Adjustments): AdjustUniforms {
  let u = adjCache.get(a)
  if (!u) {
    const p = adjustParams(a)
    const adj = new Float32Array(ADJ_FLOATS)
    const on = packAdjustUniforms(p, adj)
    u = { on, adj, curves: p.curves, blurPx: p.blurSigma }
    adjCache.set(a, u)
  }
  return u
}

const keyCache = new WeakMap<ChromaKey, Float32Array>()

/** (key U, key V, similarity, blend) for the layer shader. */
export function chromaKeyUniforms(k: ChromaKey): Float32Array {
  let u = keyCache.get(k)
  if (!u) {
    const [ku, kv] = keyUV(k.color)
    u = new Float32Array([ku, kv, k.similarity, k.blend])
    keyCache.set(k, u)
  }
  return u
}

const rgbCache = new Map<string, readonly [number, number, number]>()

/** `#rrggbb[aa]` → linear-in-code-value RGB 0..1 (alpha ignored: the canvas is opaque). */
export function hexToRgb(hex: string): readonly [number, number, number] {
  let c = rgbCache.get(hex)
  if (!c) {
    const n = Number.parseInt(hex.slice(1, 7), 16)
    c = Number.isNaN(n)
      ? [0, 0, 0]
      : [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
    // a colour picker being dragged produces a new string per frame: keep the cache tiny
    if (rgbCache.size >= 64) rgbCache.clear()
    rgbCache.set(hex, c)
  }
  return c
}
