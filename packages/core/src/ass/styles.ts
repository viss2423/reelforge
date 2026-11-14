/**
 * [V4+ Styles] registry. Every visual element is drawn in up to three PASSES, each with its
 * own style, stacked on consecutive layers:
 *
 * - `box`    BorderStyle 3 (opaque box): the glyph fill is fully transparent, the "outline"
 *            is a per-line box padded by `backgroundPadding` in `backgroundColor`.
 * - `shadow` a blurred, offset copy of fill + stroke in the shadow colour. libass derives
 *            native shadows from the (blurred) outline, which would also soften the stroke,
 *            so soft shadows get their own pass; hard shadows use native `\xshad`/`\yshad`.
 * - `main`   BorderStyle 1: fill + stroke (+ native hard shadow).
 *
 * Styles are de-duplicated by content and named in first-use order, so output is stable.
 */
import type { TextStyle } from '../schema.ts'
import { assStyleColor, fieldSafe, num, parseHex } from './format.ts'

export type Pass = 'box' | 'shadow' | 'main'

/** Layer offset of each pass inside an element's three-layer slot. */
export const PASS_LAYER: Readonly<Record<Pass, number>> = { box: 0, shadow: 1, main: 2 }

const TRANSPARENT = '&HFF000000'

/** ASS `Bold` value: -1 (bold), 0 (regular) or an exact CSS weight (libass picks the face). */
export function assBold(weight: number): number {
  if (weight === 400) return 0
  if (weight === 700) return -1
  return weight
}

/** ASS numpad alignment for a horizontal text alignment (always vertically centred). */
export const assAlignment = (align: TextStyle['align']): number =>
  align === 'left' ? 4 : align === 'right' ? 6 : 5

/** Opacity (0..255) of each colour channel a pass draws with. */
export interface PassAlphas {
  fill: number
  outline: number
  shadow: number
}

/** Whether a style needs a box/shadow pass at all. */
export const hasBox = (s: TextStyle): boolean =>
  s.backgroundColor !== undefined && parseHex(s.backgroundColor).a > 0
export const hasSoftShadow = (s: TextStyle): boolean =>
  s.shadowBlur > 0 && parseHex(s.shadowColor).a > 0
export const hasHardShadow = (s: TextStyle): boolean =>
  s.shadowBlur === 0 && parseHex(s.shadowColor).a > 0 && (s.shadowX !== 0 || s.shadowY !== 0)

/** Base channel opacities of a pass (before element opacity / reveal is applied). */
export function passAlphas(s: TextStyle, pass: Pass, boxColor = s.backgroundColor): PassAlphas {
  switch (pass) {
    case 'box':
      return { fill: 0, outline: boxColor ? parseHex(boxColor).a : 0, shadow: 0 }
    case 'shadow': {
      const a = parseHex(s.shadowColor).a
      return { fill: a, outline: s.strokeWidth > 0 ? a : 0, shadow: 0 }
    }
    case 'main':
      return {
        fill: parseHex(s.color).a,
        outline: s.strokeWidth > 0 ? parseHex(s.strokeColor).a : 0,
        shadow: hasHardShadow(s) ? parseHex(s.shadowColor).a : 0,
      }
  }
}

/** Collects styles and returns their (stable) names. */
export class StyleRegistry {
  private readonly byKey = new Map<string, string>()
  private readonly lines: string[] = []

  constructor() {
    this.lines.push(
      'Style: Default,Arial,72,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1',
    )
  }

  /** Name of the style for `pass` of a text style (registered on first use). */
  get(s: TextStyle, pass: Pass, boxColor = s.backgroundColor): string {
    const fill = pass === 'shadow' ? s.shadowColor : s.color
    const outlineColor =
      pass === 'box' ? (boxColor ?? '#00000000') : pass === 'shadow' ? s.shadowColor : s.strokeColor
    const borderStyle = pass === 'box' ? 3 : 1
    const outline = pass === 'box' ? s.backgroundPadding : s.strokeWidth
    const fields = [
      fieldSafe(s.fontFamily),
      num(s.fontSize),
      // Box fill is always invisible: the glyphs only shape the per-line box.
      pass === 'box' ? TRANSPARENT : assStyleColor(fill),
      pass === 'box' ? TRANSPARENT : assStyleColor(fill),
      assStyleColor(outlineColor),
      pass === 'main' ? assStyleColor(s.shadowColor) : TRANSPARENT,
      assBold(s.fontWeight),
      s.italic ? -1 : 0,
      0,
      0,
      100,
      100,
      num(s.letterSpacing),
      0,
      borderStyle,
      num(outline),
      0,
      assAlignment(s.align),
      0,
      0,
      0,
      1,
    ].join(',')
    let name = this.byKey.get(fields)
    if (name === undefined) {
      name = `S${this.byKey.size + 1}`
      this.byKey.set(fields, name)
      this.lines.push(`Style: ${name},${fields}`)
    }
    return name
  }

  /** The complete `[V4+ Styles]` section. */
  section(): string {
    return [
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      ...this.lines,
    ].join('\n')
  }
}
