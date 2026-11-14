/**
 * Tiny anti-aliased vector rasterizer for generated pack art (stickers, test scenes).
 *
 * Shapes become coverage masks (Float32Array, 0..1 per pixel):
 *  - fills use exact-horizontal-coverage scanlines with SUB vertical sub-samples (nonzero rule)
 *  - strokes are unions of round-capped capsules evaluated as a distance field, so joins and
 *    caps are always round (the hand-drawn marker look we want)
 * Masks are composited source-over in premultiplied sRGB, like a browser canvas.
 * Pure JS + integer-free maths with fixed iteration order ⇒ byte-identical output everywhere.
 */
import { encodePng } from './png.mjs'

const SUB = 5

/** Parse `#rgb`, `#rrggbb` or `#rrggbbaa` into [r, g, b, a] in 0..1. */
export function rgba(hex) {
  let h = hex.replace('#', '')
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  if (h.length === 6) h += 'ff'
  if (!/^[0-9a-fA-F]{8}$/.test(h)) throw new Error(`bad colour ${hex}`)
  return [0, 2, 4, 6].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255)
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Polyline path builder; curves are flattened at construction time. */
export class Path {
  /** @type {{ points: number[][], closed: boolean }[]} */
  subpaths = []
  #cur = null

  moveTo(x, y) {
    this.#cur = { points: [[x, y]], closed: false }
    this.subpaths.push(this.#cur)
    return this
  }
  lineTo(x, y) {
    if (!this.#cur) return this.moveTo(x, y)
    this.#cur.points.push([x, y])
    return this
  }
  #last() {
    const p = this.#cur?.points.at(-1)
    if (!p) throw new Error('curve without current point')
    return p
  }
  quadTo(cx, cy, x, y, steps = 24) {
    const [x0, y0] = this.#last()
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const u = 1 - t
      this.lineTo(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y)
    }
    return this
  }
  cubicTo(c1x, c1y, c2x, c2y, x, y, steps = 32) {
    const [x0, y0] = this.#last()
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const u = 1 - t
      const a = u * u * u
      const b = 3 * u * u * t
      const c = 3 * u * t * t
      const d = t * t * t
      this.lineTo(a * x0 + b * c1x + c * c2x + d * x, a * y0 + b * c1y + c * c2y + d * y)
    }
    return this
  }
  /** Elliptical arc; angles in degrees, 0 = +x, increasing clockwise (y points down). */
  arc(cx, cy, rx, ry, a0, a1, steps = Math.max(8, Math.ceil(Math.abs(a1 - a0) / 4))) {
    for (let i = 0; i <= steps; i++) {
      const a = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180
      const x = cx + rx * Math.cos(a)
      const y = cy + ry * Math.sin(a)
      if (i === 0 && !this.#cur) this.moveTo(x, y)
      else this.lineTo(x, y)
    }
    return this
  }
  close() {
    if (this.#cur) this.#cur.closed = true
    this.#cur = null
    return this
  }
  /** Append another path's subpaths (for compound shapes). */
  add(other) {
    for (const s of other.subpaths)
      this.subpaths.push({ points: s.points.map((p) => [...p]), closed: s.closed })
    this.#cur = null
    return this
  }
  /** Return a transformed copy. */
  map(fn) {
    const p = new Path()
    for (const s of this.subpaths)
      p.subpaths.push({ points: s.points.map(([x, y]) => fn(x, y)), closed: s.closed })
    return p
  }
  translate(dx, dy) {
    return this.map((x, y) => [x + dx, y + dy])
  }
  /** Rotate (degrees, clockwise) and scale around a pivot. */
  rotate(deg, px = 0, py = 0, scale = 1) {
    const r = (deg * Math.PI) / 180
    const c = Math.cos(r) * scale
    const s = Math.sin(r) * scale
    return this.map((x, y) => [px + (x - px) * c - (y - py) * s, py + (x - px) * s + (y - py) * c])
  }
}

export const circle = (cx, cy, r) => ellipse(cx, cy, r, r)
export const ellipse = (cx, cy, rx, ry) => new Path().arc(cx, cy, rx, ry, 0, 360, 96).close()
export const polygon = (pts) => {
  const p = new Path()
  pts.forEach(([x, y], i) => (i === 0 ? p.moveTo(x, y) : p.lineTo(x, y)))
  return p.close()
}
export const roundRect = (x, y, w, h, r) => {
  const rr = Math.min(r, w / 2, h / 2)
  return new Path()
    .arc(x + w - rr, y + rr, rr, rr, -90, 0)
    .arc(x + w - rr, y + h - rr, rr, rr, 0, 90)
    .arc(x + rr, y + h - rr, rr, rr, 90, 180)
    .arc(x + rr, y + rr, rr, rr, 180, 270)
    .close()
}
/** n-pointed star; `rot` in degrees (0 = first point straight up). */
export const star = (cx, cy, ro, ri, n, rot = 0) => {
  const pts = []
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? ro : ri
    const a = ((rot - 90 + (i * 180) / n) * Math.PI) / 180
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
  }
  return polygon(pts)
}
/** Four-point "sparkle" with concave curved sides. */
export const sparkle = (cx, cy, r, pinch = 0.18) => {
  const p = new Path().moveTo(cx, cy - r)
  const k = r * pinch
  p.quadTo(cx + k, cy - k, cx + r, cy)
  p.quadTo(cx + k, cy + k, cx, cy + r)
  p.quadTo(cx - k, cy + k, cx - r, cy)
  p.quadTo(cx - k, cy - k, cx, cy - r)
  return p.close()
}
/** Classic heart centred on (cx, cy), `s` ≈ half width. */
export const heart = (cx, cy, s) =>
  new Path()
    .moveTo(cx, cy + s * 0.95)
    .cubicTo(cx - s * 0.55, cy + s * 0.55, cx - s * 1.05, cy + s * 0.1, cx - s, cy - s * 0.35)
    .cubicTo(cx - s * 0.95, cy - s * 0.95, cx - s * 0.2, cy - s * 1.05, cx, cy - s * 0.5)
    .cubicTo(cx + s * 0.2, cy - s * 1.05, cx + s * 0.95, cy - s * 0.95, cx + s, cy - s * 0.35)
    .cubicTo(cx + s * 1.05, cy + s * 0.1, cx + s * 0.55, cy + s * 0.55, cx, cy + s * 0.95)
    .close()

