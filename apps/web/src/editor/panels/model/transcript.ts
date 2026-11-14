/**
 * Transcript editing on the project's captions (timeline-time words, sorted by start).
 * Every function mutates a draft and keeps words ordered and non-overlapping.
 */
import {
  OpError,
  type CaptionStyle,
  type Captions,
  type Project,
  type Us,
  type Word,
} from '@reelforge/core'
import { clamp } from './draft.ts'

/** Shortest word a split or nudge may produce. */
export const MIN_WORD: Us = 40_000

const captionsOf = (d: Project): Captions => {
  if (!d.captions) throw new OpError('no_captions', 'Add captions first')
  return d.captions
}

const wordAt = (c: Captions, i: number): Word => {
  const w = c.words[i]
  if (!w) throw new OpError('not_found', `No caption word ${i}`)
  return w
}

/** Replaces a word's text; an empty text deletes the word. */
export const editWord = (d: Project, i: number, text: string): void => {
  const c = captionsOf(d)
  const w = wordAt(c, i)
  const t = text.trim()
  if (t === '') c.words.splice(i, 1)
  else w.text = t
}

export const deleteWord = (d: Project, i: number): void => {
  const c = captionsOf(d)
  wordAt(c, i)
  c.words.splice(i, 1)
}

/** Merges word i with the next one ("gonna" ← "gon" + "na"). */
export const mergeWithNext = (d: Project, i: number): void => {
  const c = captionsOf(d)
  const a = wordAt(c, i)
  const b = c.words[i + 1]
  if (!b) throw new OpError('no_next', 'No following word to merge with')
  a.text = `${a.text} ${b.text}`
  a.end = Math.max(a.end, b.end)
  a.confidence = Math.min(a.confidence, b.confidence)
  a.filler = a.filler && b.filler
  a.emphasis = a.emphasis || b.emphasis
  c.words.splice(i + 1, 1)
}

/**
 * Splits a word in two: at its first space, or else in the middle of the text. Time is
 * shared in proportion to the characters on each side.
 */
export const splitWord = (d: Project, i: number): void => {
  const c = captionsOf(d)
  const w = wordAt(c, i)
  const text = w.text
  const space = text.indexOf(' ')
  const cut = space > 0 ? space : Math.ceil(text.length / 2)
  const left = text.slice(0, cut).trim()
  const right = text.slice(cut).trim()
  if (!left || !right) throw new OpError('too_short', 'This word cannot be split')
  if (w.end - w.start < 2 * MIN_WORD)
    throw new OpError('too_short', 'This word is too short to split')
  const mid = clamp(
    Math.round(w.start + ((w.end - w.start) * left.length) / (left.length + right.length)),
    w.start + MIN_WORD,
    w.end - MIN_WORD,
  )
  const second: Word = { ...w, text: right, start: mid }
  w.text = left
  w.end = mid
  c.words.splice(i + 1, 0, second)
}

/**
 * Moves a word's start or end edge by `delta` µs, clamped between its neighbours and so the
 * word keeps at least MIN_WORD.
 */
export const nudgeWord = (d: Project, i: number, edge: 'start' | 'end', delta: Us): void => {
  const c = captionsOf(d)
  const w = wordAt(c, i)
  if (edge === 'start') {
    const lo = c.words[i - 1]?.end ?? 0
    w.start = clamp(w.start + delta, lo, w.end - MIN_WORD)
  } else {
    const hi = c.words[i + 1]?.start ?? Number.MAX_SAFE_INTEGER
    w.end = clamp(w.end + delta, w.start + MIN_WORD, hi)
  }
}

/** Flags/unflags a word as an emphasised keyword. */
export const setEmphasis = (d: Project, i: number, on: boolean): void => {
  wordAt(captionsOf(d), i).emphasis = on
}

/** Patches the caption style (and optionally the gallery ref it came from). */
export const setCaptionStyle = (
  d: Project,
  patch: Partial<Omit<CaptionStyle, 'base'>> & { base?: Partial<CaptionStyle['base']> },
): void => {
  const c = captionsOf(d)
  const { base, ...rest } = patch
  c.style = { ...c.style, ...rest, base: { ...c.style.base, ...base } }
}

/** Replaces the whole style with a gallery style. */
export const applyCaptionStyle = (d: Project, style: CaptionStyle, ref?: string): void => {
  const c = captionsOf(d)
  // Keep the user's vertical placement: re-styling should not jump the captions around.
  c.style = { ...style, base: { ...style.base }, y: c.style.y }
  if (ref) c.styleRef = ref
  else delete c.styleRef
}

export const setCaptionsProps = (
  d: Project,
  patch: Partial<Pick<Captions, 'enabled' | 'language'>>,
): void => {
  Object.assign(captionsOf(d), patch)
}

/** Index of the word under timeline time `t` (or the last one before it), -1 if none. */
export const wordIndexAt = (words: readonly Word[], t: Us): number => {
  let lo = 0
  let hi = words.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (words[mid]!.start <= t) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}
