/**
 * Parsers for whisper.cpp output:
 * - `whisper-cli -ojf` (full JSON with per-token offsets, probabilities and DTW times);
 * - the FFmpeg `whisper` filter's `format=json` output (one JSON object per segment/line).
 *
 * Word assembly: whisper's byte-level BPE splits words into sub-word tokens; a token that
 * starts with a space begins a new word, punctuation-only tokens attach to the previous
 * word. Languages written without spaces (zh, ja, th, …) get one word per token.
 */

/** A recognised word before post-processing (times in microseconds). */
export interface RawWord {
  text: string
  start: number
  end: number
  /** 0..1 */
  confidence: number
}

export interface WhisperToken {
  text: string
  offsets?: { from: number; to: number }
  p?: number
  /** DTW token time in centiseconds, -1 when unavailable. */
  t_dtw?: number
}

export interface WhisperSegment {
  offsets?: { from: number; to: number }
  text?: string
  tokens?: WhisperToken[]
}

export interface WhisperFullJson {
  result?: { language?: string }
  transcription?: WhisperSegment[]
}

export interface ParsedTranscript {
  language?: string
  words: RawWord[]
  /** True when word times come from DTW alignment (accurate ends, starts need refinement). */
  dtw: boolean
}

/** Languages whose script does not separate words with spaces. */
const NO_SPACE_LANGS = new Set(['zh', 'ja', 'th', 'lo', 'km', 'my', 'yue', 'bo'])

const SPECIAL = /^\[_[A-Z]+_?\d*\]$|^<\|.*\|>$|^\[_TT_\d+\]$/
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u
/** A space-led symbol that opens a word (" $" + "40" → "$40", " (" + "yes" → "(yes"). */
const OPENS_WORD = /^\s[$€£¥₹#@([{"“‘¿¡+]/u
/** A word made only of opening symbols so far: the next lexical token completes it. */
const OPENER_ONLY = /^[$€£¥₹#@([{"“‘¿¡+]+$/u

const MS = 1000

/**
 * Convert `whisper-cli -ojf` JSON into words. When DTW times are present (`-dtw <preset>`),
 * they are used: a token's DTW time marks the END of the token on whisper.cpp's alignment
 * (measured against TTS ground truth), so a word ends at its last lexical token's DTW time
 * and provisionally starts where the previous word ended — `refineWithLevels` later moves
 * starts that follow a pause onto the actual speech onset.
 */
export const parseWhisperFullJson = (json: WhisperFullJson): ParsedTranscript => {
  const language = json.result?.language
  const noSpace = language !== undefined && NO_SPACE_LANGS.has(language)
  const segments = json.transcription ?? []
  const dtw = segments.some((s) => s.tokens?.some((t) => (t.t_dtw ?? -1) >= 0) ?? false)

  interface Acc {
    text: string
    from: number
    to: number
    dtwEnd: number
    pSum: number
    pN: number
  }
  const accs: Acc[] = []
  for (const seg of segments) {
    let segStart = true
    for (const tok of seg.tokens ?? []) {
      const text = tok.text
      if (!text || SPECIAL.test(text.trim())) continue
      const lexical = HAS_WORD_CHAR.test(text)
      const from = tok.offsets?.from ?? seg.offsets?.from ?? 0
      const to = tok.offsets?.to ?? from
      const tDtw = tok.t_dtw ?? -1
      const prev = accs.at(-1)
      // Partial UTF-8 sequences (U+FFFD) are completed by the next token: keep merging.
      const continuesBroken = prev?.text.endsWith('�') ?? false
      const startsWord =
        prev === undefined ||
        (!continuesBroken &&
          (OPENS_WORD.test(text) ||
            (lexical &&
              !OPENER_ONLY.test(prev.text) &&
              (text.startsWith(' ') || noSpace || (segStart && !prev.text.endsWith('-'))))))
      if (startsWord) {
        accs.push({
          text: text.trimStart(),
          from,
          to,
          dtwEnd: lexical && tDtw >= 0 ? tDtw : -1,
          pSum: lexical ? (tok.p ?? 1) : 0,
          pN: lexical ? 1 : 0,
        })
      } else {
        prev.text += text
        prev.to = Math.max(prev.to, to)
        // Punctuation's DTW time often lands in the following pause: ignore it.
        if (lexical && tDtw >= 0) prev.dtwEnd = tDtw
        if (lexical) {
          prev.pSum += tok.p ?? 1
          prev.pN++
        }
      }
      segStart = false
    }
  }

  const words: RawWord[] = []
  let prevEnd = 0
  for (const a of accs) {
    const text = a.text.trim().replace(/�/g, '')
    // Stray punctuation with no word to attach to (e.g. a leading '-') is not a word.
    if (!text || a.pN === 0) continue
    const confidence = Math.min(1, Math.max(0, a.pSum / a.pN))
    if (dtw && a.dtwEnd >= 0) {
      const end = Math.max(prevEnd, a.dtwEnd * 10 * MS)
      words.push({ text, start: prevEnd, end, confidence })
      prevEnd = end
    } else {
      const start = Math.max(prevEnd, a.from * MS)
      const end = Math.max(start, a.to * MS)
      words.push({ text, start, end, confidence })
      prevEnd = end
    }
  }
  return language === undefined ? { words, dtw } : { language, words, dtw }
}

/** One segment from the FFmpeg `whisper` filter (times in us). */
export interface TextSegment {
  start: number
  end: number
  text: string
}

/**
 * Parse the FFmpeg whisper filter's JSON-lines output (`{"start":ms,"end":ms,"text":…}`).
 * Malformed lines are skipped (the filter writes them incrementally; a crash may truncate).
 */
export const parseFfmpegSegments = (jsonl: string): TextSegment[] => {
  const out: TextSegment[] = []
  for (const line of jsonl.split(/\r?\n/)) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    try {
      const o = JSON.parse(s) as { start?: unknown; end?: unknown; text?: unknown }
      if (typeof o.start !== 'number' || typeof o.end !== 'number' || typeof o.text !== 'string')
        continue
      const text = o.text.trim()
      if (text) out.push({ start: o.start * MS, end: Math.max(o.start, o.end) * MS, text })
    } catch {
      // Truncated trailing line: ignore.
    }
  }
  return out
}
