/**
 * LUT baking: a pack LUT applied at partial intensity is pre-blended with the identity cube
 * once (`out = id + (lut − id) · k`), so the export runs a single `lut3d` instead of
 * split + lut3d + blend per frame. Linear blending of the table equals blending the
 * graded and original pixels under trilinear/tetrahedral interpolation, so the result is
 * identical to the per-frame mix.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** A parsed Adobe/Resolve `.cube` 3D LUT. */
export interface CubeLut {
  size: number
  domainMin: [number, number, number]
  domainMax: [number, number, number]
  /** size³ RGB triplets, red fastest (the .cube order). */
  data: Float32Array
}

const triple = (parts: string[]): [number, number, number] => [
  Number(parts[1]),
  Number(parts[2]),
  Number(parts[3]),
]

/** Parse a `.cube` file (3D LUTs only). Throws on malformed input. */
export function parseCube(text: string): CubeLut {
  let size = 0
  let domainMin: [number, number, number] = [0, 0, 0]
  let domainMax: [number, number, number] = [1, 1, 1]
  let data: Float32Array | undefined
  let n = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const c = line.charCodeAt(0)
    // Data lines start with a digit, '-', '+' or '.'.
    if ((c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46) {
      if (!data) throw new Error('cube: data before LUT_3D_SIZE')
      const parts = line.split(/\s+/)
      if (parts.length < 3 || n + 3 > data.length) throw new Error('cube: malformed data')
      data[n++] = Number(parts[0])
      data[n++] = Number(parts[1])
      data[n++] = Number(parts[2])
      continue
    }
    const parts = line.split(/\s+/)
    switch (parts[0]) {
      case 'LUT_3D_SIZE':
        size = Number(parts[1])
        if (!Number.isInteger(size) || size < 2 || size > 256) throw new Error('cube: bad size')
        data = new Float32Array(size * size * size * 3)
        break
      case 'DOMAIN_MIN':
        domainMin = triple(parts)
        break
      case 'DOMAIN_MAX':
        domainMax = triple(parts)
        break
      case 'LUT_1D_SIZE':
        throw new Error('cube: 1D LUTs are not supported')
      default:
        // TITLE, LUT_3D_INPUT_RANGE, … are irrelevant here.
        break
    }
  }
  if (!data || n !== data.length) throw new Error('cube: missing or incomplete LUT data')
  if (!data.every(Number.isFinite)) throw new Error('cube: non-numeric data')
  return { size, domainMin, domainMax, data }
}

/** The LUT blended with identity at `k` (0 = identity, 1 = the LUT). */
export function mixWithIdentity(lut: CubeLut, k: number): CubeLut {
  const { size, domainMin: lo, domainMax: hi } = lut
  const d = lut.data
  const out = new Float32Array(d.length)
  const step = (ch: number): number => (hi[ch]! - lo[ch]!) / (size - 1)
  const [sr, sg, sb] = [step(0), step(1), step(2)]
  let i = 0
  for (let b = 0; b < size; b++) {
    const ib = lo[2] + sb * b
    for (let g = 0; g < size; g++) {
      const ig = lo[1] + sg * g
      for (let r = 0; r < size; r++) {
        const ir = lo[0] + sr * r
        out[i] = ir + (d[i]! - ir) * k
        out[i + 1] = ig + (d[i + 1]! - ig) * k
        out[i + 2] = ib + (d[i + 2]! - ib) * k
        i += 3
      }
    }
  }
  return { ...lut, data: out }
}

/** Serialise a LUT as `.cube` text. */
export function formatCube(lut: CubeLut): string {
  const lines = [
    `LUT_3D_SIZE ${lut.size}`,
    `DOMAIN_MIN ${lut.domainMin.join(' ')}`,
    `DOMAIN_MAX ${lut.domainMax.join(' ')}`,
  ]
  const d = lut.data
  for (let i = 0; i < d.length; i += 3) {
    lines.push(`${d[i]!.toFixed(6)} ${d[i + 1]!.toFixed(6)} ${d[i + 2]!.toFixed(6)}`)
  }
  return `${lines.join('\n')}\n`
}

/** Intensity is quantised to 1 % so near-identical slider values share a baked file. */
export const quantizeIntensity = (k: number): number => Math.round(k * 100) / 100

/**
 * Bake (or reuse) `source` at intensity `k` into `cacheDir`; returns the baked path. The
 * cache key covers the source path, size, mtime and intensity, so edited LUTs re-bake.
 */
export async function bakeLutMix(source: string, k: number, cacheDir: string): Promise<string> {
  const q = quantizeIntensity(k)
  const st = await stat(source)
  const key = createHash('sha1')
    .update(`${path.resolve(source)}\0${st.size}\0${st.mtimeMs}\0${q}`)
    .digest('hex')
    .slice(0, 20)
  const out = path.join(cacheDir, `${key}.cube`)
  try {
    await stat(out)
    return out
  } catch {
    // Not cached yet.
  }
  const lut = parseCube(await readFile(source, 'utf8'))
  await mkdir(cacheDir, { recursive: true })
  const part = `${out}.${process.pid}.${Date.now()}.part`
  await writeFile(part, formatCube(mixWithIdentity(lut, q)))
  await rename(part, out)
  return out
}