/* ------------------------------------------------------------------ masks */

/** Nonzero-rule fill coverage of a path. */
export function fillMask(w, h, path) {
  const mask = new Float32Array(w * h)
  /** edges as flat [x0, y0, x1, y1, dir] with y0 < y1 */
  const edges = []
  let ymin = Infinity
  let ymax = -Infinity
  for (const { points } of path.subpaths) {
    for (let i = 0; i < points.length; i++) {
      const a = points[i]
      const b = points[(i + 1) % points.length]
      if (a[1] === b[1]) continue
      const dir = a[1] < b[1] ? 1 : -1
      const [p, q] = dir === 1 ? [a, b] : [b, a]
      edges.push(p[0], p[1], q[0], q[1], dir)
      ymin = Math.min(ymin, p[1])
      ymax = Math.max(ymax, q[1])
    }
  }
  if (edges.length === 0) return mask
  const y0 = Math.max(0, Math.floor(ymin))
  const y1 = Math.min(h - 1, Math.ceil(ymax))
  const acc = new Float32Array(w + 1)
  const xs = []
  const wgt = 1 / SUB
  for (let y = y0; y <= y1; y++) {
    acc.fill(0)
    for (let s = 0; s < SUB; s++) {
      const sy = y + (s + 0.5) / SUB
      xs.length = 0
      for (let e = 0; e < edges.length; e += 5) {
        const ey0 = edges[e + 1]
        const ey1 = edges[e + 3]
        if (sy < ey0 || sy >= ey1) continue
        const ex0 = edges[e]
        xs.push({ x: ex0 + ((sy - ey0) * (edges[e + 2] - ex0)) / (ey1 - ey0), d: edges[e + 4] })
      }
      if (xs.length < 2) continue
      xs.sort((a, b) => a.x - b.x || a.d - b.d)
      let wind = 0
      let start = 0
      for (const { x, d } of xs) {
        const before = wind
        wind += d
        if (before === 0 && wind !== 0) start = x
        else if (before !== 0 && wind === 0) addSpan(acc, w, start, x, wgt)
      }
    }
    const row = y * w
    for (let x = 0; x < w; x++) mask[row + x] = acc[x] > 1 ? 1 : acc[x]
  }
  return mask
}

