/**
 * The AI-background compositing twin (color/background.ts) against real FFmpeg running the
 * graph shape the export compiler emits: `alphamerge` (matte as alpha) + `overlay` on a
 * background, and `alphamerge` alone for `remove`.
 */
import { describe, expect, it } from 'vitest'
import { coverRect } from '../engine.ts'
import { compositeBackground, matteValue } from './background.ts'
import { ffmpegRaw, HAS_FFMPEG, tempDir } from '../test/ffmpeg.ts'

const W = 64
const H = 48

describe('compositeBackground', () => {
  it('lerps towards the background, and remove premultiplies', () => {
    expect(compositeBackground('color', 0.8, 0.2, 1)).toBeCloseTo(0.8, 9)
    expect(compositeBackground('color', 0.8, 0.2, 0)).toBeCloseTo(0.2, 9)
    expect(compositeBackground('image', 0.8, 0.2, 0.25)).toBeCloseTo(0.35, 9)
    expect(compositeBackground('blur', 0.8, 0.2, 0.5)).toBeCloseTo(0.5, 9)
    expect(compositeBackground('remove', 0.8, 0.2, 0.5)).toBeCloseTo(0.4, 9)
    expect(matteValue(255)).toBe(1)
  })
})

describe('coverRect (image background cover fit)', () => {
  it('crops the long axis symmetrically', () => {
    const r = new Float32Array(4)
    coverRect(9 / 16, 16 / 9, r) // wide image into a tall frame
    expect(r[1]).toBe(0)
    expect(r[3]).toBe(1)
    expect(r[0]).toBeCloseTo((1 - 9 / 16 / (16 / 9)) / 2, 6)
    expect(r[2]! - r[0]!).toBeCloseTo(9 / 16 / (16 / 9), 6)
    coverRect(16 / 9, 9 / 16, r) // tall image into a wide frame
    expect(r[0]).toBe(0)
    expect(r[2]).toBe(1)
    expect(r[3]! - r[1]!).toBeCloseTo(9 / 16 / (16 / 9), 5)
    coverRect(1, 1, r)
    expect([...r]).toEqual([0, 0, 1, 1])
  })
})

describe.skipIf(!HAS_FFMPEG)('FFmpeg alphamerge + overlay equals the twin', () => {
  const frame = (filter: string, inputs: string[]): Uint8Array => {
    const { dir, cleanup } = tempDir()
    try {
      return new Uint8Array(
        ffmpegRaw(
          [
            ...inputs,
            '-filter_complex',
            filter,
            '-map',
            '[o]',
            '-frames:v',
            '1',
            '-f',
            'rawvideo',
            '-pix_fmt',
            'rgb24',
            'pipe:1',
          ],
          dir,
        ),
      )
    } finally {
      cleanup()
    }
  }
  // foreground gradient, matte ramp (gray, 0..255 over x), colour background
  const fg = [
    '-f',
    'lavfi',
    '-i',
    `gradients=s=${W}x${H}:d=1:seed=3:c0=0x204080:c1=0xe0c020:x0=0:y0=0:x1=${W}:y1=${H},format=gbrp`,
  ]
  const matte = ['-f', 'lavfi', '-i', `nullsrc=s=${W}x${H},geq=lum='X*255/${W - 1}',format=gray`]
  const solid = ['-f', 'lavfi', '-i', `color=c=0xff8010:s=${W}x${H}`]

  it('colour/image mode: lerp(background, subject, matte)', () => {
    const out = frame(
      '[0:v]format=gbrp[f];[1:v]format=gray[m];[2:v]format=gbrp[b];[f][m]alphamerge[c];[b][c]overlay=format=gbrp,format=rgb24[o]',
      [...fg, ...matte, ...solid],
    )
    const plain = frame('[0:v]format=rgb24[o]', fg)
    let worst = 0
    for (let y = 0; y < H; y += 3)
      for (let x = 0; x < W; x += 3)
        for (let c = 0; c < 3; c++) {
          const m = matteValue((x * 255) / (W - 1))
          const back = [255, 128, 16][c]! / 255
          const ref = 255 * compositeBackground('color', plain[(y * W + x) * 3 + c]! / 255, back, m)
          worst = Math.max(worst, Math.abs(out[(y * W + x) * 3 + c]! - ref))
        }
    expect(worst).toBeLessThanOrEqual(3)
  })
})
