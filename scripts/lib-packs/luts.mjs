/**
 * Original colour looks, generated as 33³ `.cube` 3D LUTs (CC0).
 *
 * A look is a list of small colour operations applied to display-referred sRGB values in
 * 0..1. The LUT samples the identity cube (R fastest, then G, then B, per the Adobe/Resolve
 * .cube spec that FFmpeg's `lut3d` reads) and stores the transformed colour. Values are
 * written with 4 decimals (≈ 1/10 of a 10-bit step) and trailing zeros trimmed to keep the
 * files small; everything is pure arithmetic so output is byte-identical on every machine.
 */

export const LUT_SIZE = 33

/* ------------------------------------------------------------------ helpers */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const mix = (a, b, t) => a + (b - a) * t
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b
const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}
const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const toSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)
const hex = (h) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255)

function rgbToHsv([r, g, b]) {
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  let h = 0
  if (d > 0) {
    if (max === r) h = ((g - b) / d + 6) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
  }
  return [h * 60, max === 0 ? 0 : d / max, max]
}

function hsvToRgb([h, s, v]) {
  const hh = (((h % 360) + 360) % 360) / 60
  const i = Math.floor(hh)
  const f = hh - i
  const p = v * (1 - s)
  const q = v * (1 - s * f)
  const t = v * (1 - s * (1 - f))
  return [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][i % 6]
}

/** Signed shortest hue distance a→b in degrees. */
const hueDelta = (a, b) => ((((b - a) % 360) + 540) % 360) - 180

/** Monotone cubic (Fritsch–Carlson) curve through [x, y] control points. */
function curve(points) {
  const n = points.length
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const d = xs.slice(1).map((x, i) => (ys[i + 1] - ys[i]) / (x - xs[i]))
  const m = xs.map((_, i) =>
    i === 0 ? d[0] : i === n - 1 ? d[n - 2] : d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2,
  )
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0
      m[i + 1] = 0
      continue
    }
    const a = m[i] / d[i]
    const b = m[i + 1] / d[i]
    const s = a * a + b * b
    if (s > 9) {
      const t = 3 / Math.sqrt(s)
      m[i] = t * a * d[i]
      m[i + 1] = t * b * d[i]
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0]
    if (x >= xs[n - 1]) return ys[n - 1]
    let i = 0
    while (x > xs[i + 1]) i++
    const h = xs[i + 1] - xs[i]
    const t = (x - xs[i]) / h
    const t2 = t * t
    const t3 = t2 * t
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h * m[i + 1]
    )
  }
}

/* ------------------------------------------------------------------ operations (rgb → rgb) */

/** White balance in linear light: temperature/tint roughly −1..1. */
export const whiteBalance =
  (temp, tint = 0) =>
  (c) => {
    const gains = [1 + temp * 0.12 + tint * 0.04, 1 - tint * 0.08, 1 - temp * 0.14 + tint * 0.04]
    return c.map((v, i) => toSrgb(toLinear(v) * gains[i]))
  }
/** Exposure in stops (linear light). */
export const exposure = (stops) => (c) => c.map((v) => toSrgb(toLinear(v) * 2 ** stops))
/** S-curve contrast around a pivot; negative values flatten. */
export const contrast =
  (amount, pivot = 0.45) =>
  (c) =>
    c.map((v) => {
      const s =
        v < pivot
          ? pivot * (v / pivot) ** (1 + amount)
          : 1 - (1 - pivot) * ((1 - v) / (1 - pivot)) ** (1 + amount)
      return clamp01(s)
    })
/** Luma-preserving saturation (1 = unchanged). */
export const saturation = (s) => (c) => {
  const y = luma(c)
  return c.map((v) => y + (v - y) * s)
}
/** Saturation boost that protects already-saturated colours (and skin). */
export const vibrance = (amount) => (c) => {
  const [, s] = rgbToHsv(c)
  const y = luma(c)
  const k = 1 + amount * (1 - s) ** 2
  return c.map((v) => y + (v - y) * k)
}
/** ASC-CDL style per-channel slope/offset/power. */
export const cdl = (slope, offset, power) => (c) =>
  c.map((v, i) => clamp01(v * slope[i] + offset[i]) ** power[i])
/** Tint shadows and highlights towards two colours. */
export const splitTone = (shadow, highlight, strength = 0.15, balance = 0) => {
  const sh = hex(shadow)
  const hi = hex(highlight)
  return (c) => {
    const y = luma(c)
    const ws = (1 - smooth(0, 0.6 + balance * 0.3, y)) * strength
    const wh = smooth(0.4 + balance * 0.3, 1, y) * strength
    return c.map((v, i) => v + (sh[i] - 0.5) * ws + (hi[i] - 0.5) * wh)
  }
}
/** Lift blacks / lower whites (matte, faded film). */
export const fade =
  (black, white = 1) =>
  (c) =>
    c.map((v) => black + v * (white - black))
/** Soft shoulder that rolls highlights off instead of clipping. */
export const rolloff =
  (knee = 0.8) =>
  (c) =>
    c.map((v) => (v <= knee ? v : knee + (1 - knee) * Math.tanh((v - knee) / (1 - knee))))
