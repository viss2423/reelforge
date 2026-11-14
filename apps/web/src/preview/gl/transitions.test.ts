import { TransitionType } from '@reelforge/core'
import { describe, expect, it } from 'vitest'
import { HAS_FFMPEG, ffmpegRaw } from '../test/ffmpeg.ts'
import {
  TRANSITION_GLSL,
  TRANSITION_ID,
  frand,
  hblurApprox,
  transitionRef,
  type TransitionInputs,
} from './transitions.ts'

const W = 64
const H = 48
const FPS = 10

const plane = (f: (x: number, y: number) => number): Uint8Array => {
  const p = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) p[y * W + x] = f(x, y)
  return p
}
const inputs = (a: Uint8Array, b: Uint8Array): TransitionInputs => ({
  w: W,
  h: H,
  max: 255,
  a: (x, y) => a[y * W + x]!,
  b: (x, y) => b[y * W + x]!,
})

const STANDARD = TransitionType.options.filter(
  (t) => !['whip', 'flash', 'glitch', 'spin'].includes(t),
)

describe('transition reference', () => {
  const A = plane((x, y) => (x * 7 + y * 3) % 256)
  const B = plane((x, y) => 255 - ((x * 5 + y * 11) % 256))
  const I = inputs(A, B)

  it('every type is pure A at progress 1 and pure B at progress 0 (where defined)', () => {
    for (const t of TransitionType.options) {
      if (t === 'squeezeh' || t === 'squeezev') continue // xfade divides by progress
      if (t === 'whip' || t === 'spin' || t === 'glitch') continue // checked below
      for (let y = 1; y < H; y += 7) {
        for (let x = 1; x < W; x += 5) {
          expect(transitionRef(t, I, x, y, 0, 1), `${t} A`).toBeCloseTo(A[y * W + x]!, 6)
          // xfade itself never fully reaches B for these at the last sample
          if (t === 'hblur' || t === 'pixelize' || t === 'radial') continue
          expect(transitionRef(t, I, x, y, 0, 0), `${t} B`).toBeCloseTo(B[y * W + x]!, 6)
        }
      }
    }
  })

  it('trend transitions start on A and end on B', () => {
    for (const t of ['whip', 'spin', 'glitch', 'flash'] as const) {
      expect(transitionRef(t, I, 10, 10, 0, 1)).toBeCloseTo(A[10 * W + 10]!, 6)
      expect(transitionRef(t, I, 10, 10, 0, 0)).toBeCloseTo(B[10 * W + 10]!, 6)
    }
    // flash peaks at white mid-way
    expect(transitionRef('flash', I, 3, 3, 0, 0.5)).toBeCloseTo(255, 6)
  })

  it('frand is in [0,1)', () => {
    for (let i = 0; i < 1000; i++) {
      const r = frand(i % 97, (i * 13) % 211)
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThan(1)
    }
  })

  it('GPU hblur approximation stays close to the exact running box', () => {
    const smooth = inputs(
      plane((x, y) => 128 + 100 * Math.sin(x / 6) * Math.cos(y / 9)),
      plane((x, y) => 128 + 90 * Math.cos(x / 5 + y / 13)),
    )
    let worst = 0
    for (const p of [0.9, 0.75, 0.5, 0.25]) {
      for (let y = 0; y < H; y += 3) {
        for (let x = 0; x < W; x++) {
          const d = Math.abs(
            hblurApprox(smooth, x, y, 0, p) - transitionRef('hblur', smooth, x, y, 0, p),
          )
          worst = Math.max(worst, d)
        }
      }
    }
    expect(worst).toBeLessThan(3)
  })

  it('GLSL has a case for every transition id', () => {
    for (const t of TransitionType.options) {
      expect(TRANSITION_GLSL, `GLSL case for ${t}`).toContain(`case ${TRANSITION_ID[t]}:`)
    }
  })
})

describe.skipIf(!HAS_FFMPEG)('transition reference vs FFmpeg xfade', () => {
  const src = (expr: string) => `nullsrc=s=${W}x${H}:r=${FPS}:d=2,format=gray,geq=lum='${expr}'`
  const aExpr = 'mod(X*7+Y*3\\,256)'
  const bExpr = '128+100*sin(X/5)*cos(Y/7)'

  /** Run xfade (1 s at offset 1 s) and return all output frames as gray planes. */
  const run = (t: TransitionType): Uint8Array[] => {
    const raw = ffmpegRaw([
      '-f',
      'lavfi',
      '-i',
      src(aExpr),
      '-f',
      'lavfi',
      '-i',
      src(bExpr),
      '-filter_complex',
      `[0][1]xfade=transition=${t}:duration=1:offset=1,format=gray`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      'pipe:1',
    ])
    const frames: Uint8Array[] = []
    for (let o = 0; o + W * H <= raw.byteLength; o += W * H) {
      frames.push(new Uint8Array(raw.buffer, raw.byteOffset + o, W * H))
    }
    return frames
  }

  it.each(STANDARD)('%s matches xfade within 1 LSB', (t) => {
    const frames = run(t)
    expect(frames.length).toBe(3 * FPS)
    const I = inputs(frames[0]!, frames[frames.length - 1]!)
    let bad = 0
    let total = 0
    for (const k of [1, 3, 5, 7, 9]) {
      // xfade computes progress in float32: 1.f - (float)k / n
      const progress = Math.fround(1 - Math.fround(k / FPS))
      const out = frames[FPS + k]!
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const ref = Math.trunc(Math.min(255, Math.max(0, transitionRef(t, I, x, y, 0, progress))))
          if (Math.abs(ref - out[y * W + x]!) > 1) bad++
          total++
        }
      }
    }
    // dissolve's float32 sin hash may flip a handful of threshold pixels between libm builds
    expect(bad / total).toBeLessThanOrEqual(t === 'dissolve' ? 0.01 : 0.001)
  })
})
