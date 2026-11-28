import { describe, expect, it } from 'vitest'
import { ComplexFFT, hann, RealFFT } from '../../src/ai/beats/fft.ts'
import { rng } from './helpers.ts'

/** O(n²) reference DFT. */
const naiveDft = (
  re: ArrayLike<number>,
  im: ArrayLike<number>,
): { re: Float64Array; im: Float64Array } => {
  const n = re.length
  const outRe = new Float64Array(n)
  const outIm = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    let sr = 0
    let si = 0
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n
      const xr = re[t] ?? 0
      const xi = im[t] ?? 0
      sr += xr * Math.cos(a) - xi * Math.sin(a)
      si += xr * Math.sin(a) + xi * Math.cos(a)
    }
    outRe[k] = sr
    outIm[k] = si
  }
  return { re: outRe, im: outIm }
}

const maxAbsDiff = (a: ArrayLike<number>, b: ArrayLike<number>, n = a.length): number => {
  let m = 0
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs((a[i] ?? 0) - (b[i] ?? 0)))
  return m
}

describe('ComplexFFT', () => {
  for (const n of [2, 4, 8, 64, 512, 2048]) {
    it(`matches the naive DFT for n=${n}`, () => {
      const rand = rng(n)
      const re = Float64Array.from({ length: n }, () => rand() * 2 - 1)
      const im = Float64Array.from({ length: n }, () => rand() * 2 - 1)
      const ref = naiveDft(re, im)
      new ComplexFFT(n).forward(re, im)
      const tol = 1e-9 * n
      expect(maxAbsDiff(re, ref.re)).toBeLessThan(tol)
      expect(maxAbsDiff(im, ref.im)).toBeLessThan(tol)
    })
  }

  it('transforms an impulse into a flat spectrum', () => {
    const re = new Float64Array(16)
    const im = new Float64Array(16)
    re[0] = 1
    new ComplexFFT(16).forward(re, im)
    for (let k = 0; k < 16; k++) {
      expect(re[k]).toBeCloseTo(1, 12)
      expect(im[k]).toBeCloseTo(0, 12)
    }
  })

  it('rejects sizes that are not powers of two', () => {
    expect(() => new ComplexFFT(12)).toThrow(RangeError)
    expect(() => new ComplexFFT(1)).toThrow(RangeError)
  })
})

describe('RealFFT', () => {
  for (const n of [4, 8, 256, 2048]) {
    it(`matches the naive DFT on real input for n=${n}`, () => {
      const rand = rng(1000 + n)
      const x = Float32Array.from({ length: n }, () => rand() * 2 - 1)
      const ref = naiveDft(x, new Float64Array(n))
      const re = new Float64Array(n / 2 + 1)
      const im = new Float64Array(n / 2 + 1)
      new RealFFT(n).forward(x, re, im)
      const tol = 1e-5 * n // float32 input
      expect(maxAbsDiff(re, ref.re, n / 2 + 1)).toBeLessThan(tol)
      expect(maxAbsDiff(im, ref.im, n / 2 + 1)).toBeLessThan(tol)
    })
  }

  it('puts a pure tone into its bin with the expected magnitude', () => {
    const n = 1024
    const bin = 37
    const x = Float32Array.from({ length: n }, (_, t) => Math.cos((2 * Math.PI * bin * t) / n))
    const mag = new Float32Array(n / 2 + 1)
    new RealFFT(n).magnitude(x, mag, new Float64Array(n / 2 + 1), new Float64Array(n / 2 + 1))
    expect(mag[bin]).toBeCloseTo(n / 2, 1)
    expect(mag[bin + 3]).toBeLessThan(1e-2)
  })

  it('rejects invalid sizes', () => {
    expect(() => new RealFFT(2)).toThrow(RangeError)
    expect(() => new RealFFT(100)).toThrow(RangeError)
  })
})

describe('hann', () => {
  it('is the periodic Hann window', () => {
    const w = hann(8)
    expect(w[0]).toBe(0)
    expect(w[4]).toBeCloseTo(1, 6)
    expect(w[2]).toBeCloseTo(0.5, 6)
    expect(w[6]).toBeCloseTo(0.5, 6)
  })
})
