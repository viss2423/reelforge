/**
 * Salient-object fallback for shots with no people and no recognised object: U²-Netp
 * (Qin et al., Pattern Recognition 2020; Apache-2.0, 1.1 M parameters), trained on DUTS
 * for salient object detection.
 *
 * - input [1, 3, 320, 320] RGB, ImageNet mean/std normalised (frame stretched);
 * - first output: the fused saliency map [1, 1, 320, 320], already sigmoid (0..1).
 */
import type { Box } from './planner.ts'

export const SALIENCY_SIZE = 320
const MEAN = [0.485, 0.456, 0.406] as const
const STD = [0.229, 0.224, 0.225] as const

/** Nearest-neighbour resize + ImageNet normalisation into planar [3, 320, 320]. */
export const preprocessSaliency = (
  rgb: Uint8Array,
  width: number,
  height: number,
  out: Float32Array,
): void => {
  const S = SALIENCY_SIZE
  const plane = S * S
  for (let y = 0; y < S; y++) {
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / S))
    for (let x = 0; x < S; x++) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) * width) / S))
      const i = (sy * width + sx) * 3
      const o = y * S + x
      for (let c = 0; c < 3; c++) {
        out[c * plane + o] = ((rgb[i + c] ?? 0) / 255 - (MEAN[c] ?? 0)) / (STD[c] ?? 1)
      }
    }
  }
}

/**
 * Salient region of a map: mass-weighted centre ± 1.5σ over pixels above `threshold`, in
 * frame pixels. `score` is the mean saliency inside the region (0 when nothing stands out).
 */
export const salientBox = (
  map: Float32Array,
  size: number,
  width: number,
  height: number,
  threshold = 0.5,
): Box | undefined => {
  let mass = 0
  let sx = 0
  let sy = 0
  let sxx = 0
  let syy = 0
  let count = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = map[y * size + x] ?? 0
      if (v < threshold) continue
      mass += v
      sx += v * x
      sy += v * y
      sxx += v * x * x
      syy += v * y * y
      count++
    }
  }
  // Ignore specks (< 0.5 % of the frame) and maps where everything is "salient".
  if (count < 0.005 * size * size || count > 0.8 * size * size) return undefined
  const mx = sx / mass
  const my = sy / mass
  const dx = 1.5 * Math.sqrt(Math.max(0, sxx / mass - mx * mx))
  const dy = 1.5 * Math.sqrt(Math.max(0, syy / mass - my * my))
  const kx = width / size
  const ky = height / size
  const x0 = Math.max(0, (mx - dx) * kx)
  const y0 = Math.max(0, (my - dy) * ky)
  const x1 = Math.min(width, (mx + dx + 1) * kx)
  const y1 = Math.min(height, (my + dy + 1) * ky)
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, score: mass / count }
}
