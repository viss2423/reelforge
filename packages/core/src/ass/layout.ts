/**
 * Font-metric-agnostic text layout heuristics for the ASS generator.
 *
 * The generator never asks libass to wrap (every event carries `\q2`); it breaks lines itself
 * so that line positions and line spacing are deterministic and identical in FFmpeg and
 * JASSUB. Widths are ESTIMATES from per-character em-width classes that fit the display
 * fonts ReelForge ships (Montserrat, Poppins, Inter, Anton, …) within ~10–15 %; they only
 * decide where lines break and how wide a left/right aligned block is, never glyph placement.
 */
import type { CaptionStyle, TextStyle, Us, Word } from '../schema.ts'

/** Inputs of the width estimate. */
export interface FontSpec {
  /** ASS font size (px). */
  size: number
  weight: number
  /** Extra px between characters (ASS `\fsp`). */
  letterSpacing: number
}

export const fontSpec = (s: TextStyle): FontSpec => ({
  size: s.fontSize,
  weight: s.fontWeight,
  letterSpacing: s.letterSpacing,
})

// Sets of single BMP characters (a string iterates by code point, so `new Set(str)` is exact).
const NARROW = new Set(`iIl1|!.,:;'\`ı`)
const SEMI_NARROW = new Set('fjrt()[]{}"/\\-')
const WIDE = new Set('mwMW@%&')
const WIDE_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/u
// Combining marks, zero-width space/joiners and variation selectors take no advance.
const ZERO_WIDTH_RE = /^(?:\p{Mn}|\p{Me}|[​-‍]|︎|️)$/u

/** Estimated advance of one character in em. */
export function charEm(ch: string): number {
  if (ch === ' ') return 0.28
  if (NARROW.has(ch)) return 0.28
  if (SEMI_NARROW.has(ch)) return 0.36
  if (WIDE.has(ch)) return 0.86
  if (ch >= '0' && ch <= '9') return 0.58
  if (ch >= 'A' && ch <= 'Z') return 0.68
  if (ch >= 'a' && ch <= 'z') return 0.55
  if (ZERO_WIDTH_RE.test(ch)) return 0
  if (WIDE_RE.test(ch)) return 1
  return 0.62
}

/** Estimated rendered width (px at scale 1) of a single line of text. */
export function measureText(text: string, font: FontSpec): number {
  // Heavier weights are wider: ≈ +10 % from regular (400) to black (900).
  const weightFactor = 1 + ((font.weight - 400) / 500) * 0.1
  let em = 0
  let n = 0
  for (const ch of text) {
    em += charEm(ch)
    n++
  }
  return em * font.size * weightFactor + Math.max(0, n - 1) * font.letterSpacing
}

/** Break a single word wider than `maxWidth` into character chunks that fit. */
function breakWord(word: string, font: FontSpec, maxWidth: number): string[] {
  const out: string[] = []
  let cur = ''
  for (const ch of word) {
    if (cur !== '' && measureText(cur + ch, font) > maxWidth) {
      out.push(cur)
      cur = ch
    } else cur += ch
  }
  if (cur !== '') out.push(cur)
  return out
}

/**
 * Greedy line breaking: explicit newlines are kept, words are packed while the estimated
 * width stays within `maxWidth`, and words that alone exceed it are split by character.
 * Runs of spaces collapse to one (libass would render them, but they never help on Reels).
 */
export function wrapText(text: string, font: FontSpec, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    const words = paragraph.split(/[ \t]+/).filter((w) => w !== '')
    if (words.length === 0) {
      lines.push('')
      continue
    }
    let line = ''
    for (const word of words) {
      const candidate = line === '' ? word : `${line} ${word}`
      if (measureText(candidate, font) <= maxWidth) {
        line = candidate
        continue
      }
      if (line !== '') lines.push(line)
      if (measureText(word, font) <= maxWidth) line = word
      else {
        const parts = breakWord(word, font, maxWidth)
        line = parts.pop() ?? ''
        lines.push(...parts)
      }
    }
    lines.push(line)
  }
  return lines
}

/* ------------------------------------------------------------------ caption grouping */

/** A gap longer than this between two words starts a new caption line. */
export const LINE_BREAK_GAP: Us = 600_000
/** A gap longer than this always ends the caption page (captions never bridge it). */
export const PAGE_BREAK_GAP: Us = 1_500_000
/** How long a page lingers after its last word when the next page is not right behind. */
export const PAGE_LINGER: Us = 300_000

const SENTENCE_END_RE = /[.!?…。！？]["'”’)\]]*$/u

/** True when a word closes a sentence (ends with . ! ? … optionally followed by quotes). */
export const endsSentence = (text: string): boolean => SENTENCE_END_RE.test(text.trim())

/** Display text of a caption word (uppercase + emoji suffix applied). */
export function captionWordText(w: Word, uppercase: boolean): string {
  const text = uppercase ? w.text.toUpperCase() : w.text
  return w.emoji ? `${text} ${w.emoji}` : text
}

/** One caption "page": what is on screen at once (1..maxLines lines). */
export interface CaptionPage {
  /** Indices into the word array, per line. */
  lines: number[][]
  start: Us
  end: Us
}

/**
 * Group caption words into pages. A line holds at most `maxWordsPerLine` words and its
 * estimated width stays within the base style's maxWidth; a new line starts after a pause
 * longer than 600 ms; a page holds at most `maxLines` lines and ends after a sentence or a
 * pause longer than 1.5 s. Filler words and empty words are not shown.
 * Page `end` extends to the next page when it follows within 600 ms (no flicker), otherwise
 * the page lingers for 300 ms (never past the next page's start).
 */
export function groupCaptionPages(words: readonly Word[], style: CaptionStyle): CaptionPage[] {
  const font = fontSpec(style.base)
  const maxWidth = style.base.maxWidth
  const pages: CaptionPage[] = []
  let lines: number[][] = []
  let line: number[] = []
  let lineText = ''
  let prev: Word | undefined

  const closeLine = () => {
    if (line.length > 0) lines.push(line)
    line = []
    lineText = ''
  }
  const closePage = () => {
    closeLine()
    if (lines.length > 0) pages.push({ lines, start: 0, end: 0 })
    lines = []
  }

  words.forEach((w, i) => {
    if (w.filler || w.text.trim() === '') return
    const text = captionWordText(w, style.base.uppercase)
    if (prev) {
      const gap = w.start - prev.end
      if (gap > PAGE_BREAK_GAP || endsSentence(prev.text)) closePage()
      else if (
        line.length > 0 &&
        (gap > LINE_BREAK_GAP ||
          line.length >= style.maxWordsPerLine ||
          measureText(`${lineText} ${text}`, font) > maxWidth)
      ) {
        closeLine()
        if (lines.length >= style.maxLines) closePage()
      }
    }
    line.push(i)
    lineText = lineText === '' ? text : `${lineText} ${text}`
    prev = w
  })
  closePage()

  for (let k = 0; k < pages.length; k++) {
    const page = pages[k]!
    const first = words[page.lines[0]![0]!]!
    const lastLine = page.lines[page.lines.length - 1]!
    const last = words[lastLine[lastLine.length - 1]!]!
    const nextPage = pages[k + 1]
    const nextStart = nextPage ? words[nextPage.lines[0]![0]!]!.start : Infinity
    page.start = first.start
    const lastEnd = Math.max(last.end, first.start + 1)
    page.end =
      nextStart - lastEnd <= LINE_BREAK_GAP
        ? Math.max(nextStart, page.start + 1)
        : Math.min(lastEnd + PAGE_LINGER, nextStart)
  }
  return pages
}
