/**
 * Captions → ASS events.
 *
 * Words are grouped into pages (see groupCaptionPages). Every page is split into contiguous
 * word intervals — word k is "active" from its start until the next word starts — and each
 * interval becomes one event per line and pass, so highlighting never flickers and the
 * centisecond grid guarantees adjacent events neither gap nor overlap. Words that are not
 * yet spoken in cumulative modes are rendered fully transparent rather than omitted, which
 * keeps the line layout perfectly stable while words appear.
 *
 * Modes:
 * - `karaoke`      full page visible; the active word takes activeColor and activeScale.
 * - `word-by-word` words appear as they are spoken; the active word is highlighted.
 * - `line`         the page appears as a whole, no per-word highlight.
 * - `pop`          words appear as spoken and the active word pops in (overshoot scale).
 * - `bounce`       full page visible; the active word bounces (damped scale oscillation).
 * - `typewriter`   characters of each word are revealed across the word's duration.
 *
 * Keywords (word.emphasis with emphasizeKeywords) use keywordColor when not active. An
 * optional box behind the active word (activeBackgroundColor) and the base background box
 * share the `box` pass. Emojis are appended after their word (libass renders monochrome).
 */
import type { Captions, CaptionStyle, Us, Word } from '../schema.ts'
import { alphaTags, bandClip, scaledPassTags, type EventSink } from './events.ts'
import { assColor, escapeAssText, num, parseHex, toCs } from './format.ts'
import {
  captionWordText,
  fontSpec,
  groupCaptionPages,
  measureText,
  type CaptionPage,
} from './layout.ts'
import {
  PASS_LAYER,
  hasBox,
  hasHardShadow,
  hasSoftShadow,
  passAlphas,
  type Pass,
  type PassAlphas,
  type StyleRegistry,
} from './styles.ts'

const CANVAS_CENTER_X = 540

/** Scale keyframes (ms, multiplier of activeScale) of the active-word animations. */
const POP_STEPS: ReadonlyArray<readonly [number, number]> = [
  [0, 0.55],
  [90, 1.18],
  [160, 1],
]
const BOUNCE_STEPS: ReadonlyArray<readonly [number, number]> = [
  [0, 0.78],
  [80, 1.2],
  [160, 0.92],
  [240, 1.04],
  [300, 1],
]

const HIDDEN: PassAlphas = { fill: 0, outline: 0, shadow: 0 }

interface WordState {
  visible: boolean
  active: boolean
}

/** One event interval of a page: `active` is the flattened word index (−1 = none). */
interface Interval {
  start: Us
  end: Us
  active: number
}

function intervals(
  page: CaptionPage,
  words: readonly Word[],
  mode: CaptionStyle['mode'],
): Interval[] {
  if (mode === 'line') return [{ start: page.start, end: page.end, active: -1 }]
  const flat = page.lines.flat()
  const out: Interval[] = []
  let cursor = page.start
  flat.forEach((wi, k) => {
    const start = k === 0 ? page.start : Math.max(cursor, words[wi]!.start)
    const nextWord = flat[k + 1]
    const end = nextWord === undefined ? page.end : Math.max(start, words[nextWord]!.start)
    out.push({ start, end: Math.min(end, page.end), active: k })
    cursor = start
  })
  return out
}

function stateOf(mode: CaptionStyle['mode'], j: number, active: number): WordState {
  const cumulative = mode === 'word-by-word' || mode === 'pop' || mode === 'typewriter'
  return {
    visible: !cumulative || j <= active,
    active: j === active && mode !== 'typewriter' && mode !== 'line',
  }
}

/** Builds the inline-tag text of one caption line for one pass. */
class LineWriter {
  private out = ''
  private color: string
  private alpha: string
  private scale = '100'
  /** Box colour of the previous word in the box pass (undefined = no box). */
  private prevBox: string | undefined

  private readonly style: CaptionStyle
  private readonly pass: Pass

  constructor(style: CaptionStyle, pass: Pass) {
    this.style = style
    this.pass = pass
    this.color = pass === 'box' ? '' : style.base.color
    this.alpha = alphaTags(passAlphas(style.base, pass), 1)
  }

  private tag(t: string): void {
    if (t !== '') this.out += `{${t}}`
  }

