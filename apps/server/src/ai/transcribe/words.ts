/**
 * Post-processing of recognised words: filler detection, emphasis heuristics and timing
 * sanitation. Pure functions — no I/O — so they are cheap to unit test exhaustively.
 */
import type { Word } from '@reelforge/core'

/**
 * Single-word hesitation sounds per language (ISO 639-1). Deliberately conservative: only
 * tokens that are (almost) never real words in that language. Ambiguous interjections that
 * often carry meaning ("mhm" = yes, "oh", "well", "like", "so") are NOT listed.
 */
export const FILLER_WORDS: Readonly<Record<string, readonly string[]>> = {
  en: ['um', 'umm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'ah', 'ahh', 'hmm', 'hm', 'mm', 'mmm'],
  de: ['äh', 'ähm', 'öhm', 'hm', 'hmm', 'mm'],
  fr: ['euh', 'heu', 'hum', 'hmm', 'mm'],
  es: ['eh', 'ehm', 'em', 'mm', 'hmm'],
  it: ['ehm', 'eh', 'mm', 'hmm'],
  pt: ['hum', 'ahn', 'éh', 'mm', 'hmm'],
  nl: ['uh', 'uhm', 'eh', 'ehm', 'hm', 'mm'],
}

/** Used when the language is unknown or not in the table: hesitations common across languages. */
const UNIVERSAL_FILLERS = ['um', 'umm', 'uh', 'uhm', 'erm', 'ehm', 'euh', 'äh', 'ähm', 'hmm', 'mm']

/**
 * Multi-word discourse fillers. They are only flagged when set off by punctuation (", you
 * know," / "I mean, …") because "do you know him" or "I mean it" are not fillers.
 */
export const FILLER_PHRASES: Readonly<Record<string, readonly string[]>> = {
  en: ['you know', 'i mean'],
}

/** Lower-case and strip surrounding punctuation/symbols ("Um," → "um"). */
export const normalizeWord = (text: string): string =>
  text
    .trim()
    .toLocaleLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')

const endsClause = (text: string): boolean => /[,;:.!?…]["'”’)]*$/u.test(text.trim())

export interface FillerOptions {
  /** Detected/declared language (ISO 639-1); undefined or 'auto' → universal list. */
  language?: string
  /** Extra words or phrases (any case) flagged in addition to the language defaults. */
  extra?: readonly string[]
}

/**
 * Flag filler words in place (sets `filler: true`). Returns the number of flagged words.
 * Custom `extra` phrases are matched exactly (no punctuation requirement): the user asked.
 */
export const markFillers = (words: Word[], opts: FillerOptions = {}): number => {
  const lang = opts.language && opts.language !== 'auto' ? opts.language.slice(0, 2) : undefined
  const single = new Set(lang ? (FILLER_WORDS[lang] ?? UNIVERSAL_FILLERS) : UNIVERSAL_FILLERS)
  const strictPhrases: string[][] = (lang ? (FILLER_PHRASES[lang] ?? []) : []).map((p) =>
    p.split(' '),
  )
  const userPhrases: string[][] = []
  for (const raw of opts.extra ?? []) {
    const parts = raw.split(/\s+/).map(normalizeWord).filter(Boolean)
    if (parts.length === 1) single.add(parts[0] ?? '')
    else if (parts.length > 1) userPhrases.push(parts)
  }

  const norm = words.map((w) => normalizeWord(w.text))
  let count = 0
  const flag = (i: number): void => {
    const w = words[i]
    if (w && !w.filler) {
      w.filler = true
      count++
    }
  }
  const matchesAt = (i: number, phrase: readonly string[]): boolean =>
    phrase.every((p, k) => norm[i + k] === p)

  for (let i = 0; i < words.length; i++) {
    if (single.has(norm[i] ?? '')) flag(i)
    for (const phrase of userPhrases) {
      if (matchesAt(i, phrase)) for (let k = 0; k < phrase.length; k++) flag(i + k)
    }
    for (const phrase of strictPhrases) {
      if (!matchesAt(i, phrase)) continue
      const last = words[i + phrase.length - 1]
      const before = i === 0 || endsClause(words[i - 1]?.text ?? '')
      const after = last !== undefined && endsClause(last.text)
      // ", you know," or sentence-initial "I mean, …": a parenthetical, safe to cut.
      if ((before && after) || (i > 0 && before && i + phrase.length === words.length)) {
        for (let k = 0; k < phrase.length; k++) flag(i + k)
      }
    }
  }
  return count
}

const MONEY = /^[$€£¥₹]|[$€£¥₹]$|^\d[\d.,]*[kmb]?$/iu
const MONEY_WORDS = new Set(['dollar', 'dollars', 'euro', 'euros', 'pound', 'pounds', 'bucks'])
const BIG_NUMBER_WORDS = new Set(['hundred', 'thousand', 'million', 'billion', 'trillion'])

/**
 * Heuristic emphasis (keyword highlighting in captions): numbers, money, percentages,
 * shouted ALL-CAPS words and words carrying an exclamation mark. Sets `emphasis: true` in
 * place and returns the number of emphasised words. Fillers are never emphasised.
 */
export const markEmphasis = (words: Word[]): number => {
  let count = 0
  for (const w of words) {
    if (w.filler) continue
    const t = w.text.trim()
    const core = t.replace(/^[^\p{L}\p{N}$€£¥₹]+|[^\p{L}\p{N}%$€£¥₹]+$/gu, '')
    const lower = core.toLocaleLowerCase()
    const letters = core.replace(/[^\p{L}]/gu, '')
    const emphatic =
      /\p{N}/u.test(core) ||
      MONEY.test(core) ||
      core.endsWith('%') ||
      MONEY_WORDS.has(lower) ||
      BIG_NUMBER_WORDS.has(lower) ||
      // ALL-CAPS: at least 2 letters, all upper-case, and actually cased (not CJK etc.).
      (letters.length >= 2 &&
        letters === letters.toLocaleUpperCase() &&
        letters !== letters.toLocaleLowerCase()) ||
      t.includes('!')
    if (emphatic) {
      w.emphasis = true
      count++
    }
  }
  return count
}

/** Minimum on-screen duration of a word (us) when timing allows it. */
const MIN_WORD_US = 20_000

/**
 * Make timings safe for the timeline: clamp to [0, duration], sort by start, remove overlaps
 * (a word ends no later than the next one starts) and guarantee `end > start`. Words that
 * cannot get positive duration are dropped. Returns a new array.
 */
export const sanitizeTimings = (words: readonly Word[], durationUs: number): Word[] => {
  const limit = Math.max(1, Math.round(durationUs))
  const sorted = words
    .map((w) => ({
      ...w,
      start: Math.min(limit - 1, Math.max(0, Math.round(w.start))),
      end: Math.min(limit, Math.max(0, Math.round(w.end))),
    }))
    .toSorted((a, b) => a.start - b.start)
  const out: Word[] = []
  for (let i = 0; i < sorted.length; i++) {
    const w = sorted[i]
    if (!w) continue
    const prev = out.at(-1)
    if (prev && w.start < prev.end) w.start = prev.end
    const nextStart = sorted[i + 1]?.start ?? limit
    const room = Math.max(nextStart, w.start) - w.start
    if (w.end <= w.start) w.end = w.start + Math.min(MIN_WORD_US, room)
    if (w.end > limit) w.end = limit
    if (w.end > w.start) out.push(w)
  }
  return out
}
