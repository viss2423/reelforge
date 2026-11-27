/**
 * Object detection for auto-reframe with D-FINE (Peng et al., ICLR 2025; Apache-2.0), a
 * real-time DETR: no anchors and no NMS — the network emits 300 queries with per-class
 * scores. We use the COCO-trained nano model (4 M parameters, 42.8 AP) through its
 * Hugging Face / transformers ONNX export:
 *
 * - input `pixel_values` [1, 3, S, S] RGB scaled to 0..1 (no mean/std), the frame
 *   stretched to the square network size (as the reference processor does);
 * - outputs `logits` [1, 300, 80] (sigmoid → score) and `pred_boxes` [1, 300, 4]
 *   (cx, cy, w, h relative to the frame).
 */

/** One detection in frame pixels (top-left box). */
export interface Detection {
  x: number
  y: number
  w: number
  h: number
  score: number
  /** COCO-80 class index (0 = person). */
  label: number
}

export const PERSON = 0
/** COCO classes worth framing when nobody is in shot (animals, vehicles, sports balls…). */
export const SALIENT_CLASSES: ReadonlySet<number> = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 32, 37,
])

/**
 * Bilinear resize of a packed RGB24 frame into a planar float32 [3, size, size] tensor
 * scaled to 0..1. `out` (3·size² floats) is reused across frames.
 */
export const preprocessDetr = (
  rgb: Uint8Array,
  width: number,
  height: number,
  size: number,
  out: Float32Array,
): void => {
  const plane = size * size
  const sx = width / size
  const sy = height / size
  const k = 1 / 255
  for (let y = 0; y < size; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5)
    const y0 = Math.min(height - 1, Math.floor(fy))
    const y1 = Math.min(height - 1, y0 + 1)
    const wy = fy - y0
    for (let x = 0; x < size; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5)
      const x0 = Math.min(width - 1, Math.floor(fx))
      const x1 = Math.min(width - 1, x0 + 1)
      const wx = fx - x0
      const a = (y0 * width + x0) * 3
      const b = (y0 * width + x1) * 3
      const c = (y1 * width + x0) * 3
      const d = (y1 * width + x1) * 3
      const o = y * size + x
      for (let ch = 0; ch < 3; ch++) {
        const top = (rgb[a + ch] ?? 0) * (1 - wx) + (rgb[b + ch] ?? 0) * wx
        const bottom = (rgb[c + ch] ?? 0) * (1 - wx) + (rgb[d + ch] ?? 0) * wx
        out[ch * plane + o] = (top * (1 - wy) + bottom * wy) * k
      }
    }
  }
}

const sigmoid = (v: number): number => 1 / (1 + Math.exp(-v))

/**
 * Decode DETR outputs: the best class per query above `threshold`, boxes scaled to the
 * frame and clipped. Queries are independent, so no NMS is needed; near-duplicates (rare
 * with D-FINE) are removed with a strict IoU > 0.85 merge.
 */
export const decodeDetr = (
  logits: Float32Array,
  boxes: Float32Array,
  classes: number,
  width: number,
  height: number,
  threshold: number,
): Detection[] => {
  const queries = Math.floor(boxes.length / 4)
  const out: Detection[] = []
  // Compare logits, not probabilities: sigmoid is monotonic.
  const minLogit = Math.log(threshold / (1 - threshold))
  for (let q = 0; q < queries; q++) {
    let best = -Infinity
    let label = -1
    const base = q * classes
    for (let c = 0; c < classes; c++) {
      const v = logits[base + c] ?? -Infinity
      if (v > best) {
        best = v
        label = c
      }
    }
    if (best < minLogit) continue
    const cx = (boxes[q * 4] ?? 0) * width
    const cy = (boxes[q * 4 + 1] ?? 0) * height
    const bw = (boxes[q * 4 + 2] ?? 0) * width
    const bh = (boxes[q * 4 + 3] ?? 0) * height
    const x0 = Math.max(0, cx - bw / 2)
    const y0 = Math.max(0, cy - bh / 2)
    const x1 = Math.min(width, cx + bw / 2)
    const y1 = Math.min(height, cy + bh / 2)
    if (x1 <= x0 || y1 <= y0) continue
    out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, score: sigmoid(best), label })
  }
  out.sort((a, b) => b.score - a.score)
  const kept: Detection[] = []
  for (const d of out) {
    if (!kept.some((k) => k.label === d.label && boxIou(k, d) > 0.85)) kept.push(d)
  }
  return kept
}

/** Intersection over union of two boxes. */
export const boxIou = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number => {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  if (ix <= 0 || iy <= 0) return 0
  const inter = ix * iy
  return inter / (a.w * a.h + b.w * b.h - inter)
}
