/**
 * Matting building blocks without a model: pixel kernels, input sizing, temporal/guided
 * refinement, the FFmpeg writer's argv and payload validation.
 */
import { describe, expect, it } from 'vitest'
import { MattePayloadSchema, parsePayload } from '../../src/ai/payloads.ts'
import {
  boxMean,
  clamp01InPlace,
  resizePlane,
  rgbToTensor,
  toGray8,
} from '../../src/ai/matte/image.ts'
import { matteSize, MATTE_MAX_LONG_SIDE } from '../../src/ai/matte/index.ts'
import { inputSize, MATTE_MODELS } from '../../src/ai/matte/models.ts'
import { guidedFilter, refineMatte, type RefineState } from '../../src/ai/matte/refine.ts'
import { matteWriterArgs } from '../../src/ai/matte/writer.ts'

/** Naive reference box mean (radius r, clipped window). */
const naiveBox = (src: Float32Array, w: number, h: number, r: number): Float32Array => {
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0
      let n = 0
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++)
        for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
          s += src[yy * w + xx]!
          n++
        }
      out[y * w + x] = s / n
    }
  return out
}

const noise = (n: number, seed = 1): Float32Array => {
  const a = new Float32Array(n)
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    a[i] = s / 2 ** 32
  }
  return a
}

describe('image kernels', () => {
  it('boxMean matches the naive window mean, including borders and odd sizes', () => {
    for (const [w, h, r] of [
      [17, 11, 3],
      [8, 8, 1],
      [5, 9, 6],
    ] as const) {
      const src = noise(w * h, w + h)
      const out = new Float32Array(w * h)
      boxMean(src, w, h, r, out, new Float32Array(w * h))
      const ref = naiveBox(src, w, h, r)
      for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(ref[i]!, 4)
    }
  })

  it('resizePlane is identity at equal size and preserves constants and linear ramps', () => {
    const a = noise(6 * 4)
    const same = new Float32Array(24)
    resizePlane(a, 6, 4, 6, 4, same)
    expect([...same]).toEqual([...a])
    const flat = new Float32Array(10 * 10).fill(0.25)
    const up = new Float32Array(30 * 20)
    resizePlane(flat, 10, 10, 30, 20, up)
    for (const v of up) expect(v).toBeCloseTo(0.25, 6)
    const ramp = Float32Array.from({ length: 8 }, (_, i) => i / 7)
    const big = new Float32Array(16)
    resizePlane(ramp, 8, 1, 16, 1, big)
    for (let i = 1; i < 15; i++) expect(big[i]!).toBeGreaterThanOrEqual(big[i - 1]! - 1e-6)
  })

  it('rgbToTensor normalises per channel into planar CHW', () => {
    // 2×2 solid colour frame resized to 4×4
    const rgb = new Uint8Array(2 * 2 * 3)
    for (let i = 0; i < 4; i++) rgb.set([255, 0, 51], i * 3)
    const out = new Float32Array(3 * 16)
    rgbToTensor(rgb, 2, 2, 4, 4, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], out)
    for (let i = 0; i < 16; i++) {
      expect(out[i]).toBeCloseTo(1, 5) // R: (1 - .5)/.5
      expect(out[16 + i]).toBeCloseTo(-1, 5) // G
      expect(out[32 + i]).toBeCloseTo((51 / 255 - 0.5) / 0.5, 5) // B
    }
  })

  it('toGray8 and clamp01 round and clamp', () => {
    const a = Float32Array.from([-1, 0, 0.5, 1, 2])
    const g = new Uint8Array(5)
    toGray8(a, g)
    expect([...g]).toEqual([0, 0, 128, 255, 255])
    clamp01InPlace(a)
    expect([...a]).toEqual([0, 0, 0.5, 1, 1])
  })
})

describe('model input sizing', () => {
  it('MODNet scales the short side to 512 and aligns to 32', () => {
    const s = inputSize(MATTE_MODELS.modnet, 1280, 720)
    expect(s.height).toBe(512)
    expect(s.width % 32).toBe(0)
    expect(Math.abs(s.width / s.height - 1280 / 720)).toBeLessThan(0.05)
    const p = inputSize(MATTE_MODELS.modnet, 720, 1280)
    expect(p).toEqual({ width: s.height, height: s.width })
  })

  it('matteSize caps the long side and keeps even dimensions', () => {
    expect(matteSize(3840, 2160)).toEqual({ width: MATTE_MAX_LONG_SIDE, height: 720 })
    expect(matteSize(1080, 1920).height).toBe(MATTE_MAX_LONG_SIDE)
    const small = matteSize(641, 361)
    expect(small.width % 2).toBe(0)
    expect(small.height % 2).toBe(0)
  })
})

