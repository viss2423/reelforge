/** Low-level ASS (v4+) formatting: timestamps, colours, numbers and text escaping. */

/** µs → centiseconds. Every event boundary goes through this ONE rounding function, so two
 * events that touch in µs also touch in centiseconds (no 1 cs gaps or overlaps). */
export const toCs = (us: number): number => Math.max(0, Math.round(us / 10_000))

/** Centiseconds → `h:mm:ss.cc`. */
export function csToAssTime(cs: number): string {
  const h = Math.floor(cs / 360_000)
  const m = Math.floor((cs % 360_000) / 6_000)
  const s = Math.floor((cs % 6_000) / 100)
  const c = cs % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`
}

/** µs → `h:mm:ss.cc`. */
export const assTime = (us: number): string => csToAssTime(toCs(us))

/** Compact decimal: at most 2 fractional digits, no trailing zeros, never "-0". */
export function num(n: number): string {
  const r = Math.round(n * 100) / 100
  return r === 0 ? '0' : String(r)
}

export interface Rgba {
  r: number
  g: number
  b: number
  /** Opacity 0..255 (255 = opaque). */
  a: number
}

/** Parse `#RRGGBB` / `#RRGGBBAA`. */
export function parseHex(hex: string): Rgba {
  const v = hex.startsWith('#') ? hex.slice(1) : hex
  const byte = (i: number) => Number.parseInt(v.slice(i, i + 2), 16) || 0
  return { r: byte(0), g: byte(2), b: byte(4), a: v.length >= 8 ? byte(6) : 255 }
}

const hex2 = (n: number) =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .toUpperCase()
    .padStart(2, '0')

/** Colour for override tags: `&HBBGGRR&`. */
export function assColor(hex: string): string {
  const c = parseHex(hex)
  return `&H${hex2(c.b)}${hex2(c.g)}${hex2(c.r)}&`
}

/** ASS alpha (00 opaque … FF transparent) for a colour opacity (0..255) times `opacity`. */
export const assAlphaValue = (colorOpacity: number, opacity = 1): number =>
  255 - Math.round(colorOpacity * Math.max(0, Math.min(1, opacity)))

/** Alpha for override tags: `&HAA&`. */
export const assAlpha = (alpha: number): string => `&H${hex2(alpha)}&`

/** Colour with alpha for [V4+ Styles]: `&HAABBGGRR`. */
export function assStyleColor(hex: string): string {
  const c = parseHex(hex)
  return `&H${hex2(255 - c.a)}${hex2(c.b)}${hex2(c.g)}${hex2(c.r)}`
}

/** Characters after which a literal backslash would start an ASS escape sequence. */
const ESCAPE_FOLLOWERS = new Set(['N', 'n', 'h', '{', '}'])
const ZWSP = '​'

/**
 * Escape user text for an ASS Dialogue: braces become `\{` / `\}` (libass literal braces),
 * newlines become `\N`, and a backslash that would form an escape with the next character
 * (or with the override block that may follow this fragment) is defused with a zero-width
 * space so it renders literally.
 */
export function escapeAssText(text: string): string {
  let out = ''
  const chars = text.replace(/\r\n?/g, '\n')
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!
    if (ch === '\n') out += '\\N'
    else if (ch === '{' || ch === '}') out += `\\${ch}`
    else if (ch === '\\') {
      const next = chars[i + 1]
      out += next === undefined || ESCAPE_FOLLOWERS.has(next) || next === '\n' ? `\\${ZWSP}` : '\\'
    } else out += ch
  }
  return out
}

/** Make a value safe for a comma-separated ASS field (Name, Style, Title). */
export const fieldSafe = (s: string): string => s.replace(/[,\r\n]/g, ' ')
