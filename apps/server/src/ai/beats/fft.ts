/**
 * Fast radix-2 FFT with precomputed twiddles and bit-reversal table, plus a real-input
 * transform that runs one half-size complex FFT (2x faster than a complex FFT of the
 * zero-imaginary signal). All buffers are preallocated: no allocation per transform.
 */

/** In-place iterative complex FFT of a fixed power-of-two size. */
export class ComplexFFT {
  readonly size: number
  readonly #cos: Float64Array
  readonly #sin: Float64Array
  readonly #rev: Uint32Array

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0)
      throw new RangeError(`FFT size must be a power of two ≥ 2, got ${size}`)
    this.size = size
    const half = size >> 1
    this.#cos = new Float64Array(half)
    this.#sin = new Float64Array(half)
    for (let i = 0; i < half; i++) {
      const a = (-2 * Math.PI * i) / size
      this.#cos[i] = Math.cos(a)
      this.#sin[i] = Math.sin(a)
    }
    const bits = Math.log2(size)
    this.#rev = new Uint32Array(size)
    for (let i = 0; i < size; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.#rev[i] = r
    }
  }

  /** Forward transform (e^{-2πikn/N}), in place. */
  forward(re: Float64Array, im: Float64Array): void {
    const n = this.size
    const rev = this.#rev
    for (let i = 0; i < n; i++) {
      const j = rev[i] ?? 0
      if (j > i) {
        const tr = re[i] ?? 0
        re[i] = re[j] ?? 0
        re[j] = tr
        const ti = im[i] ?? 0
        im[i] = im[j] ?? 0
        im[j] = ti
      }
    }
    const cos = this.#cos
    const sin = this.#sin
    for (let len = 2; len <= n; len <<= 1) {
      const halfLen = len >> 1
      const step = n / len
      for (let start = 0; start < n; start += len) {
        for (let k = 0, t = 0; k < halfLen; k++, t += step) {
          const wr = cos[t] ?? 0
          const wi = sin[t] ?? 0
          const a = start + k
          const b = a + halfLen
          const br = re[b] ?? 0
          const bi = im[b] ?? 0
          const xr = br * wr - bi * wi
          const xi = br * wi + bi * wr
          const ar = re[a] ?? 0
          const ai = im[a] ?? 0
          re[b] = ar - xr
          im[b] = ai - xi
          re[a] = ar + xr
          im[a] = ai + xi
        }
      }
    }
  }
}

/** Real-input FFT of size N via one complex FFT of size N/2. */
export class RealFFT {
  readonly size: number
  readonly #half: ComplexFFT
  readonly #re: Float64Array
  readonly #im: Float64Array
  readonly #cos: Float64Array
  readonly #sin: Float64Array

  constructor(size: number) {
    if (size < 4 || (size & (size - 1)) !== 0)
      throw new RangeError(`FFT size must be a power of two ≥ 4, got ${size}`)
    this.size = size
    const m = size >> 1
    this.#half = new ComplexFFT(m)
    this.#re = new Float64Array(m)
    this.#im = new Float64Array(m)
    this.#cos = new Float64Array(m + 1)
    this.#sin = new Float64Array(m + 1)
    for (let k = 0; k <= m; k++) {
      this.#cos[k] = Math.cos((2 * Math.PI * k) / size)
      this.#sin[k] = Math.sin((2 * Math.PI * k) / size)
    }
  }

  /**
   * Spectrum of `input` (length N) for bins 0..N/2. Writes real/imag parts into `outRe`/`outIm`
   * (length ≥ N/2+1).
   */
  forward(input: ArrayLike<number>, outRe: Float64Array, outIm: Float64Array): void {
    const m = this.size >> 1
    const re = this.#re
    const im = this.#im
    for (let i = 0; i < m; i++) {
      re[i] = input[2 * i] ?? 0
      im[i] = input[2 * i + 1] ?? 0
    }
    this.#half.forward(re, im)
    const cos = this.#cos
    const sin = this.#sin
    for (let k = 0; k <= m; k++) {
      const a = re[k % m] ?? 0
      const b = im[k % m] ?? 0
      const c = re[(m - k) % m] ?? 0
      const d = im[(m - k) % m] ?? 0
      // Even/odd sub-spectra of the interleaved signal.
      const feR = (a + c) / 2
      const feI = (b - d) / 2
      const foR = (b + d) / 2
      const foI = -(a - c) / 2
      const wc = cos[k] ?? 1
      const ws = sin[k] ?? 0
      // X[k] = Fe + e^{-2πik/N} · Fo
      outRe[k] = feR + wc * foR + ws * foI
      outIm[k] = feI + wc * foI - ws * foR
    }
  }

  /** Magnitude spectrum |X[k]| for k = 0..N/2 into `out`. */
  magnitude(
    input: ArrayLike<number>,
    out: Float32Array,
    scratchRe: Float64Array,
    scratchIm: Float64Array,
  ): void {
    this.forward(input, scratchRe, scratchIm)
    const bins = (this.size >> 1) + 1
    for (let k = 0; k < bins; k++) {
      const r = scratchRe[k] ?? 0
      const i = scratchIm[k] ?? 0
      out[k] = Math.sqrt(r * r + i * i)
    }
  }
}

/** Periodic Hann window (the STFT-friendly variant). */
export const hann = (n: number): Float32Array => {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
  return w
}
