/**
 * Minimal TextStyle/CaptionStyle → ASS converter used ONLY for pack thumbnails.
 *
 * The real renderer is `buildAss` in @reelforge/core; this approximates it closely enough
 * for a 360px preview (fonts, weights, colours, stroke, shadow/glow, boxes, active word)
 * while staying independent of the core implementation so thumbnails can be generated
 * before (and regardless of) core's ASS generator.
 */

const PLAY_W = 1080
const PLAY_H = 1920

/** `#RRGGBB[AA]` → ASS `&HBBGGRR&` colour and `&HAA&` alpha (ASS alpha is inverted). */
export function assColour(hex) {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => h.slice(i, i + 2).toUpperCase())
  const a = h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) : 255
  return {
    colour: `&H${b}${g}${r}&`,
    alpha: `&H${(255 - a).toString(16).padStart(2, '0').toUpperCase()}&`,
  }
}

/** ASS-escape user text (braces start override blocks, backslashes start tags). */
const escapeText = (s) => s.replaceAll('\\', '\\\\').replaceAll('{', '(').replaceAll('}', ')')

const HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: ${PLAY_W}
PlayResY: ${PLAY_H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Line,Arial,72,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1
Style: Boxed,Arial,72,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,4,0,0,5,0,0,0,1
Style: Word,Arial,72,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,0,0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`

const dialogue = (layer, style, tags, text) =>
  `Dialogue: ${layer},0:00:00.00,0:00:05.00,${style},,0,0,0,,{${tags}}${text}\n`

/** Font + size + spacing + colour override tags for a TextStyle. */
function baseTags(style, colour = style.color) {
  const fill = assColour(colour)
  const stroke = assColour(style.strokeColor)
  return [
    `\\fn${style.fontFamily}`,
    `\\b${style.fontWeight}`,
    `\\i${style.italic ? 1 : 0}`,
    `\\fs${style.fontSize}`,
    `\\fsp${style.letterSpacing}`,
    `\\1c${fill.colour}\\1a${fill.alpha}`,
    `\\3c${stroke.colour}\\3a${stroke.alpha}`,
    `\\bord${style.strokeWidth}`,
    '\\shad0',
  ].join('')
}

const anchor = (style, y) => {
  const half = style.maxWidth / 2
  if (style.align === 'left') return `\\an4\\pos(${PLAY_W / 2 - half},${y})`
  if (style.align === 'right') return `\\an6\\pos(${PLAY_W / 2 + half},${y})`
  return `\\an5\\pos(${PLAY_W / 2},${y})`
}

/** Shadow/glow layer: a blurred, offset copy of the text in the shadow colour. */
function shadowLayer(style, y, text) {
  const sc = assColour(style.shadowColor)
  if (sc.alpha === '&HFF&') return ''
  if (style.shadowBlur === 0 && style.shadowX === 0 && style.shadowY === 0) return ''
  const pos = anchor(style, y + style.shadowY).replace(
    /\\pos\((-?[\d.]+),/,
    (_, x) => `\\pos(${Number(x) + style.shadowX},`,
  )
  const tags = `${baseTags(style, style.shadowColor)}\\3c${sc.colour}\\3a${sc.alpha}\\blur${style.shadowBlur}${pos}`
  return dialogue(0, 'Line', tags, text)
}

/** Wrap the plain text of a TextStyle-styled block at `maxWidth` using ASS margins. */
const prepare = (style, text) => escapeText(style.uppercase ? text.toUpperCase() : text)

/**
 * ASS document showing `text` in `style`, centred at canvas y.
 * @param {import('../../packages/core/src/schema.ts').TextStyle} style
 * @param {string} text
 * @param {number} [y]
 */
export function textPreviewAss(style, text, y = PLAY_H / 2) {
  const t = prepare(style, text).replaceAll('\n', '\\N')
  let out = HEADER + shadowLayer(style, y, t)
  if (style.backgroundColor) {
    const bg = assColour(style.backgroundColor)
    const tags = `${baseTags(style)}\\4c${bg.colour}\\4a${bg.alpha}${anchor(style, y)}`
    out += dialogue(1, 'Boxed', tags, t)
  } else {
    out += dialogue(1, 'Line', `${baseTags(style)}${anchor(style, y)}`, t)
  }
  return out
}

const SAMPLE_WORDS = 'this is how your captions look on every reel'.split(' ')
/** Index of the "keyword" coloured by emphasizeKeywords. */
const KEYWORD = 4

/**
 * ASS document showing a caption style mid-sentence: the second word is the active one,
 * a keyword is coloured when the style emphasises keywords, typewriter reveals partially.
 * @param {import('../../packages/core/src/schema.ts').CaptionStyle} cs
 */
export function captionPreviewAss(cs) {
  const { base } = cs
  const perBlock = Math.min(SAMPLE_WORDS.length, cs.maxWordsPerLine * cs.maxLines)
  // Single-word modes show the active word alone; everything else shows a block.
  const start = perBlock === 1 ? KEYWORD : cs.maxWordsPerLine >= 5 ? 0 : 3
  const words = SAMPLE_WORDS.slice(start, start + perBlock).map((w) =>
    escapeText(base.uppercase ? w.toUpperCase() : w),
  )
  // Typewriter reveals up to the active word, so give it a few words to show.
  const active = Math.min(words.length - 1, cs.mode === 'typewriter' ? 3 : 1)
  const lines = []
  for (let i = 0; i < words.length; i += cs.maxWordsPerLine)
    lines.push(words.slice(i, i + cs.maxWordsPerLine))

  const activeFill = assColour(cs.activeColor)
  const keyFill = assColour(cs.keywordColor)
  const baseFill = assColour(base.color)
  const scale = Math.round(cs.activeScale * 100)
  let index = 0
  const runs = lines.map((line) =>
    line
      .map((w) => {
        const i = index++
        if (cs.mode === 'typewriter' && i > active) return ''
        if (cs.mode === 'line' || i !== active) {
          const kw = cs.emphasizeKeywords && start + i === KEYWORD
          const fill = kw ? keyFill : baseFill
          return `{\\1c${fill.colour}\\1a${fill.alpha}\\fscx100\\fscy100}${w}`
        }
        return `{\\1c${activeFill.colour}\\1a${activeFill.alpha}\\fscx${scale}\\fscy${scale}}${w}`
      })
      .filter(Boolean)
      .join(' '),
  )
  const text = runs.filter(Boolean).join('\\N')
  let out = HEADER + shadowLayer(base, cs.y, text)
  if (base.backgroundColor) {
    const bg = assColour(base.backgroundColor)
    out += dialogue(
      1,
      'Boxed',
      `${baseTags(base)}\\4c${bg.colour}\\4a${bg.alpha}${anchor(base, cs.y)}`,
      text,
    )
  } else {
    out += dialogue(2, 'Line', `${baseTags(base)}${anchor(base, cs.y)}`, text)
  }
  if (cs.activeBackgroundColor && cs.mode !== 'line') {
    // Box behind the active word only: draw the same text with every other glyph run
    // fully transparent (fill, outline and box) so only the active word's box shows.
    const box = assColour(cs.activeBackgroundColor)
    index = 0
    const boxText = lines
      .map((line) =>
        line
          .map((w) => {
            const i = index++
            if (cs.mode === 'typewriter' && i > active) return ''
            return i === active
              ? `{\\3c${box.colour}\\3a${box.alpha}\\bord${Math.max(6, Math.round(base.fontSize * 0.08))}\\fscx${scale}\\fscy${scale}}${w}`
              : `{\\3a&HFF&\\bord0\\fscx100\\fscy100}${w}`
          })
          .filter(Boolean)
          .join(' '),
      )
      .filter(Boolean)
      .join('\\N')
    out += dialogue(1, 'Word', `${baseTags(base)}\\1a&HFF&${anchor(base, cs.y)}`, boxText)
  }
  return out
}
