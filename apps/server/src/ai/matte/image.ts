/**
 * Pixel kernels for the matting pipeline, written for V8: flat typed arrays, no allocation
 * in the per-pixel loops, precomputed bilinear tables shared by every row.
 */

/** Bilinear sampling table for one axis: source index pairs and the weight of the second. */
interface Axis {
  i0: Int32Array
  i1: Int32Array
  w: Float32Array
}

const axisCache = new Map<string, Axis>()

/** Half-pixel-centre bilinear mapping from `src` samples to `dst` samples (cached). */
const axis = (src: number, dst: number): Axis => {
  const key = `${src}:${dst}`
  let a = axisCache.get(key)
  if (a) return a
  a = { i0: new Int32Array(dst), i1: new Int32Array(dst), w: new Float32Array(dst) }
  const s = src / dst
  for (let d = 0; d < dst; d++) {
    const x = Math.min(src - 1, Math.max(0, (d + 0.5) * s - 0.5))
    const x0 = Math.floor(x)
    a.i0[d] = x0
    a.i1[d] = Math.min(src - 1, x0 + 1)
    a.w[d] = x - x0
  }
  if (axisCache.size > 64) axisCache.clear()
  axisCache.set(key, a)
  return a
}

/**
 * Resize a packed RGB24 frame to `dw`×`dh` (bilinear) and write the normalised planar CHW
 * network input: `out[c·dw·dh + y·dw + x] = (rgb/255 − mean[c]) / std[c]`.
 */
export const rgbToTensor = (
  rgb: Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  mean: readonly [number, number, number],
  std: readonly [number, number, number],
  out: Float32Array,
): void => {
  const ax = axis(sw, dw)
  const ay = axis(sh, dh)
  const plane = dw * dh
  const sr = 1 / (255 * std[0])
  const sg = 1 / (255 * std[1])
  const sb = 1 / (255 * std[2])
  const or = mean[0] / std[0]
  const og = mean[1] / std[1]
  const ob = mean[2] / std[2]
  for (let y = 0; y < dh; y++) {
    const r0 = ay.i0[y]! * sw * 3
    const r1 = ay.i1[y]! * sw * 3
    const wy = ay.w[y]!
    const row = y * dw
    for (let x = 0; x < dw; x++) {
      const c0 = ax.i0[x]! * 3
      const c1 = ax.i1[x]! * 3
      const wx = ax.w[x]!
      const a = r0 + c0
      const b = r0 + c1
      const c = r1 + c0
      const d = r1 + c1
      const w00 = (1 - wx) * (1 - wy)
      const w01 = wx * (1 - wy)
      const w10 = (1 - wx) * wy
      const w11 = wx * wy
      const o = row + x
      out[o] = (rgb[a]! * w00 + rgb[b]! * w01 + rgb[c]! * w10 + rgb[d]! * w11) * sr - or
      out[plane + o] =
        (rgb[a + 1]! * w00 + rgb[b + 1]! * w01 + rgb[c + 1]! * w10 + rgb[d + 1]! * w11) * sg - og
      out[2 * plane + o] =
        (rgb[a + 2]! * w00 + rgb[b + 2]! * w01 + rgb[c + 2]! * w10 + rgb[d + 2]! * w11) * sb - ob
    }
  }
}

/** Bilinear resize of a single-channel float plane. */
export const resizePlane = (
  src: Float32Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  out: Float32Array,
): void => {
  if (sw === dw && sh === dh) {
    out.set(src.subarray(0, dw * dh))
    return
  }
  const ax = axis(sw, dw)
  const ay = axis(sh, dh)
  for (let y = 0; y < dh; y++) {
    const r0 = ay.i0[y]! * sw
    const r1 = ay.i1[y]! * sw
    const wy = ay.w[y]!
    const row = y * dw
    for (let x = 0; x < dw; x++) {
      const i0 = ax.i0[x]!
      const i1 = ax.i1[x]!
      const wx = ax.w[x]!
      const top = src[r0 + i0]! * (1 - wx) + src[r0 + i1]! * wx
      const bot = src[r1 + i0]! * (1 - wx) + src[r1 + i1]! * wx
      out[row + x] = top + (bot - top) * wy
    }
  }
}

/** In-place logistic sigmoid. */
export const sigmoidInPlace = (a: Float32Array): void => {
  for (let i = 0; i < a.length; i++) a[i] = 1 / (1 + Math.exp(-a[i]!))
}

/** In-place clamp to 0..1. */
export const clamp01InPlace = (a: Float32Array): void => {
  for (let i = 0; i < a.length; i++) {
    const v = a[i]!
    a[i] = v < 0 ? 0 : v > 1 ? 1 : v
  }
}

/** Rec.601 luma (0..1) of a packed RGB24 frame. */
export const rgbLuma = (rgb: Uint8Array, out: Float32Array): void => {
  const n = out.length
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    out[i] = (rgb[p]! * 0.299 + rgb[p + 1]! * 0.587 + rgb[p + 2]! * 0.114) / 255
  }
}

const recipCache = new Map<string, Float32Array>()

/** 1 / window size of a radius-r box at each index of an n-long axis (clipped at the ends). */
const recip = (n: number, r: number): Float32Array => {
  const key = `${n}:${r}`
  let a = recipCache.get(key)
  if (a) return a
  a = new Float32Array(n)
  for (let i = 0; i < n; i++) a[i] = 1 / (Math.min(i + r, n - 1) - Math.max(i - r, 0) + 1)
  if (recipCache.size > 32) recipCache.clear()
  recipCache.set(key, a)
  return a
}

/** Column running sums for {@link boxMean}'s vertical pass (reused). */
let colSums = new Float32Array(0)

/**
 * Box mean with radius r (window (2r+1)², clipped at the borders): running sums along rows,
 * then along columns processed row by row (sequential memory access). `tmp` must hold w·h
 * floats.
 */
export const boxMean = (
  src: Float32Array,
  w: number,
  h: number,
  r: number,
  out: Float32Array,
  tmp: Float32Array,
): void => {
  const rx = recip(w, r)
  const ry = recip(h, r)
  for (let y = 0; y < h; y++) {
    const row = y * w
    let acc = 0
    for (let x = 0, e = Math.min(r, w - 1); x <= e; x++) acc += src[row + x]!
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * rx[x]!
      const add = x + r + 1
      const sub = x - r
      if (add < w) acc += src[row + add]!
      if (sub >= 0) acc -= src[row + sub]!
    }
  }
  if (colSums.length < w) colSums = new Float32Array(w)
  const col = colSums
  col.fill(0, 0, w)
  for (let y = 0, e = Math.min(r, h - 1); y <= e; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) col[x] = col[x]! + tmp[row + x]!
  }
  for (let y = 0; y < h; y++) {
    const row = y * w
    const k = ry[y]!
    for (let x = 0; x < w; x++) out[row + x] = col[x]! * k
    const add = y + r + 1
    const sub = y - r
    if (add < h) {
      const a = add * w
      for (let x = 0; x < w; x++) col[x] = col[x]! + tmp[a + x]!
    }
    if (sub >= 0) {
      const b = sub * w
      for (let x = 0; x < w; x++) col[x] = col[x]! - tmp[b + x]!
    }
  }
}

/** Float alpha 0..1 → 8-bit gray. */
export const toGray8 = (a: Float32Array, out: Uint8Array): void => {
  for (let i = 0; i < a.length; i++) {
    const v = a[i]!
    out[i] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0
  }
}
