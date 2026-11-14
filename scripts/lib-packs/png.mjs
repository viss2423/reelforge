/**
 * Minimal, deterministic PNG codec for 8-bit RGBA images (no dependencies).
 * Used to write generated stickers/test images and to read back their headers.
 */
import { crc32, deflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

const paeth = (a, b, c) => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * Encode straight-alpha RGBA8 pixels as PNG. Each row picks the filter with the smallest
 * sum of absolute signed residuals (the libpng heuristic) — big win on flat sticker art.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba length = width * height * 4
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  const candidates = Array.from({ length: 5 }, () => Buffer.alloc(stride))
  const zero = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const row = rgba.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : zero
    let best = 0
    let bestScore = Infinity
    for (let f = 0; f < 5; f++) {
      const out = candidates[f]
      let score = 0
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? row[i - 4] : 0
        const b = prev[i]
        const c = i >= 4 ? prev[i - 4] : 0
        const pred =
          f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c)
        const v = (row[i] - pred) & 0xff
        out[i] = v
        score += v < 128 ? v : 256 - v
      }
      if (score < bestScore) {
        bestScore = score
        best = f
      }
    }
    raw[y * (stride + 1)] = best
    candidates[best].copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type RGBA
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9, memLevel: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Read width/height/bit depth/colour type from a PNG header.
 * @param {Uint8Array} buf
 */
export function readPngHeader(buf) {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  if (
    b.length < 33 ||
    !b.subarray(0, 8).equals(SIGNATURE) ||
    b.toString('latin1', 12, 16) !== 'IHDR'
  ) {
    throw new Error('not a PNG file')
  }
  return {
    width: b.readUInt32BE(16),
    height: b.readUInt32BE(20),
    bitDepth: b[24],
    colorType: b[25],
  }
}
