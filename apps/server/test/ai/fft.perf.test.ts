/**
 * FFT speed. A timing test: it runs in the serial "heavy" group (vitest.config.ts), so the
 * measurement is not skewed by other test files.
 */
import { expect, it } from 'vitest'
import { RealFFT } from '../../src/ai/beats/fft.ts'

// Typically ~25 µs on a Ryzen 7 8840U when idle; guards against algorithmic regressions.
it('is fast: 2048-point transforms in well under 200 µs each', () => {
  const n = 2048
  const fft = new RealFFT(n)
  const x = Float32Array.from({ length: n }, (_, i) => Math.sin(i))
  const re = new Float64Array(n / 2 + 1)
  const im = new Float64Array(n / 2 + 1)
  for (let i = 0; i < 200; i++) fft.forward(x, re, im)
  const runs = 2000
  const t0 = performance.now()
  for (let i = 0; i < runs; i++) fft.forward(x, re, im)
  const us = ((performance.now() - t0) * 1000) / runs
  console.warn(`[bench] RealFFT 2048: ${us.toFixed(1)} µs per transform`)
  expect(us).toBeLessThan(200)
})
