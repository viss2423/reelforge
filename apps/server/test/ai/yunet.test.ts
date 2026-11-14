import { describe, expect, it } from 'vitest'
import {
  decodeYunet,
  iou,
  nms,
  paddedSize,
  preprocessRgb,
  STRIDES,
  type Face,
} from '../../src/ai/reframe/yunet.ts'

/** Zeroed YuNet outputs for a padded input size. */
const emptyOutputs = (padW: number, padH: number): Record<string, Float32Array> => {
  const out: Record<string, Float32Array> = {}
  for (const s of STRIDES) {
    const n = (padW / s) * (padH / s)
    out[`cls_${s}`] = new Float32Array(n)
    out[`obj_${s}`] = new Float32Array(n)
    out[`bbox_${s}`] = new Float32Array(n * 4)
    out[`kps_${s}`] = new Float32Array(n * 10)
  }
  return out
}

/** Write one anchor's raw values. */
const setAnchor = (
  out: Record<string, Float32Array>,
  stride: number,
  idx: number,
  v: { cls: number; obj: number; bbox: [number, number, number, number]; kps?: number[] },
): void => {
  out[`cls_${stride}`]![idx] = v.cls
  out[`obj_${stride}`]![idx] = v.obj
  out[`bbox_${stride}`]!.set(v.bbox, idx * 4)
  if (v.kps) out[`kps_${stride}`]!.set(v.kps, idx * 10)
}

const box = (x: number, y: number, w: number, h: number, score = 0.9): Face => ({
  x,
  y,
  w,
  h,
  score,
  landmarks: new Float32Array(10),
})

describe('paddedSize', () => {
  it('pads to multiples of 32', () => {
    expect(paddedSize(320, 180)).toEqual({ width: 320, height: 192 })
    expect(paddedSize(320, 568)).toEqual({ width: 320, height: 576 })
    expect(paddedSize(1, 1)).toEqual({ width: 32, height: 32 })
  })
})

describe('preprocessRgb', () => {
  it('converts packed RGB to planar BGR floats and leaves padding at zero', () => {
    const rgb = Uint8Array.from([10, 20, 30, 40, 50, 60]) // 2×1 image
    const out = new Float32Array(3 * 32 * 32)
    preprocessRgb(rgb, 2, 1, 32, 32, out)
    const plane = 32 * 32
    expect([out[0], out[1]]).toEqual([30, 60]) // B
    expect([out[plane], out[plane + 1]]).toEqual([20, 50]) // G
    expect([out[2 * plane], out[2 * plane + 1]]).toEqual([10, 40]) // R
    expect(out[2]).toBe(0)
    expect(out[32]).toBe(0)
  })
})

describe('decodeYunet', () => {
  it('decodes score, box and landmarks for every stride', () => {
    const out = emptyOutputs(64, 64)
    // stride 8: 8 columns; anchor at row 1, col 2.
    setAnchor(out, 8, 1 * 8 + 2, {
      cls: 0.81,
      obj: 1.2, // clamped to 1
      bbox: [0.5, 0.5, Math.log(2), Math.log(3)],
      kps: [0.1, 0.2, 0, 0, 0, 0, 0, 0, 0, 0],
    })
    // stride 32: 2×2 grid; anchor at row 1, col 1.
    setAnchor(out, 32, 3, { cls: 0.64, obj: 0.64, bbox: [0, 0, 0, 0] })
    const faces = decodeYunet(out, 64, 64, 0.5)
    expect(faces).toHaveLength(2)
    const [a, b] = faces
    expect(a!.score).toBeCloseTo(0.9, 6)
    // centre (2.5, 1.5)·8 = (20, 12); size 16×24 → y clipped at 0.
    ;[12, 0, 16, 24].forEach((v, i) => expect([a!.x, a!.y, a!.w, a!.h][i]).toBeCloseTo(v, 5))
    expect(a!.landmarks[0]).toBeCloseTo(16.8, 5)
    expect(a!.landmarks[1]).toBeCloseTo(9.6, 5)
    expect(b!.score).toBeCloseTo(0.64, 6)
    ;[16, 16, 32, 32].forEach((v, i) => expect([b!.x, b!.y, b!.w, b!.h][i]).toBeCloseTo(v, 5))
  })

  it('applies the score threshold and clips boxes to the un-padded frame', () => {
    const out = emptyOutputs(64, 64)
    setAnchor(out, 8, 0, { cls: 0.3, obj: 0.3, bbox: [0, 0, 0, 0] })
    setAnchor(out, 16, 3, { cls: 1, obj: 1, bbox: [1, 1, Math.log(4), Math.log(4)] })
    const faces = decodeYunet(out, 64, 64, 0.5, 50, 40)
    expect(faces).toHaveLength(1)
    const f = faces[0]!
    expect(f.x + f.w).toBeLessThanOrEqual(50)
    expect(f.y + f.h).toBeLessThanOrEqual(40)
  })

  it('drops boxes that fall entirely inside the padding', () => {
    const out = emptyOutputs(64, 64)
    setAnchor(out, 8, 7 * 8 + 7, { cls: 1, obj: 1, bbox: [0.5, 0.5, 0, 0] })
    expect(decodeYunet(out, 64, 64, 0.5, 32, 32)).toEqual([])
  })

  it('fails loudly on a model with unexpected outputs', () => {
    const out = emptyOutputs(32, 32)
    delete out.kps_16
    expect(() => decodeYunet(out, 32, 32, 0.5)).toThrow(/stride 16/)
  })
})

describe('iou / nms', () => {
  it('computes intersection over union', () => {
    expect(iou(box(0, 0, 10, 10), box(0, 0, 10, 10))).toBe(1)
    expect(iou(box(0, 0, 10, 10), box(5, 0, 10, 10))).toBeCloseTo(50 / 150, 6)
    expect(iou(box(0, 0, 10, 10), box(10, 0, 10, 10))).toBe(0)
  })

  it('keeps the best of overlapping boxes and every separate face', () => {
    const kept = nms([
      box(0, 0, 10, 10, 0.7),
      box(1, 1, 10, 10, 0.95),
      box(50, 50, 10, 10, 0.8),
      box(2, 0, 10, 10, 0.9),
    ])
    expect(kept.map((f) => f.score)).toEqual([0.95, 0.8])
  })

  it('respects the IoU threshold and topK', () => {
    const faces = [box(0, 0, 10, 10, 0.9), box(5, 0, 10, 10, 0.8)] // IoU 0.33
    expect(nms(faces, 0.3)).toHaveLength(1)
    expect(nms(faces, 0.5)).toHaveLength(2)
    const many = Array.from({ length: 10 }, (_, i) => box(i * 20, 0, 10, 10, 1 - i / 100))
    expect(nms(many, 0.3, 3)).toHaveLength(3)
    expect(nms([])).toEqual([])
  })
})