function addSpan(acc, w, xa, xb, wgt) {
  if (xb <= 0 || xa >= w) return
  const a = Math.max(0, xa)
  const b = Math.min(w, xb)
  const ia = Math.floor(a)
  const ib = Math.floor(b)
  if (ia === ib) {
    acc[ia] += (b - a) * wgt
    return
  }
  acc[ia] += (ia + 1 - a) * wgt
  for (let i = ia + 1; i < ib; i++) acc[i] += wgt
  if (ib < w) acc[ib] += (b - ib) * wgt
}

/** Round-capped, round-joined stroke coverage of every subpath of `path`. */
export function strokeMask(w, h, path, width) {
  const mask = new Float32Array(w * h)
  const r = width / 2
  for (const { points, closed } of path.subpaths) {
    const n = closed ? points.length : points.length - 1
    if (points.length === 1) capsule(mask, w, h, points[0], points[0], r)
    for (let i = 0; i < n; i++) capsule(mask, w, h, points[i], points[(i + 1) % points.length], r)
  }
  return mask
}

function capsule(mask, w, h, [ax, ay], [bx, by], r) {
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - 1))
  const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r + 1))
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r - 1))
  const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r + 1))
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5 - ay
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5 - ax
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len2))
      const ex = px - t * dx
      const ey = py - t * dy
      const cov = r - Math.sqrt(ex * ex + ey * ey) + 0.5
      if (cov <= 0) continue
      const i = y * w + x
      const c = cov > 1 ? 1 : cov
      if (c > mask[i]) mask[i] = c
    }
  }
}

/** Approximate gaussian blur: three separable box passes. */
export function blurMask(mask, w, h, radius) {
  const r = Math.max(1, Math.round(radius / 1.7))
  const src = Float32Array.from(mask)
  const tmp = new Float32Array(w * h)
  for (let pass = 0; pass < 3; pass++) {
    boxBlur(src, tmp, w, h, r, 1, w) // horizontal
    boxBlur(tmp, src, h, w, r, w, 1) // vertical (transposed indexing)
  }
  return src
}

/** 1-D box blur along `len` samples spaced by `step`, for each of `lines` lines spaced by `lineStep`. */
function boxBlur(src, dst, len, lines, r, step, lineStep) {
  const norm = 1 / (2 * r + 1)
  for (let l = 0; l < lines; l++) {
    const base = l * lineStep
    let sum = 0
    for (let i = -r; i <= r; i++) sum += src[base + Math.min(len - 1, Math.max(0, i)) * step]
    for (let i = 0; i < len; i++) {
      dst[base + i * step] = sum * norm
      sum += src[base + Math.min(len - 1, i + r + 1) * step] - src[base + Math.max(0, i - r) * step]
    }
  }
}

