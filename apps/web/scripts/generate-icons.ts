/**
 * Generates the ReelForge app icons (SVG + PNG) from one procedural definition so every
 * size is pixel-identical in shape. No image tooling needed: shapes are rasterised with
 * signed-distance functions + 4×4 supersampling and encoded as PNG with node:zlib.
 *
 *   node scripts/generate-icons.ts      (writes public/icons/*, public/favicon.svg)
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const OUT = new URL('../public/icons/', import.meta.url)

/* Geometry in a 512×512 design box. */
const BOX = 512
const CORNER = 112
const FROM = [0x8b, 0x5c, 0xf6] as const // violet
const TO = [0xff, 0x2d, 0x7a] as const // pink
const FRAME = { cx: 256, cy: 256, w: 198, h: 352, r: 46, stroke: 30 }
const PLAY: readonly [number, number][] = [
  [228, 198],
  [228, 314],
  [322, 256],
]

interface Variant {
  /** Rounded background (`any` icons) vs full-bleed (maskable / apple-touch). */
  rounded: boolean
  /** Scale of the white mark around the centre (maskable keeps it inside the safe zone). */
  markScale: number
}

const sdRoundRect = (
  px: number,
  py: number,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  r: number,
) => {
  const qx = Math.abs(px - cx) - (hw - r)
  const qy = Math.abs(py - cy) - (hh - r)
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r
}

const inTriangle = (px: number, py: number, t: readonly [number, number][]) => {
  const [a, b, c] = t as [[number, number], [number, number], [number, number]]
  const s = (p: [number, number], q: [number, number]) =>
    (px - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (py - q[1])
  const d1 = s(a, b)
  const d2 = s(b, c)
  const d3 = s(c, a)
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
}

/** Returns [bgCoverage, markCoverage] at a design-space point. */
const sample = (x: number, y: number, v: Variant): [number, number] => {
  const bg = v.rounded ? (sdRoundRect(x, y, 256, 256, 256, 256, CORNER) <= 0 ? 1 : 0) : 1
  // Map into the mark's unscaled space.
  const mx = 256 + (x - 256) / v.markScale
  const my = 256 + (y - 256) / v.markScale
  const d = sdRoundRect(mx, my, FRAME.cx, FRAME.cy, FRAME.w / 2, FRAME.h / 2, FRAME.r)
  const onFrame = Math.abs(d) <= FRAME.stroke / 2
  const mark = onFrame || inTriangle(mx, my, PLAY) ? 1 : 0
  return [bg, mark]
}

const render = (size: number, v: Variant): Uint8Array => {
  const px = new Uint8Array(size * size * 4)
  const ss = 4
  const k = BOX / size
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0
      let mark = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const [b, m] = sample((x + (sx + 0.5) / ss) * k, (y + (sy + 0.5) / ss) * k, v)
          bg += b
          mark += m * b
        }
      }
      bg /= ss * ss
      mark /= ss * ss
      // Diagonal gradient (top-left → bottom-right).
      const g = Math.min(1, Math.max(0, (x + y) / (2 * size)))
      const i = (y * size + x) * 4
      for (let c = 0; c < 3; c++) {
        const base = FROM[c]! + (TO[c]! - FROM[c]!) * g
        // Mark is white composited over the gradient; coverage already premultiplied by bg.
        const col = bg > 0 ? (base * (bg - mark) + 255 * mark) / bg : 0
        px[i + c] = Math.round(col)
      }
      px[i + 3] = Math.round(bg * 255)
    }
  }
  return px
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

const crc32 = (buf: Uint8Array) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const chunk = (type: string, data: Uint8Array) => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

const encodePng = (size: number, rgba: Uint8Array) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ])
}

const hex = (c: readonly number[]) => `#${c.map((n) => n.toString(16).padStart(2, '0')).join('')}`

const svg = (v: Variant) => {
  const s = v.markScale
  const t = `translate(256 256) scale(${s}) translate(-256 -256)`
  const bg = v.rounded
    ? `<rect width="512" height="512" rx="${CORNER}" fill="url(#g)"/>`
    : `<rect width="512" height="512" fill="url(#g)"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${hex(FROM)}"/><stop offset="1" stop-color="${hex(TO)}"/></linearGradient></defs>
  ${bg}
  <g transform="${t}" fill="#fff">
    <rect x="${FRAME.cx - FRAME.w / 2}" y="${FRAME.cy - FRAME.h / 2}" width="${FRAME.w}" height="${FRAME.h}" rx="${FRAME.r}" fill="none" stroke="#fff" stroke-width="${FRAME.stroke}"/>
    <path d="M${PLAY.map((p) => p.join(' ')).join('L')}Z"/>
  </g>
</svg>
`
}

mkdirSync(OUT, { recursive: true })
const any: Variant = { rounded: true, markScale: 1 }
const maskable: Variant = { rounded: false, markScale: 0.72 }
const touch: Variant = { rounded: false, markScale: 0.86 }

writeFileSync(new URL('icon.svg', OUT), svg(any))
writeFileSync(new URL('../favicon.svg', OUT), svg(any))
writeFileSync(new URL('icon-192.png', OUT), encodePng(192, render(192, any)))
writeFileSync(new URL('icon-512.png', OUT), encodePng(512, render(512, any)))
writeFileSync(new URL('maskable-512.png', OUT), encodePng(512, render(512, maskable)))
writeFileSync(new URL('apple-touch-icon.png', OUT), encodePng(180, render(180, touch)))
process.stdout.write('icons written to public/icons\n')
