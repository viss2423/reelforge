/**
 * Matte post-processing between the network and the encoder:
 *
 * 1. **Motion-adaptive temporal smoothing.** Per pixel, the new alpha is blended with the
 *    previous frame's refined alpha by a weight that falls to zero where the image changed
 *    (luma difference), so static regions stop flickering while moving edges never ghost.
 * 2. Optional **fast guided filter** (He & Sun, 2015) with the frame's luma as the guide
 *    (off by default, see `RefineOptions.radius`).
 */
import { boxMean, clamp01InPlace, resizePlane, rgbLuma } from './image.ts'

export interface RefineOptions {
  /** Max weight of the previous frame in static regions (0 disables; default 0.4). */
  temporal?: number
  /** Luma change (0..1) at which a pixel counts as fully moving (default 0.08). */
  motion?: number
  /**
   * Guided-filter radius in px (0 disables, the default). Measured on the benchmark set it
   * made the matte WORSE (SAD 0.70 → 1.4, dtSSD 3.4 → 4.0): MODNet's output is already
   * sharp at its working resolution, so the filter only trades accuracy for blur. Kept as an
   * option for models with soft output.
   */
  radius?: number
  /** Guided-filter regularisation ε (default 1e-4: edge-preserving). */
  eps?: number
  /** Subsampling of the coefficient solve (default 2; 1 = exact full-resolution filter). */
  subsample?: number
}

/** Per-clip state carried between frames; start with `{ prev: undefined }`. */
export interface RefineState {
  prev:
    | {
        alpha: Float32Array
        luma: Float32Array
        w: number
        h: number
      }
    | undefined
  /** Reused luma plane (reallocated when the frame size changes). */
  luma?: Float32Array
  /** Reused guided-filter planes (only allocated when the filter is enabled). */
  scratch?: { key: string; planes: Float32Array[] }
}

const planes = (state: RefineState, key: string, sizes: readonly number[]): Float32Array[] => {
  if (state.scratch?.key !== key)
    state.scratch = { key, planes: sizes.map((n) => new Float32Array(n)) }
  return state.scratch.planes
}

/** Guided-filter coefficients a, b (in `t[5]`, `t[6]`) of guide `I` and input `p`, both w×h. */
const solveCoefficients = (
  I: Float32Array,
  p: Float32Array,
  w: number,
  h: number,
  r: number,
  eps: number,
  t: readonly Float32Array[],
): void => {
  const [meanI, meanP, corrI, corrIp, tmp, a, b] = t
  if (!meanI || !meanP || !corrI || !corrIp || !tmp || !a || !b) throw new Error('scratch')
  const n = w * h
  boxMean(I, w, h, r, meanI, tmp)
  boxMean(p, w, h, r, meanP, tmp)
  for (let i = 0; i < n; i++) {
    const iv = I[i]!
    a[i] = iv * iv
    b[i] = iv * p[i]!
  }
  boxMean(a, w, h, r, corrI, tmp)
  boxMean(b, w, h, r, corrIp, tmp)
  for (let i = 0; i < n; i++) {
    const mi = meanI[i]!
    const mp = meanP[i]!
    const av = (corrIp[i]! - mi * mp) / (corrI[i]! - mi * mi + eps)
    a[i] = av
    b[i] = mp - av * mi
  }
  boxMean(a, w, h, r, corrI, tmp)
  boxMean(b, w, h, r, corrIp, tmp)
}

/** Exact (full-resolution) guided filter of `p` with guide `I`; `t` = 7 planes of w·h. */
export const guidedFilter = (
  I: Float32Array,
  p: Float32Array,
  w: number,
  h: number,
  r: number,
  eps: number,
  out: Float32Array,
  t: Float32Array[],
): void => {
  solveCoefficients(I, p, w, h, r, eps, t)
  const [, , meanA, meanB] = t
  for (let i = 0; i < w * h; i++) out[i] = meanA![i]! * I[i]! + meanB![i]!
}

/** 2^k-fold box downsample (each output pixel averages a `s`×`s` block, clipped at edges). */
const downsample = (
  src: Float32Array,
  w: number,
  h: number,
  s: number,
  lw: number,
  lh: number,
  out: Float32Array,
): void => {
  for (let y = 0; y < lh; y++) {
    const y1 = Math.min(h, (y + 1) * s)
    for (let x = 0; x < lw; x++) {
      const x1 = Math.min(w, (x + 1) * s)
      let acc = 0
      let n = 0
      for (let yy = y * s; yy < y1; yy++) {
        const row = yy * w
        for (let xx = x * s; xx < x1; xx++) {
          acc += src[row + xx]!
          n++
        }
      }
      out[y * lw + x] = acc / n
    }
  }
}

/**
 * Refine one frame's alpha (w×h, modified in place and returned) using its RGB24 frame.
 * Carries temporal state in `state`.
 */
export const refineMatte = (
  alpha: Float32Array,
  rgb: Uint8Array,
  w: number,
  h: number,
  state: RefineState,
  o: RefineOptions = {},
): Float32Array => {
  const n = w * h
  const s = Math.max(1, Math.min(4, Math.round(o.subsample ?? 2)))
  const lw = Math.ceil(w / s)
  const lh = Math.ceil(h / s)
  const ln = lw * lh
  if (state.luma?.length !== n) state.luma = new Float32Array(n)
  const luma = state.luma
  rgbLuma(rgb, luma)
  const k = o.temporal ?? 0.4
  const motion = o.motion ?? 0.08
  const prev = state.prev?.w === w && state.prev.h === h ? state.prev : undefined
  if (prev && k > 0) {
    const pa = prev.alpha
    const pl = prev.luma
    const inv = 1 / motion
    for (let i = 0; i < n; i++) {
      const m = Math.abs(luma[i]! - pl[i]!) * inv
      const wgt = m >= 1 ? 0 : k * (1 - m)
      alpha[i] = alpha[i]! * (1 - wgt) + pa[i]! * wgt
    }
  }
  const r = o.radius ?? 0
  if (r > 0) {
    const eps = o.eps ?? 1e-4
    const sizes = s === 1 ? Array<number>(8).fill(n) : [n, n, ...Array<number>(9).fill(ln)]
    const [ia, ib, ...low] = planes(state, `${w}x${h}x${s}`, sizes) as [
      Float32Array,
      Float32Array,
      ...Float32Array[],
    ]
    if (s === 1) {
      guidedFilter(luma, alpha, w, h, r, eps, ia, [ib, ...low])
      alpha.set(ia)
    } else {
      const [lI, lP, ...rest] = low as [Float32Array, Float32Array, ...Float32Array[]]
      downsample(luma, w, h, s, lw, lh, lI)
      downsample(alpha, w, h, s, lw, lh, lP)
      // coefficient planes: reuse 7 low-res planes (rest[0..6] = meanI..b); results in 2,3
      solveCoefficients(lI, lP, lw, lh, Math.max(1, Math.round(r / s)), eps, rest)
      resizePlane(rest[2]!, lw, lh, w, h, ia)
      resizePlane(rest[3]!, lw, lh, w, h, ib)
      for (let i = 0; i < n; i++) alpha[i] = ia[i]! * luma[i]! + ib[i]!
    }
    clamp01InPlace(alpha)
  }
  if (prev) {
    prev.alpha.set(alpha)
    prev.luma.set(luma)
  } else {
    state.prev = { alpha: alpha.slice(), luma: luma.slice(), w, h }
  }
  return alpha
}