describe('refineMatte', () => {
  const W = 64
  const H = 48
  const frame = (v: number): Uint8Array => new Uint8Array(W * H * 3).fill(v)

  it('averages with the previous frame where the picture is static', () => {
    const state: RefineState = { prev: undefined }
    const a0 = new Float32Array(W * H).fill(1)
    refineMatte(a0, frame(100), W, H, state, { radius: 0, temporal: 0.5 })
    const a1 = new Float32Array(W * H).fill(0)
    refineMatte(a1, frame(100), W, H, state, { radius: 0, temporal: 0.5 })
    expect(a1[0]).toBeCloseTo(0.5, 5)
  })

  it('does not smooth where the picture changed (no ghosting)', () => {
    const state: RefineState = { prev: undefined }
    refineMatte(new Float32Array(W * H).fill(1), frame(50), W, H, state, {
      radius: 0,
      temporal: 0.9,
    })
    const a = new Float32Array(W * H).fill(0)
    refineMatte(a, frame(200), W, H, state, { radius: 0, temporal: 0.9 })
    expect(a[0]).toBe(0)
  })

  it('resets across a frame-size change', () => {
    const state: RefineState = { prev: undefined }
    refineMatte(new Float32Array(W * H).fill(1), frame(10), W, H, state, { radius: 0 })
    const a = new Float32Array(32 * 32).fill(0)
    refineMatte(a, new Uint8Array(32 * 32 * 3).fill(10), 32, 32, state, { radius: 0 })
    expect(a[0]).toBe(0)
  })

  it('guided filter snaps a soft edge to the guide edge and keeps constants', () => {
    const w = 40
    const h = 8
    const guide = new Float32Array(w * h)
    const soft = new Float32Array(w * h)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        guide[y * w + x] = x < 20 ? 0.1 : 0.9 // sharp edge at x = 20
        soft[y * w + x] = Math.min(1, Math.max(0, (x - 14) / 12)) // ramp over x 14..26
      }
    const out = new Float32Array(w * h)
    guidedFilter(
      guide,
      soft,
      w,
      h,
      4,
      1e-4,
      out,
      Array.from({ length: 7 }, () => new Float32Array(w * h)),
    )
    // across the guide edge the output is steeper than the input ramp
    const row = 3 * w
    expect(out[row + 22]! - out[row + 17]!).toBeGreaterThan(soft[row + 22]! - soft[row + 17]!)
    const flat = new Float32Array(w * h).fill(0.3)
    guidedFilter(
      guide,
      flat,
      w,
      h,
      4,
      1e-4,
      out,
      Array.from({ length: 7 }, () => new Float32Array(w * h)),
    )
    for (const v of out) expect(v).toBeCloseTo(0.3, 4)
  })

  it('the subsampled guided filter stays within a few percent of the exact filter', () => {
    const state: RefineState = { prev: undefined }
    const rgb = new Uint8Array(W * H * 3)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) rgb.fill(x < 30 ? 30 : 220, (y * W + x) * 3, (y * W + x) * 3 + 3)
    const base = new Float32Array(W * H)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) base[y * W + x] = Math.min(1, Math.max(0, (x - 24) / 12))
    const exact = refineMatte(
      base.slice(),
      rgb,
      W,
      H,
      { prev: undefined },
      { radius: 3, temporal: 0, subsample: 1 },
    )
    const fast = refineMatte(base.slice(), rgb, W, H, state, {
      radius: 3,
      temporal: 0,
      subsample: 2,
    })
    let worst = 0
    for (let i = 0; i < exact.length; i++) worst = Math.max(worst, Math.abs(exact[i]! - fast[i]!))
    expect(worst).toBeLessThan(0.25)
  })
})

describe('matte writer argv', () => {
  const base = {
    width: 1280,
    height: 720,
    fps: '30',
    output: 'm.mkv',
    proxy: 'p.mp4',
    still: false,
  }
  it('writes lossless FFV1 gray and a 960 px H.264 proxy with a short GOP', () => {
    const a = matteWriterArgs(base)
    expect(a).toContain('ffv1')
    expect(a.join(' ')).toContain('-f rawvideo -pix_fmt gray -s 1280x720 -r 30 -i pipe:0')
    expect(a.join(' ')).toContain('scale=960:540')
    expect(a.join(' ')).toContain('keyint=15')
    expect(a.at(-1)).toBe('p.mp4')
  })
  it('writes a single PNG proxy for stills', () => {
    const a = matteWriterArgs({ ...base, still: true, proxy: 'p.png', fps: '1' })
    expect(a).toContain('image2')
    expect(a).not.toContain('libx264')
    expect(a.at(-1)).toBe('p.png')
  })
})

describe('matte payload', () => {
  it('accepts the documented fields and rejects unknown models / ids', () => {
    expect(
      parsePayload(MattePayloadSchema, { assetId: 'a1', model: 'modnet', force: true }),
    ).toEqual({
      assetId: 'a1',
      model: 'modnet',
      force: true,
    })
    expect(() => parsePayload(MattePayloadSchema, { assetId: 'a1', model: 'x' })).toThrow(
      /invalid payload/,
    )
    expect(() => parsePayload(MattePayloadSchema, { assetId: '../x' })).toThrow(/invalid payload/)
  })
})
