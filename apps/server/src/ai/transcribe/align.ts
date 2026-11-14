/**
 * Hybrid transcription support: transfer word timings from a fast, DTW-timed transcript
 * (small model on the CPU) onto the more accurate text of a large model that only produced
 * segment-level times (FFmpeg's GPU `whisper` filter).
 *
 * Alignment is a semi-global edit-distance DP run per text segment over a monotonic window
 * of timed words, so the cost is linear in the transcript length (no |A|·|B| matrix for an
 * hour of speech). Two-model agreement doubles as the confidence signal: the filter does not
 * expose token probabilities.
 */
import { normalizeWord } from './words.ts'
import type { RawWord, TextSegment } from './whisper-json.ts'

/** Gap (insertion/deletion) cost; a substitution costs 1 - similarity ∈ [0, 1]. */
const GAP = 0.7
/** Cost of skipping one timed word before the segment's first match (tie-breaker only). */
const LEAD_SKIP = 1e-3
/** Timed words this far outside a segment's bounds are not alignment candidates. */
const WINDOW_US = 1_500_000
/** Confidence of words only the large model heard. */
const UNMATCHED_CONFIDENCE = 0.4

/** Similarity of two normalised words in [0, 1] (1 = identical) from Levenshtein distance. */
export const wordSimilarity = (a: string, b: string): number => {
  if (a === b) return 1
  if (!a || !b) return 0
  const n = b.length
  let prev = new Uint16Array(n + 1)
  let cur = new Uint16Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const sub = (prev[j - 1] ?? 0) + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1)
      cur[j] = Math.min(sub, (prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1)
    }
    ;[prev, cur] = [cur, prev]
  }
  return 1 - (prev[n] ?? 0) / Math.max(a.length, n)
}

/**
 * Semi-global alignment of `a` (all must be consumed) against `b` (leading/trailing words may
 * be skipped for free). Returns, for each index of `a`, the matched index of `b` or -1.
 */
export const alignSequences = (a: readonly string[], b: readonly string[]): Int32Array => {
  const n = a.length
  const m = b.length
  const W = m + 1
  const cost = new Float32Array((n + 1) * W)
  // 0 = diagonal, 1 = up (gap in b: a[i] unmatched), 2 = left (b[j] skipped)
  const move = new Uint8Array((n + 1) * W)
  for (let i = 1; i <= n; i++) {
    cost[i * W] = i * GAP
    move[i * W] = 1
  }
  // Leading skips in b are nearly free: the tiny per-word cost breaks ties towards the
  // earliest match, so a repeated phrase ("yes yes … yes yes") is consumed in order.
  for (let j = 1; j <= m; j++) {
    cost[j] = j * LEAD_SKIP
    move[j] = 2
  }
  const sims = new Float32Array(m)
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1] ?? ''
    for (let j = 0; j < m; j++) sims[j] = wordSimilarity(ai, b[j] ?? '')
    for (let j = 1; j <= m; j++) {
      const diag = (cost[(i - 1) * W + j - 1] ?? 0) + 1 - (sims[j - 1] ?? 0)
      const up = (cost[(i - 1) * W + j] ?? 0) + GAP
      // Skipping b words after a's last word is free (trailing words of the window).
      const left = (cost[i * W + j - 1] ?? 0) + (i === n ? 0 : GAP)
      let best = diag
      let mv = 0
      if (up < best) {
        best = up
        mv = 1
      }
      if (left < best) {
        best = left
        mv = 2
      }
      cost[i * W + j] = best
      move[i * W + j] = mv
    }
  }
  const out = new Int32Array(n).fill(-1)
  let i = n
  let j = m
  while (i > 0) {
    const mv = move[i * W + j]
    if (mv === 0 && j > 0) {
      // A diagonal step with zero similarity is really two gaps: keep it as a positional
      // match only — its timing is still the best estimate for that slot.
      out[i - 1] = j - 1
      i--
      j--
    } else if (mv === 2 && j > 0) {
      j--
    } else {
      i--
    }
  }
  return out
}