/** Per-channel tone curves (each a list of [in, out] points) applied after a master curve. */
export const curves = ({ master, r, g, b }) => {
  const fm = master ? curve(master) : (v) => v
  const fc = [r, g, b].map((p) => (p ? curve(p) : (v) => v))
  return (c) => c.map((v, i) => fc[i](fm(v)))
}
/** Monochrome via channel mixer weights. */
export const mono =
  (w = [0.2126, 0.7152, 0.0722]) =>
  (c) => {
    const y = c[0] * w[0] + c[1] * w[1] + c[2] * w[2]
    return [y, y, y]
  }
/** Colourise a monochrome image (sepia, cyanotype…) keeping luminance. */
export const tone = (colour, strength = 1) => {
  const t = hex(colour)
  const ty = luma(t)
  return (c) => {
    const y = luma(c)
    return c.map((v, i) => mix(v, y * (t[i] / ty), strength))
  }
}
/**
 * Pull hues within ±width of `from` towards `to` by `amount`, weighted by saturation so
 * neutrals stay neutral. Optional saturation multiplier for the affected range.
 */
export const hueShift =
  (from, to, width, amount, satMul = 1) =>
  (c) => {
    const [h, s, v] = rgbToHsv(c)
    const w = 1 - smooth(width * 0.6, width, Math.abs(hueDelta(h, from)))
    if (w <= 0 || s === 0) return c
    const k = w * smooth(0, 0.25, s)
    return hsvToRgb([h + hueDelta(h, to) * amount * k, clamp01(s * mix(1, satMul, k)), v])
  }
/** Desaturate everything except hues near `keep` ("moody with a pop of colour"). */
export const selectiveColor =
  (keep, width, rest = 0.25) =>
  (c) => {
    const [h] = rgbToHsv(c)
    const w = 1 - smooth(width * 0.5, width, Math.abs(hueDelta(h, keep)))
    return saturation(mix(rest, 1.15, w))(c)
  }
/** Blend a look with the identity (mix strength 0..1). */
export const blend = (op, amount) => (c) => {
  const o = op(c)
  return c.map((v, i) => mix(v, o[i], amount))
}

/* ------------------------------------------------------------------ looks */

const tealOrange = [
  hueShift(30, 28, 45, 0.6, 1.12),
  hueShift(200, 188, 110, 0.75, 1.1),
  splitTone('#1a8a9a', '#ffa860', 0.22),
  contrast(0.22),
]