export const shiftMask = (mask, w, h, dx, dy) => {
  const out = new Float32Array(w * h)
  const ix = Math.round(dx)
  const iy = Math.round(dy)
  for (let y = 0; y < h; y++) {
    const sy = y - iy
    if (sy < 0 || sy >= h) continue
    for (let x = 0; x < w; x++) {
      const sx = x - ix
      if (sx >= 0 && sx < w) out[y * w + x] = mask[sy * w + sx]
    }
  }
  return out
}
export const unionMask = (a, b) => a.map((v, i) => (v > b[i] ? v : b[i]))
export const subtractMask = (a, b) => a.map((v, i) => v * (1 - b[i]))
export const intersectMask = (a, b) => a.map((v, i) => v * b[i])

/* ------------------------------------------------------------------ paint & canvas */

/**
 * Paint: a colour string, or a gradient
 * `{ linear: [x0, y0, x1, y1] | radial: [cx, cy, r], stops: [[t, colour], ...] }`.
 */
function compilePaint(paint) {
  if (typeof paint === 'string') {
    const c = rgba(paint)
    return () => c
  }
  const stops = paint.stops.map(([t, c]) => [t, rgba(c)])
  const at = (t) => {
    const u = clamp01(t)
    let i = 0
    while (i < stops.length - 2 && u > stops[i + 1][0]) i++
    const [ta, ca] = stops[i]
    const [tb, cb] = stops[Math.min(i + 1, stops.length - 1)]
    const f = tb === ta ? 0 : clamp01((u - ta) / (tb - ta))
    return [0, 1, 2, 3].map((k) => ca[k] + (cb[k] - ca[k]) * f)
  }
  if (paint.linear) {
    const [x0, y0, x1, y1] = paint.linear
    const dx = x1 - x0
    const dy = y1 - y0
    const l2 = dx * dx + dy * dy || 1
    return (x, y) => at(((x - x0) * dx + (y - y0) * dy) / l2)
  }
  const [cx, cy, r] = paint.radial
  return (x, y) => at(Math.hypot(x - cx, y - cy) / r)
}

export class Canvas {
  /** @param {number} w @param {number} h @param {string} [background] */
  constructor(w, h, background) {
    this.w = w
    this.h = h
    /** premultiplied RGBA 0..1 */
    this.px = new Float32Array(w * h * 4)
    if (background) this.composite(new Float32Array(w * h).fill(1), background)
  }

  /** Source-over composite `paint` through a coverage mask. */
  composite(mask, paint, opacity = 1) {
    const colorAt = compilePaint(paint)
    const { w, h, px } = this
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const m = mask[y * w + x] * opacity
        if (m <= 0) continue
        const [r, g, b, a] = colorAt(x + 0.5, y + 0.5)
        const sa = a * m
        const k = 1 - sa
        const i = (y * w + x) * 4
        px[i] = r * sa + px[i] * k
        px[i + 1] = g * sa + px[i + 1] * k
        px[i + 2] = b * sa + px[i + 2] * k
        px[i + 3] = sa + px[i + 3] * k
      }
    }
    return this
  }

  fill(path, paint, opacity = 1) {
    return this.composite(fillMask(this.w, this.h, path), paint, opacity)
  }

  stroke(path, width, paint, opacity = 1) {
    return this.composite(strokeMask(this.w, this.h, path, width), paint, opacity)
  }

  /** Soft drop shadow / glow of a mask. */
  shadow(mask, { dx = 0, dy = 0, blur = 8, color = '#00000066' } = {}) {
    const m = blurMask(shiftMask(mask, this.w, this.h, dx, dy), this.w, this.h, blur)
    return this.composite(m, color)
  }

  /** Straight-alpha RGBA8. */
  toRGBA8() {
    const { px } = this
    const out = new Uint8Array(px.length)
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3]
      if (a <= 0) continue
      out[i] = Math.round(clamp01(px[i] / a) * 255)
      out[i + 1] = Math.round(clamp01(px[i + 1] / a) * 255)
      out[i + 2] = Math.round(clamp01(px[i + 2] / a) * 255)
      out[i + 3] = Math.round(clamp01(a) * 255)
    }
    return out
  }

  toPNG() {
    return encodePng(this.w, this.h, this.toRGBA8())
  }
}
