/**
 * Colour management for inputs: HDR (HLG / PQ) → SDR BT.709 tone mapping.
 *
 * Phones record HDR as 10-bit BT.2020 with HLG (`arib-std-b67`) or PQ (`smpte2084`)
 * transfer. Exports are SDR BT.709, so such inputs are linearised, gamut-mapped and
 * tone-mapped (Hable, no desaturation) with zimg. The chain runs AFTER the clip has been
 * scaled to its on-canvas size, so a 4K HDR clip is tone-mapped at canvas resolution.
 */
import type { Asset } from '../schema.ts'

const HDR_TRANSFERS = new Set(['arib-std-b67', 'smpte2084'])

/** True when the asset needs HDR→SDR tone mapping. */
export const isHdr = (asset: Asset): boolean =>
  asset.colorTransfer !== undefined && HDR_TRANSFERS.has(asset.colorTransfer)

/** Tone-mapping filter chain for an HDR input (output: 8-bit BT.709 limited range). */
export function tonemapFilters(asset: Asset): string[] {
  const tin = asset.colorTransfer === 'smpte2084' ? 'smpte2084' : 'arib-std-b67'
  return [
    `zscale=tin=${tin}:pin=bt2020:min=bt2020nc:t=linear:npl=100`,
    'format=gbrpf32le',
    'zscale=p=bt709',
    'tonemap=tonemap=hable:desat=0',
    'zscale=t=bt709:m=bt709:r=tv',
    'format=yuv420p',
  ]
}

/** Display (post-rotation) size of a visual asset, if probed. */
export function displaySize(asset: Asset): { width: number; height: number } | undefined {
  if (!asset.width || !asset.height) return undefined
  const quarterTurns = Math.round((asset.rotation ?? 0) / 90)
  return quarterTurns % 2 !== 0
    ? { width: asset.height, height: asset.width }
    : { width: asset.width, height: asset.height }
}