  /** Append one word (preceded by a space unless first) in the given state. */
  word(
    w: Word,
    text: string,
    st: WordState,
    first: boolean,
    startMs: number,
    reveal?: { endMs: number },
  ): void {
    const { style, pass } = this
    const box = !st.visible
      ? undefined
      : st.active && style.activeBackgroundColor !== undefined
        ? style.activeBackgroundColor
        : style.base.backgroundColor
    if (!first) {
      // In the box pass a space is boxed only between two words sharing the same box, so
      // an active-word box hugs its word instead of swallowing the following space.
      if (pass === 'box' && (box === undefined || box !== this.prevBox)) {
        const hidden = alphaTags(HIDDEN, 1)
        if (hidden !== this.alpha) this.tag(hidden)
        this.alpha = hidden
      }
      this.out += ' '
    }
    this.prevBox = box
    let tags = ''
    let alphas: PassAlphas = HIDDEN
    if (st.visible) {
      if (pass === 'box') {
        if (box !== undefined) {
          if (assColor(box) !== this.color) {
            tags += `\\3c${assColor(box)}`
            this.color = assColor(box)
          }
          alphas = { fill: 0, outline: parseHex(box).a, shadow: 0 }
        }
      } else {
        alphas = passAlphas(style.base, pass)
        if (pass === 'main') {
          const color = st.active
            ? style.activeColor
            : w.emphasis && style.emphasizeKeywords
              ? style.keywordColor
              : style.base.color
          if (color !== this.color) {
            tags += `\\1c${assColor(color)}`
            this.color = color
          }
          alphas = { ...alphas, fill: parseHex(color).a }
        }
      }
    }
    const alpha = alphaTags(alphas, 1)
    const target = st.active ? this.style.activeScale * 100 : 100
    const steps =
      st.active && style.mode === 'pop'
        ? POP_STEPS
        : st.active && style.mode === 'bounce'
          ? BOUNCE_STEPS
          : undefined
    if (steps) {
      tags += `\\fscx${num(target * steps[0]![1])}\\fscy${num(target * steps[0]![1])}`
      for (let k = 1; k < steps.length; k++) {
        const s = num(target * steps[k]![1])
        tags += `\\t(${steps[k - 1]![0]},${steps[k]![0]},\\fscx${s}\\fscy${s})`
      }
      this.scale = ''
    } else if (num(target) !== this.scale) {
      tags += `\\fscx${num(target)}\\fscy${num(target)}`
      this.scale = num(target)
    }

    if (reveal && st.visible) {
      // Typewriter: hide every character, then reveal each at its share of the word.
      const chars = Array.from(text)
      const hidden = alphaTags(HIDDEN, 1)
      this.tag(tags)
      chars.forEach((ch, m) => {
        const ms = Math.round(startMs + ((reveal.endMs - startMs) * m) / chars.length)
        this.tag(ms <= 0 ? alpha : `${hidden}\\t(${ms - 1},${ms},${alpha})`)
        this.out += escapeAssText(ch)
      })
      this.alpha = ''
      return
    }
    if (alpha !== this.alpha) {
      tags += alpha
      this.alpha = alpha
    }
    this.tag(tags)
    this.out += escapeAssText(text)
  }

  text(): string {
    return this.out
  }
}

/** Emit all caption events on `layerBase`..`layerBase+2`. */
export function emitCaptions(
  captions: Captions,
  layerBase: number,
  styles: StyleRegistry,
  sink: EventSink,
): void {
  if (!captions.enabled || captions.words.length === 0) return
  const style = captions.style
  const base = style.base
  const words = captions.words
  const pages = groupCaptionPages(words, style)
  if (pages.length === 0) return

  const activeBox =
    style.activeBackgroundColor !== undefined && parseHex(style.activeBackgroundColor).a > 0
  const passes: Pass[] = []
  if (hasBox(base) || activeBox) passes.push('box')
  if (hasSoftShadow(base)) passes.push('shadow')
  passes.push('main')
  const hardShadow = hasHardShadow(base)
  const font = fontSpec(base)
  const lineHeight = base.fontSize * base.lineHeight
  const texts = words.map((w) => captionWordText(w, base.uppercase))

  for (const page of pages) {
    const flat = page.lines.flat()
    const indexInPage = new Map(flat.map((wi, k) => [wi, k]))
    const widths = page.lines.map((line) =>
      measureText(line.map((wi) => texts[wi]!).join(' '), font),
    )
    const blockWidth = Math.min(base.maxWidth, Math.max(...widths))
    const hx = base.align === 'left' ? -blockWidth / 2 : base.align === 'right' ? blockWidth / 2 : 0

    for (const iv of intervals(page, words, style.mode)) {
      const start = toCs(iv.start)
      const end = toCs(iv.end)
      if (end <= start) continue
      const startMs = start * 10
      for (const pass of passes) {
        const ox = pass === 'shadow' ? base.shadowX : 0
        const oy = pass === 'shadow' ? base.shadowY : 0
        const styleName = styles.get(base, pass)
        page.lines.forEach((line, li) => {
          const x = CANVAS_CENTER_X + hx + ox
          const y = style.y + (li - (page.lines.length - 1) / 2) * lineHeight + oy
          const writer = new LineWriter(style, pass)
          line.forEach((wi, n) => {
            const j = indexInPage.get(wi)!
            const st = stateOf(style.mode, j, iv.active)
            const w = words[wi]!
            const reveal =
              style.mode === 'typewriter' && j === iv.active
                ? { endMs: Math.round(w.end / 1000) - startMs }
                : undefined
            writer.word(w, texts[wi]!, st, n === 0, Math.round(w.start / 1000) - startMs, reveal)
          })
          let head = `\\q2\\pos(${num(x)},${num(y)})${scaledPassTags(base, pass, 1, hardShadow)}`
          if (pass === 'box' && page.lines.length > 1) {
            head += bandClip(y, lineHeight, li, page.lines.length)
          }
          sink.push({
            layer: layerBase + PASS_LAYER[pass],
            start,
            end,
            style: styleName,
            text: `{${head}}${writer.text()}`,
          })
        })
      }
    }
  }
}
