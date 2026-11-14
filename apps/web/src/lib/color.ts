/** Colour conversions for the picker. Hex is `#RRGGBB` or `#RRGGBBAA` (core HexColor). */

export interface Rgba {
  r: number
  g: number
  b: number
  /** 0..1 */
  a: number
}

export interface Hsv {
  /** 0..360 */
  h: number
  /** 0..1 */
  s: number
  /** 0..1 */
  v: number
}

/** Accepts `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` (with or without #). Returns upper-case `#RRGGBB[AA]` or undefined. */
export const normalizeHex = (input: string): string | undefined => {
  let s = input.trim().replace(/^#/, '')
  if (!/^[0-9a-f]+$/i.test(s)) return undefined
  if (s.length === 3 || s.length === 4) s = s.replace(/./g, '$&$&')
  if (s.length !== 6 && s.length !== 8) return undefined
  s = s.toUpperCase()
  // Fully opaque alpha is redundant; keep the canonical 6-digit form.
  if (s.length === 8 && s.endsWith('FF')) s = s.slice(0, 6)
  return `#${s}`
}

export const hexToRgba = (hex: string): Rgba => {
  const n = normalizeHex(hex) ?? '#000000'
  const v = (i: number) => Number.parseInt(n.slice(i, i + 2), 16)
  return { r: v(1), g: v(3), b: v(5), a: n.length === 9 ? v(7) / 255 : 1 }
}

const h2 = (n: number) =>
  Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, '0')

export const rgbaToHex = ({ r, g, b, a }: Rgba): string =>
  `#${h2(r)}${h2(g)}${h2(b)}${a < 1 ? h2(a * 255) : ''}`.toUpperCase()

export const rgbToHsv = ({ r, g, b }: Pick<Rgba, 'r' | 'g' | 'b'>): Hsv => {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const d = max - Math.min(rn, gn, bn)
  let h = 0
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6
    else if (max === gn) h = (bn - rn) / d + 2
    else h = (rn - gn) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

export const hsvToRgb = ({ h, s, v }: Hsv): Pick<Rgba, 'r' | 'g' | 'b'> => {
  const c = v * s
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r1, g1, b1] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x]
  const m = v - c
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 }
}

export const hsvToHex = (hsv: Hsv, a = 1): string => rgbaToHex({ ...hsvToRgb(hsv), a })
