/**
 * YuNet face detector (OpenCV Zoo, 2023mar network) pre/post-processing — a port of OpenCV's
 * `FaceDetectorYN` so we can run the ONNX model directly with onnxruntime.
 *
 * - Input: 1×3×H×W float32, BGR channel order, raw 0..255 values (no mean/std), with H and W
 *   padded up to multiples of 32 (the deepest stride). Padding is zero (black).
 * - Outputs per stride s ∈ {8, 16, 32}, one anchor per grid cell (row-major):
 *   `cls_s`, `obj_s` (N×1), `bbox_s` (N×4: dx, dy, log w, log h in stride units),
 *   `kps_s` (N×10: five landmark offsets in stride units).
 *   score = √(clamp(cls)·clamp(obj)); centre = (col + dx, row + dy)·s; size = e^{log}·s.
 */

export const STRIDES = [8, 16, 32] as const
const ALIGN = 32

/** One detected face in detector-frame pixels (top-left box). */
export interface Face {
  x: number
  y: number
  w: number
  h: number
  score: number
  /** Right eye, left eye, nose tip, right mouth corner, left mouth corner: x0,y0,…,x4,y4. */
  landmarks: Float32Array
}

/** Padded network input size for a frame. */
export const paddedSize = (width: number, height: number): { width: number; height: number } => ({
  width: Math.ceil(width / ALIGN) * ALIGN,
  height: Math.ceil(height / ALIGN) * ALIGN,
})

/**
 * Convert a packed RGB24 frame (FFmpeg `rgb24`/PPM) into the planar BGR float32 network
 * input, zero-padded to `padW`×`padH`. `out` must hold 3·padW·padH floats and is reused
 * across frames: padding cells are zero from allocation and are never written.
 */
export const preprocessRgb = (
  rgb: Uint8Array,
  width: number,
  height: number,
  padW: number,
  padH: number,
  out: Float32Array,
): void => {
  const plane = padW * padH
  for (let y = 0; y < height; y++) {
    let src = y * width * 3
    const row = y * padW
    for (let x = 0; x < width; x++, src += 3) {
      const o = row + x
      out[o] = rgb[src + 2] ?? 0
      out[plane + o] = rgb[src + 1] ?? 0
      out[2 * plane + o] = rgb[src] ?? 0
    }
  }
}

/** Raw output tensors of one inference, keyed by output name (`cls_8`, `bbox_16`, …). */
export type YunetOutputs = Readonly<Record<string, Float32Array | undefined>>

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * Decode raw YuNet outputs into faces above `scoreThreshold` (before NMS). Boxes are clipped
 * to the un-padded frame (`width`×`height`) so padding never contributes to a face.
 */
export const decodeYunet = (
  out: YunetOutputs,
  padW: number,
  padH: number,
  scoreThreshold: number,
  width = padW,
  height = padH,
): Face[] => {
  const faces: Face[] = []
  for (const s of STRIDES) {
    const cls = out[`cls_${s}`]
    const obj = out[`obj_${s}`]
    const bbox = out[`bbox_${s}`]
    const kps = out[`kps_${s}`]
    if (!cls || !obj || !bbox || !kps) throw new Error(`YuNet output for stride ${s} is missing`)
    const cols = padW / s
    const rows = padH / s
    const n = Math.min(cols * rows, cls.length)
    for (let i = 0; i < n; i++) {
      const score = Math.sqrt(clamp01(cls[i] ?? 0) * clamp01(obj[i] ?? 0))
      if (score < scoreThreshold) continue
      const r = Math.floor(i / cols)
      const c = i - r * cols
      const b = i * 4
      const cx = (c + (bbox[b] ?? 0)) * s
      const cy = (r + (bbox[b + 1] ?? 0)) * s
      const w = Math.exp(bbox[b + 2] ?? 0) * s
      const h = Math.exp(bbox[b + 3] ?? 0) * s
      const x0 = Math.max(0, cx - w / 2)
      const y0 = Math.max(0, cy - h / 2)
      const x1 = Math.min(width, cx + w / 2)
      const y1 = Math.min(height, cy + h / 2)
      if (x1 <= x0 || y1 <= y0) continue
      const landmarks = new Float32Array(10)
      const k = i * 10
      for (let j = 0; j < 5; j++) {
        landmarks[2 * j] = ((kps[k + 2 * j] ?? 0) + c) * s
        landmarks[2 * j + 1] = ((kps[k + 2 * j + 1] ?? 0) + r) * s
      }
      faces.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, score, landmarks })
    }
  }
  return faces
}

/** Intersection over union of two boxes. */
export const iou = (
  a: Pick<Face, 'x' | 'y' | 'w' | 'h'>,
  b: Pick<Face, 'x' | 'y' | 'w' | 'h'>,
): number => {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  if (ix <= 0 || iy <= 0) return 0
  const inter = ix * iy
  return inter / (a.w * a.h + b.w * b.h - inter)
}

/** Greedy non-maximum suppression (highest score first), keeping at most `topK` faces. */
export const nms = (faces: readonly Face[], iouThreshold = 0.3, topK = 50): Face[] => {
  const sorted = faces.toSorted((a, b) => b.score - a.score)
  const kept: Face[] = []
  for (const f of sorted) {
    if (kept.length >= topK) break
    if (kept.every((k) => iou(k, f) <= iouThreshold)) kept.push(f)
  }
  return kept
}