/** `<packId>/<filterId>` → ordered operations. */
export const LOOKS = {
  /* essentials — timeless */
  'essentials/natural-pop': [vibrance(0.35), contrast(0.12), whiteBalance(0.08)],
  'essentials/warm-film': [
    whiteBalance(0.35, 0.05),
    curves({
      master: [
        [0, 0.05],
        [0.25, 0.24],
        [0.75, 0.8],
        [1, 0.95],
      ],
      g: [
        [0, 0.02],
        [1, 0.98],
      ],
    }),
    saturation(0.9),
    splitTone('#3a5a6a', '#ffd9a0', 0.12),
  ],
  'essentials/cool-moody': [
    whiteBalance(-0.4, -0.05),
    saturation(0.72),
    splitTone('#14506a', '#d8e4ea', 0.2),
    contrast(0.2),
    rolloff(0.78),
    exposure(-0.2),
  ],
  'essentials/bw-classic': [mono(), contrast(0.15)],
  'essentials/bw-contrast': [mono([0.5, 0.42, 0.08]), contrast(0.6, 0.42), rolloff(0.85)],
  'essentials/vintage-fade': [
    fade(0.09, 0.94),
    saturation(0.78),
    splitTone('#6a3a6a', '#ffe0a0', 0.18),
    curves({
      b: [
        [0, 0.06],
        [1, 0.9],
      ],
    }),
  ],
  'essentials/matte': [fade(0.11, 0.93), saturation(0.9), contrast(0.08)],
  'essentials/bright-airy': [
    exposure(0.35),
    fade(0.04),
    contrast(-0.12),
    saturation(0.88),
    whiteBalance(-0.08, 0.04),
  ],
  'essentials/golden-hour': [
    whiteBalance(0.55, 0.06),
    splitTone('#7a4a3a', '#ffb050', 0.24, 0.1),
    vibrance(0.25),
    rolloff(0.82),
  ],
  'essentials/teal-orange': tealOrange,

  /* trending-2026-11 — curated for the season and current feeds */
  'trending-2026-11/phone-cinematic': [
    saturation(0.88),
    splitTone('#2a5a6a', '#f2c8a0', 0.14),
    contrast(0.16),
    rolloff(0.8),
    fade(0.025),
  ],
  'trending-2026-11/moody-red-pop': [
    selectiveColor(0, 40, 0.18),
    whiteBalance(-0.15),
    contrast(0.28),
    exposure(-0.15),
  ],
  'trending-2026-11/y2k-digicam': [
    whiteBalance(-0.3, 0.12),
    contrast(0.3),
    saturation(1.18),
    rolloff(0.75),
    splitTone('#3a2a8a', '#c8f0ff', 0.14),
  ],
  'trending-2026-11/cyberpunk': [
    splitTone('#00c8d8', '#ff3cc8', 0.32, 0.1),
    hueShift(60, 330, 70, 0.5),
    saturation(1.25),
    contrast(0.3),
  ],
  'trending-2026-11/pastel-dream': [
    fade(0.12, 0.98),
    contrast(-0.2),
    saturation(0.7),
    splitTone('#a0c8ff', '#ffc0d8', 0.2),
    exposure(0.2),
  ],
  'trending-2026-11/bleach-bypass': [
    blend(mono(), 0.55),
    contrast(0.45, 0.4),
    rolloff(0.8),
    whiteBalance(-0.06),
  ],
  'trending-2026-11/warm-400-film': [
    fade(0.06, 0.96),
    whiteBalance(0.25, 0.04),
    hueShift(120, 75, 60, 0.35, 0.85),
    curves({
      r: [
        [0, 0.02],
        [0.5, 0.53],
        [1, 1],
      ],
      b: [
        [0, 0.06],
        [0.5, 0.48],
        [1, 0.92],
      ],
    }),
    saturation(0.92),
    rolloff(0.8),
  ],
  'trending-2026-11/thriller-green': [
    whiteBalance(0.05, -0.35),
    saturation(0.7),
    splitTone('#0a4a3a', '#e8f0b0', 0.2),
    contrast(0.25),
    exposure(-0.15),
  ],
  'trending-2026-11/autumn-amber': [
    hueShift(95, 38, 70, 0.6, 1.15),
    whiteBalance(0.3),
    splitTone('#4a2a1a', '#ffc070', 0.16),
    contrast(0.12),
  ],
  'trending-2026-11/winter-frost': [
    whiteBalance(-0.5, 0.02),
    saturation(0.68),
    exposure(0.2),
    fade(0.03),
    splitTone('#3a6a9a', '#e8f4ff', 0.18),
  ],
  'trending-2026-11/sepia-memory': [mono(), tone('#b08850', 0.85), fade(0.06, 0.95), contrast(0.1)],
  'trending-2026-11/cross-process': [
    curves({
      r: [
        [0, 0],
        [0.25, 0.18],
        [0.75, 0.86],
        [1, 1],
      ],
      g: [
        [0, 0.02],
        [0.3, 0.3],
        [0.75, 0.84],
        [1, 1],
      ],
      b: [
        [0, 0.16],
        [0.5, 0.48],
        [1, 0.82],
      ],
    }),
    saturation(1.15),
  ],
  'trending-2026-11/night-neon': [
    exposure(-0.25),
    splitTone('#0a7a8a', '#ff4ab0', 0.26),
    saturation(1.2),
    contrast(0.22),
    rolloff(0.78),
  ],
  'trending-2026-11/lofi-faded': [
    fade(0.14, 0.9),
    curves({
      g: [
        [0, 0.04],
        [1, 0.98],
      ],
    }),
    saturation(0.74),
    contrast(-0.1),
    whiteBalance(0.1),
  ],
  // "2026 is the new 2016": hazy, pink-lifted, faded phone-filter nostalgia.
  'trending-2026-11/throwback-2016': [
    fade(0.1, 0.95),
    curves({
      r: [
        [0, 0.05],
        [0.5, 0.54],
        [1, 1],
      ],
      b: [
        [0, 0.08],
        [0.5, 0.5],
        [1, 0.94],
      ],
    }),
    splitTone('#8a5a8a', '#ffd0d8', 0.2),
    saturation(0.85),
    contrast(-0.08),
  ],
  // Season look: candle-warm highlights, deep cocoa shadows for holiday-season content.
  'trending-2026-11/cozy-holiday': [
    whiteBalance(0.4, 0.04),
    splitTone('#3a1a14', '#ffc890', 0.2),
    hueShift(0, 355, 35, 0.3, 1.12),
    contrast(0.14),
    rolloff(0.8),
    exposure(-0.08),
  ],
}

/**
 * Apply a look to one colour. Every operation works on display-referred 0..1 values, so the
 * result is clamped after each step (fractional powers of negatives would yield NaN).
 */
export const applyLook = (ops, c) => ops.reduce((acc, op) => op(acc).map(clamp01), c)

const fmt = (v) => {
  const s = v.toFixed(4)
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

/**
 * Render a look as .cube text.
 * @param {string} title
 * @param {((c: number[]) => number[])[]} ops
 */
export function buildCube(title, ops, size = LUT_SIZE) {
  const lines = [
    `TITLE "${title}"`,
    '# ReelForge original look - CC0-1.0 - generated by scripts/lib-packs/luts.mjs',
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0 0 0',
    'DOMAIN_MAX 1 1 1',
  ]
  const n = size - 1
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const [or, og, ob] = applyLook(ops, [r / n, g / n, b / n])
        lines.push(`${fmt(or)} ${fmt(og)} ${fmt(ob)}`)
      }
  return `${lines.join('\n')}\n`
}
