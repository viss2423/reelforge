/**
 * Source-time range helpers for silence / filler removal (half-open [start, end), µs).
 * Mirrors the range algebra core uses so previews ("saves 8.4 s") match what the cut does.
 */
import type { Range, Us, Word } from '@reelforge/core'

/** Sort, drop empty ranges and merge overlapping or touching ones. */
export const mergeRanges = (ranges: readonly Range[]): Range[] => {
  const sorted = ranges.filter((r) => r.end > r.start).toSorted((a, b) => a.start - b.start)
  const out: Range[] = []
  for (const r of sorted) {
    const last = out.at(-1)
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else out.push({ start: r.start, end: r.end })
  }
  return out
}

/** Total length of `ranges` intersected with [lo, hi). Ranges must be merged. */
export const overlapLength = (ranges: readonly Range[], lo: Us, hi: Us): Us => {
  let sum = 0
  for (const r of ranges) {
    if (r.end <= lo) continue
    if (r.start >= hi) break
    sum += Math.min(r.end, hi) - Math.max(r.start, lo)
  }
  return sum
}

/** Ranges (merged) that intersect [lo, hi), clipped to it. */
export const clipRanges = (ranges: readonly Range[], lo: Us, hi: Us): Range[] => {
  const out: Range[] = []
  for (const r of ranges) {
    if (r.end <= lo) continue
    if (r.start >= hi) break
    out.push({ start: Math.max(r.start, lo), end: Math.min(r.end, hi) })
  }
  return out
}

/** Hesitation sounds recognised even when the transcriber did not flag them. */
const FILLERS = new Set([
  'um',
  'umm',
  'uh',
  'uhh',
  'uhm',
  'er',
  'erm',
  'ah',
  'ahh',
  'eh',
  'hmm',
  'hm',
  'mm',
  'mmm',
  'mhm',
])

export const normalizeWord = (text: string): string =>
  text
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .trim()

export const isFiller = (w: Pick<Word, 'text' | 'filler'>): boolean =>
  w.filler || FILLERS.has(normalizeWord(w.text))

/**
 * Source ranges covering filler words, padded by `pad` on each side without eating into
 * neighbouring real words.
 */
export const fillerRanges = (words: readonly Word[], pad: Us = 40_000): Range[] => {
  const sorted = words.toSorted((a, b) => a.start - b.start)
  const out: Range[] = []
  for (let i = 0; i < sorted.length; i++) {
    const w = sorted[i]!
    if (!isFiller(w)) continue
    const prev = sorted[i - 1]
    const next = sorted[i + 1]
    const lo = prev && !isFiller(prev) ? Math.min(prev.end, w.start) : 0
    const hi = next && !isFiller(next) ? Math.max(next.start, w.end) : Number.POSITIVE_INFINITY
    const start = Math.max(lo, w.start - pad, 0)
    const end = Math.min(hi, w.end + pad)
    if (end > start) out.push({ start, end })
  }
  return mergeRanges(out)
}
