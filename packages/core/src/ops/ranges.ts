/** Range algebra used by silence/filler removal (all ranges half-open [start, end) in µs). */
import type { Us, Word } from '../schema.ts'
import type { Range } from './errors.ts'

/** Sort, drop empty ranges and merge overlapping or touching ones. Does not mutate input. */
export function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = ranges.filter((r) => r.end > r.start).toSorted((a, b) => a.start - b.start)
  const out: Range[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end) {
      if (r.end > last.end) last.end = r.end
    } else out.push({ start: r.start, end: r.end })
  }
  return out
}

/** Complement of `ranges` within [start, end). */
export function invertRanges(ranges: readonly Range[], start: Us, end: Us): Range[] {
  const out: Range[] = []
  let cursor = start
  for (const r of mergeRanges(ranges)) {
    if (r.end <= cursor) continue
    if (r.start >= end) break
    if (r.start > cursor) out.push({ start: cursor, end: r.start })
    cursor = Math.max(cursor, r.end)
  }
  if (cursor < end) out.push({ start: cursor, end })
  return out
}

/** Intersect ranges with [start, end), merging the result. */
export function clipRanges(ranges: readonly Range[], start: Us, end: Us): Range[] {
  return mergeRanges(
    ranges.map((r) => ({ start: Math.max(r.start, start), end: Math.min(r.end, end) })),
  )
}

const FILLERS = new Set([
  'um',
  'umm',
  'ummm',
  'uh',
  'uhh',
  'uhm',
  'uhmm',
  'er',
  'erm',
  'err',
  'ah',
  'ahh',
  'eh',
  'hmm',
  'hm',
  'hmmm',
  'mm',
  'mmm',
  'mhm',
])

/** Lower-cased word text without surrounding punctuation. */
export const normalizeWord = (text: string): string =>
  text
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .trim()

/** True for hesitation sounds ("um", "uh", "erm", …). */
export const isFillerWord = (text: string): boolean => FILLERS.has(normalizeWord(text))

/**
 * Source ranges covering filler words (flagged or recognised), padded by `padUs` on each side
 * without eating into neighbouring real words. Words must be in one asset's source time.
 */
export function fillerRanges(words: readonly Word[], padUs: Us = 0): Range[] {
  const sorted = words.toSorted((a, b) => a.start - b.start)
  const out: Range[] = []
  sorted.forEach((w, i) => {
    if (!(w.filler || isFillerWord(w.text))) return
    const prev = sorted[i - 1]
    const next = sorted[i + 1]
    const lo = prev && !(prev.filler || isFillerWord(prev.text)) ? prev.end : -Infinity
    const hi = next && !(next.filler || isFillerWord(next.text)) ? next.start : Infinity
    const start = Math.max(0, Math.max(w.start - padUs, Math.min(lo, w.start)))
    const end = Math.min(w.end + padUs, Math.max(hi, w.end))
    if (end > start) out.push({ start, end })
  })
  return mergeRanges(out)
}

/**
 * Turn detected silences into the ranges to KEEP. Each silence longer than `minSilence` is
 * removed except for `padUs` of breathing room kept on both sides of the speech.
 */
export function silenceToKeepRanges(
  silences: readonly Range[],
  duration: Us,
  opts: { padUs?: Us; minSilence?: Us } = {},
): Range[] {
  const pad = opts.padUs ?? 100_000
  const minSilence = opts.minSilence ?? 0
  const remove: Range[] = []
  for (const s of mergeRanges(silences)) {
    if (s.end - s.start < minSilence) continue
    const start = s.start <= 0 ? 0 : s.start + pad
    const end = s.end >= duration ? duration : s.end - pad
    if (end > start) remove.push({ start, end })
  }
  return invertRanges(remove, 0, duration)
}
