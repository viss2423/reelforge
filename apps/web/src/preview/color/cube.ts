/**
 * Adobe/Resolve `.cube` 3D LUT parser and the tetrahedral interpolation FFmpeg's `lut3d`
 * uses by default (the shader implements the same with four texelFetch taps).
 *
 * The parser is a hand-written scanner over char codes (no split/regex or string slices per
 * value): a 65³ LUT (274 625 entries) parses in ~45 ms on the host laptop, half the time of a
 * slice-per-value scanner, which matters on phones.
 */

export interface CubeLut {
  title: string
  /** Edge length N; data has N³ RGB triplets. */
  size: number
  /** RGB triplets, red index fastest (x = r, y = g, z = b) — matches a TEXTURE_3D upload. */
  data: Float32Array
  domainMin: [number, number, number]
  domainMax: [number, number, number]
}

export class CubeParseError extends Error {
  constructor(message: string, line: number) {
    super(`.cube line ${line}: ${message}`)
    this.name = 'CubeParseError'
  }
}

const MAX_SIZE = 256
/** Exact powers of ten (all representable in float64). */
const POW10 = Array.from({ length: 23 }, (_, k) => 10 ** k)

/** Parse `.cube` text. Throws {@link CubeParseError} on malformed or unsupported input. */
export function parseCube(text: string): CubeLut {
  let title = ''
  let size = 0
  const domainMin: [number, number, number] = [0, 0, 0]
  const domainMax: [number, number, number] = [1, 1, 1]
  let data: Float32Array | undefined
  let n = 0 // floats written
  let line = 0
  let i = 0
  const len = text.length

  /**
   * Parse a decimal float starting at i; advances i. Returns NaN if there is no number.
   * Digits are accumulated as an integer and divided by an exact power of ten, which is
   * correctly rounded (identical to `Number()`) while the mantissa stays below 2^53; longer
   * mantissas and exponents fall back to `Number()` on the slice. This avoids a string
   * allocation per value.
   */
  const num = (): number => {
    let j = i
    let c = text.charCodeAt(j)
    while (c === 32 || c === 9) c = text.charCodeAt(++j)
    const start = j
    let neg = false
    if (c === 43 || c === 45) {
      neg = c === 45
      c = text.charCodeAt(++j)
    }
    let mant = 0
    let digits = 0
    let frac = 0
    while (c >= 48 && c <= 57) {
      mant = mant * 10 + (c - 48)
      digits++
      c = text.charCodeAt(++j)
    }
    if (c === 46) {
      c = text.charCodeAt(++j)
      while (c >= 48 && c <= 57) {
        mant = mant * 10 + (c - 48)
        digits++
        frac++
        c = text.charCodeAt(++j)
      }
    }
    i = j
    if (digits === 0) return Number.NaN
    if (c === 101 || c === 69) {
      c = text.charCodeAt(++j)
      if (c === 43 || c === 45) c = text.charCodeAt(++j)
      while (c >= 48 && c <= 57) c = text.charCodeAt(++j)
      i = j
      return Number(text.slice(start, j))
    }
    if (digits > 15 || frac >= POW10.length) return Number(text.slice(start, j))
    const v = mant / POW10[frac]!
    return neg ? -v : v
  }

  const skipLine = (): void => {
    let c = text.charCodeAt(i)
    while (i < len && c !== 10 && c !== 13) c = text.charCodeAt(++i)
  }

  const restOfLine = (): string => {
    const start = i
    while (i < len && text.charCodeAt(i) !== 10 && text.charCodeAt(i) !== 13) i++
    return text.slice(start, i).trim()
  }

  while (i < len) {
    line++
    // skip leading whitespace
    while (i < len && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++
    const c = text.charCodeAt(i)
    if (c === 10 || c === 13 || Number.isNaN(c)) {
      // empty line
    } else if (c === 35) {
      skipLine() // comment
    } else if ((c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46) {
      if (!data) {
        if (size === 0) throw new CubeParseError('data before LUT_3D_SIZE', line)
        data = new Float32Array(size * size * size * 3)
      }
      if (n + 3 > data.length) throw new CubeParseError('too many entries', line)
      for (let k = 0; k < 3; k++) {
        const v = num()
        if (Number.isNaN(v)) throw new CubeParseError('expected 3 numbers', line)
        data[n++] = v
      }
      skipLine()
    } else {
      const rest = restOfLine()
      const sp = rest.search(/\s/)
      const key = (sp < 0 ? rest : rest.slice(0, sp)).toUpperCase()
      const arg = sp < 0 ? '' : rest.slice(sp + 1).trim()
      if (key === 'TITLE') {
        title = arg.replace(/^"(.*)"$/, '$1')
      } else if (key === 'LUT_3D_SIZE') {
        size = Number(arg)
        if (!Number.isInteger(size) || size < 2 || size > MAX_SIZE)
          throw new CubeParseError(`invalid LUT_3D_SIZE ${arg}`, line)
      } else if (key === 'LUT_1D_SIZE') {
        throw new CubeParseError('1D LUTs are not supported', line)
      } else if (key === 'DOMAIN_MIN' || key === 'DOMAIN_MAX') {
        const v = arg.split(/\s+/).map(Number)
        if (v.length !== 3 || v.some((x) => !Number.isFinite(x)))
          throw new CubeParseError(`invalid ${key}`, line)
        const target = key === 'DOMAIN_MIN' ? domainMin : domainMax
        target[0] = v[0]!
        target[1] = v[1]!
        target[2] = v[2]!
      } else if (key === 'LUT_3D_INPUT_RANGE') {
        const v = arg.split(/\s+/).map(Number)
        if (v.length !== 2 || v.some((x) => !Number.isFinite(x)))
          throw new CubeParseError('invalid LUT_3D_INPUT_RANGE', line)
        domainMin.fill(v[0]!)
        domainMax.fill(v[1]!)
      }
      // other keywords (e.g. LUT_IN_VIDEO_RANGE) are ignored, as FFmpeg does
    }
    // consume the newline (\r\n, \n or \r)
    if (text.charCodeAt(i) === 13) i++
    if (text.charCodeAt(i) === 10) i++
  }
  if (size === 0) throw new CubeParseError('missing LUT_3D_SIZE', line)
  if (!data || n !== data.length)
    throw new CubeParseError(`expected ${size ** 3} entries, got ${n / 3}`, line)
  for (let k = 0; k < 3; k++) {
    if (!(domainMax[k]! > domainMin[k]!))
      throw new CubeParseError('DOMAIN_MAX must exceed DOMAIN_MIN', line)
  }
  return { title, size, data, domainMin, domainMax }
}

/**
 * Tetrahedral interpolation (FFmpeg lut3d `interp=tetrahedral`). `rgb` in 0..1 (input domain
 * scaled by DOMAIN_MIN/MAX); writes the result into `out`.
 */
export function sampleTetrahedral(
  lut: CubeLut,
  r: number,
  g: number,
  b: number,
  out: Float32Array,
): Float32Array {
  const N = lut.size
  const m = N - 1
  const sr = clamp(((r - lut.domainMin[0]) / (lut.domainMax[0] - lut.domainMin[0])) * m, 0, m)
  const sg = clamp(((g - lut.domainMin[1]) / (lut.domainMax[1] - lut.domainMin[1])) * m, 0, m)
  const sb = clamp(((b - lut.domainMin[2]) / (lut.domainMax[2] - lut.domainMin[2])) * m, 0, m)
  const pr = Math.floor(sr)
  const pg = Math.floor(sg)
  const pb = Math.floor(sb)
  const nr = Math.min(pr + 1, m)
  const ng = Math.min(pg + 1, m)
  const nb = Math.min(pb + 1, m)
  const dr = sr - pr
  const dg = sg - pg
  const db = sb - pb
  const d = lut.data
  const at = (x: number, y: number, z: number): number => (x + y * N + z * N * N) * 3
  const c000 = at(pr, pg, pb)
  const c111 = at(nr, ng, nb)
  let ca: number
  let cb: number
  let w0: number
  let wa: number
  let wb: number
  let w1: number
  if (dr > dg) {
    if (dg > db) {
      ca = at(nr, pg, pb)
      cb = at(nr, ng, pb)
      w0 = 1 - dr
      wa = dr - dg
      wb = dg - db
      w1 = db
    } else if (dr > db) {
      ca = at(nr, pg, pb)
      cb = at(nr, pg, nb)
      w0 = 1 - dr
      wa = dr - db
      wb = db - dg
      w1 = dg
    } else {
      ca = at(pr, pg, nb)
      cb = at(nr, pg, nb)
      w0 = 1 - db
      wa = db - dr
      wb = dr - dg
      w1 = dg
    }
  } else if (db > dg) {
    ca = at(pr, pg, nb)
    cb = at(pr, ng, nb)
    w0 = 1 - db
    wa = db - dg
    wb = dg - dr
    w1 = dr
  } else if (db > dr) {
    ca = at(pr, ng, pb)
    cb = at(pr, ng, nb)
    w0 = 1 - dg
    wa = dg - db
    wb = db - dr
    w1 = dr
  } else {
    ca = at(pr, ng, pb)
    cb = at(nr, ng, pb)
    w0 = 1 - dg
    wa = dg - dr
    wb = dr - db
    w1 = db
  }
  for (let k = 0; k < 3; k++) {
    out[k] = w0 * d[c000 + k]! + wa * d[ca + k]! + wb * d[cb + k]! + w1 * d[c111 + k]!
  }
  return out
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)
