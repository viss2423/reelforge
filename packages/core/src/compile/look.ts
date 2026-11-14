/**
 * The clip "look": adjustments, LUT filter and chroma key, in that order of application
 * relative to the sprite (key first so grading never changes what gets keyed).
 */
import type { Adjustments, ChromaKey, FilterRef } from '../schema.ts'
import {
  blurFilter,
  grainFilter,
  lutyuvFilter,
  sharpenFilter,
  vignetteFilter,
} from './adjustments.ts'
import { escapeFilterPath, filter } from './escape.ts'
import type { Graph } from './graph.ts'

export interface LutResolver {
  resolveLut(ref: string): string | undefined
  resolveLutMix?(ref: string, intensity: number): string | undefined
}

/** Adjustment filters (cheapest first: one lutyuv for all tonal/colour sliders). */
export function adjustmentFilters(a: Adjustments, scale: number): string[] {
  return [
    lutyuvFilter(a),
    sharpenFilter(a, scale),
    blurFilter(a, scale),
    vignetteFilter(a),
    grainFilter(a),
  ].filter((f): f is string => f !== undefined)
}

/** Neutral adjustments produce no filters. */
export const adjustmentsNeutral = (a: Adjustments, scale: number): boolean =>
  adjustmentFilters(a, scale).length === 0

const lut3d = (path: string): string => `lut3d=file=${escapeFilterPath(path)}:interp=tetrahedral`

/**
 * Apply a pack LUT at `intensity`. Prefers a server-baked LUT (identity-blended cube, a single
 * `lut3d`); otherwise mixes the LUT output with the original via `blend` (normal mode).
 */
export function applyLut(g: Graph, label: string, ref: FilterRef, r: LutResolver): string {
  if (ref.intensity <= 0) return label
  const baked = ref.intensity < 0.999 ? r.resolveLutMix?.(ref.ref, ref.intensity) : undefined
  if (baked) return g.chain(label, [lut3d(baked), 'format=yuv420p'])
  const path = r.resolveLut(ref.ref)
  if (!path) return label
  if (ref.intensity >= 0.999) return g.chain(label, [lut3d(path), 'format=yuv420p'])
  const [orig, src] = g.pair(label)
  const graded = g.chain(src, [lut3d(path), 'format=yuv420p'])
  // blend: out = bottom + (top − bottom) · opacity → graded on top of the original.
  return g.add(
    [graded, orig],
    [filter('blend', { all_mode: 'normal', all_opacity: ref.intensity })],
  )[0]!
}

/** `chromakey` (YUV-domain, produces yuva420p) for an enabled ChromaKey. */
export function chromaKeyFilter(k: ChromaKey | undefined): string | undefined {
  if (!k?.enabled) return undefined
  return filter('chromakey', {
    color: `0x${k.color.slice(1, 7)}`,
    similarity: Math.max(0.01, k.similarity),
    blend: k.blend,
  })
}