/** Spread `texts` over [start, end] proportionally to their character length. */
const spread = (texts: readonly string[], start: number, end: number, conf: number): RawWord[] => {
  const weights = texts.map((t) => Math.max(1, normalizeWord(t).length) + 1)
  const total = weights.reduce((s, w) => s + w, 0)
  const span = Math.max(0, end - start)
  const out: RawWord[] = []
  let t = start
  for (let k = 0; k < texts.length; k++) {
    const d = (span * (weights[k] ?? 1)) / total
    out.push({
      text: texts[k] ?? '',
      start: Math.round(t),
      end: Math.round(t + d),
      confidence: conf,
    })
    t += d
  }
  return out
}

/**
 * Give every word of `segments` a time taken from the aligned `timed` words. Words with no
 * counterpart are interpolated between their neighbours (by character length) inside the
 * segment; timed words skipped between two matches extend the preceding word (e.g. "40%"
 * ↔ "40 percent").
 */
export const alignToTimedWords = (
  segments: readonly TextSegment[],
  timed: readonly RawWord[],
): Array<RawWord & { matched: boolean }> => {
  const out: Array<RawWord & { matched: boolean }> = []
  const timedNorm = timed.map((w) => normalizeWord(w.text))
  let ptr = 0
  for (const seg of segments) {
    const texts = seg.text.split(/\s+/).filter((t) => t && /[\p{L}\p{N}]/u.test(t))
    if (texts.length === 0) continue
    // Candidate window: unconsumed timed words that overlap the segment (± WINDOW_US).
    while (ptr < timed.length && (timed[ptr]?.end ?? 0) < seg.start - WINDOW_US) ptr++
    let hi = ptr
    while (hi < timed.length && (timed[hi]?.start ?? 0) < seg.end + WINDOW_US) hi++
    const match = alignSequences(texts.map(normalizeWord), timedNorm.slice(ptr, hi))

    const words: Array<RawWord & { matched: boolean }> = texts.map((text, k) => {
      const j = match[k] ?? -1
      const tw = j >= 0 ? timed[ptr + j] : undefined
      if (!tw) return { text, start: -1, end: -1, confidence: UNMATCHED_CONFIDENCE, matched: false }
      const sim = wordSimilarity(normalizeWord(text), timedNorm[ptr + j] ?? '')
      // Agreement of two independent models: exact → high, partial → scaled.
      const confidence = sim === 1 ? 0.5 + 0.5 * tw.confidence : 0.25 + 0.5 * sim * tw.confidence
      return { text, start: tw.start, end: tw.end, confidence, matched: true }
    })
    // Absorb skipped timed words into the preceding matched word.
    for (let k = 0; k < words.length; k++) {
      const jk = match[k] ?? -1
      if (jk < 0) continue
      let next = -1
      for (let q = k + 1; q < words.length && next < 0; q++) next = match[q] ?? -1
      const lastAbsorbed = (next >= 0 ? next : jk + 1) - 1
      const w = words[k]
      const tEnd = timed[ptr + lastAbsorbed]?.end
      if (w && next >= 0 && lastAbsorbed > jk && tEnd !== undefined) w.end = Math.max(w.end, tEnd)
    }
    // Interpolate unmatched runs between known neighbours (or the segment bounds).
    for (let k = 0; k < words.length;) {
      if (words[k]?.matched) {
        k++
        continue
      }
      let e = k
      while (e < words.length && !words[e]?.matched) e++
      const left = words[k - 1]
      const right = words[e]
      let from = left ? left.end : Math.max(seg.start, out.at(-1)?.end ?? 0)
      let to = right ? right.start : Math.max(from, seg.end)
      if (to - from < 40_000 * (e - k) && left) {
        // No room: share the left neighbour's span with the inserted words.
        from = left.start
        const shared = spread([left.text, ...texts.slice(k, e)], from, Math.max(to, left.end), 0)
        left.end = shared[0]?.end ?? left.end
        from = left.end
        to = Math.max(to, shared.at(-1)?.end ?? to)
      }
      const filled = spread(texts.slice(k, e), from, Math.max(from, to), UNMATCHED_CONFIDENCE)
      for (let q = k; q < e; q++) {
        const f = filled[q - k]
        const w = words[q]
        if (f && w) {
          w.start = f.start
          w.end = f.end
        }
      }
      k = e
    }
    const lastMatch = match.reduce((acc, j) => Math.max(acc, j), -1)
    if (lastMatch >= 0) ptr += lastMatch + 1
    out.push(...words)
  }
  return out
}
