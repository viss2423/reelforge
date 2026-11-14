import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ffmpegRaw, HAS_FFMPEG, tempDir } from '../test/ffmpeg.ts'
import { CubeParseError, parseCube, sampleTetrahedral } from './cube.ts'

/** A deliberately non-separable "film look" so interpolation differences would show. */
function makeCube(size: number): string {
  const lines = ['# test lut', 'TITLE "Test Look"', `LUT_3D_SIZE ${size}`, '']
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const R = r / (size - 1)
        const G = g / (size - 1)
        const B = b / (size - 1)
        const out = [
          Math.min(1, R ** 0.85 * 0.9 + 0.1 * G),
          Math.min(1, G * 0.95 + 0.05 * R * B),
          Math.min(1, B ** 1.2 * 0.8 + 0.15 * (1 - R)),
        ]
        lines.push(out.map((v) => v.toFixed(6)).join(' '))
      }
    }
  }
  return lines.join('\n') + '\n'
}

describe('parseCube', () => {
  it('parses header, comments, CRLF and data (red fastest)', () => {
    const text =
      '# c\r\nTITLE "X"\r\nLUT_3D_SIZE 2\r\n\r\n0 0 0\r\n1 0 0\r\n0 1 0\r\n1 1 0\r\n0 0 1\r\n1 0 1\r\n0 1 1\r\n1 1 1\r\n'
    const lut = parseCube(text)
    expect(lut.title).toBe('X')
    expect(lut.size).toBe(2)
    expect(Array.from(lut.data.subarray(3, 6))).toEqual([1, 0, 0])
    expect(Array.from(lut.data.subarray(21, 24))).toEqual([1, 1, 1])
  })

  it('supports DOMAIN_MIN/MAX, scientific notation and trailing tokens', () => {
    const lut = parseCube(
      'LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n' +
        Array.from(
          { length: 8 },
          (_, i) => `${(i & 1) * 2}e0 ${((i >> 1) & 1) * 2}.0 ${(i >> 2) * 2} # c`,
        ).join('\n'),
    )
    expect(lut.domainMax).toEqual([2, 2, 2])
    const out = new Float32Array(3)
    sampleTetrahedral(lut, 1, 1, 1, out)
    expect([...out]).toEqual([1, 1, 1])
  })

  it('identity LUT is exact under tetrahedral interpolation', () => {
    const n = 5
    const rows: string[] = [`LUT_3D_SIZE ${n}`]
    for (let b = 0; b < n; b++)
      for (let g = 0; g < n; g++)
        for (let r = 0; r < n; r++) rows.push(`${r / (n - 1)} ${g / (n - 1)} ${b / (n - 1)}`)
    const lut = parseCube(rows.join('\n'))
    const out = new Float32Array(3)
    for (const [r, g, b] of [
      [0.1, 0.7, 0.33],
      [0.9, 0.2, 0.5],
      [0.5, 0.5, 0.5],
      [1, 0, 1],
    ] as const) {
      sampleTetrahedral(lut, r, g, b, out)
      expect(out[0]).toBeCloseTo(r, 5)
      expect(out[1]).toBeCloseTo(g, 5)
      expect(out[2]).toBeCloseTo(b, 5)
    }
  })

  it.each([
    ['0 0 0\n', /before LUT_3D_SIZE/],
    ['LUT_3D_SIZE 2\n0 0 0\n', /expected 8 entries/],
    ['LUT_1D_SIZE 4\n', /1D LUTs/],
    ['LUT_3D_SIZE 1\n', /invalid LUT_3D_SIZE/],
    ['LUT_3D_SIZE 2\n0 0\n', /expected 3 numbers/],
    ['LUT_3D_SIZE 2\nDOMAIN_MIN 1 1 1\nDOMAIN_MAX 1 1 1\n' + '0 0 0\n'.repeat(8), /DOMAIN_MAX/],
    ['TITLE "x"\n', /missing LUT_3D_SIZE/],
  ])('rejects %j', (text, msg) => {
    expect(() => parseCube(text)).toThrow(CubeParseError)
    expect(() => parseCube(text)).toThrow(msg)
  })

  it('parses a 65³ LUT quickly', () => {
    const text = makeCube(65)
    const t0 = performance.now()
    const lut = parseCube(text)
    const ms = performance.now() - t0
    expect(lut.data.length).toBe(65 ** 3 * 3)
    // generous bound for loaded CI machines; ~45 ms on the host laptop
    expect(ms).toBeLessThan(750)
  })
})

describe.skipIf(!HAS_FFMPEG)('tetrahedral interpolation vs FFmpeg lut3d', () => {
  const tmp = tempDir()
  afterAll(() => tmp.cleanup())

  it('matches within 1 LSB on random pixels', () => {
    const size = 17
    const text = makeCube(size)
    writeFileSync(path.join(tmp.dir, 'look.cube'), text)
    const W = 32
    const H = 32
    const px = new Uint8Array(W * H * 3)
    let s = 12345
    for (let i = 0; i < px.length; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      px[i] = s >>> 24
    }
    writeFileSync(path.join(tmp.dir, 'in.rgb'), px)
    const out = ffmpegRaw(
      [
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-s',
        `${W}x${H}`,
        '-i',
        'in.rgb',
        '-vf',
        'lut3d=file=look.cube:interp=tetrahedral',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1',
      ],
      tmp.dir,
    )
    const lut = parseCube(text)
    const v = new Float32Array(3)
    let maxErr = 0
    for (let i = 0; i < W * H; i++) {
      sampleTetrahedral(lut, px[i * 3]! / 255, px[i * 3 + 1]! / 255, px[i * 3 + 2]! / 255, v)
      for (let k = 0; k < 3; k++) maxErr = Math.max(maxErr, Math.abs(out[i * 3 + k]! - v[k]! * 255))
    }
    expect(maxErr).toBeLessThanOrEqual(1)
  })
})
