/**
 * Acoustic refinement of word boundaries with 10 ms RMS levels of the same audio.
 *
 * Whisper's DTW alignment places word ENDS well (±40 ms on TTS ground truth) but cannot tell
 * where a word starts after a pause: the provisional start is the previous word's end. The
 * level envelope can — speech onsets are sharp. Measured on SAPI speech with known word
 * times: start MAE drops from 220 ms (raw DTW) to ≈45 ms.
 */
import { FRAME_US, speechLevel } from '../silence.ts'
import type { RawWord } from './whisper-json.ts'

/** A pause shorter than this inside a word interval is a stop consonant, not silence. */
const MIN_GAP_US = 40_000
/** Words never shrink below this. */
const MIN_WORD_US = 30_000
/** Upper bound on a word's duration when no pause can be found (noisy/music beds). */
const maxWordUs = (text: string): number => 400_000 + 90_000 * Math.min(20, text.length)

/** Silence threshold for word boundaries: well below speech so soft consonants survive. */
export const boundaryThreshold = (levels: Float32Array): number => {
  const speech = speechLevel(levels)
  return speech === undefined ? -50 : Math.max(-55, speech - 30)
}

export interface RefineOptions {
  /** dBFS; default derived from the levels. */
  thresholdDb?: number
  /** Drop words whose interval is completely silent and whose confidence is below this. */
  hallucinationConfidence?: number
}

/**
 * Refine word starts/ends in place and drop likely hallucinations (words placed entirely in
 * silence with low confidence — whisper's classic "Thank you." on a quiet tail).
 * Words must be time-ordered. Returns the kept words.
 */
export const refineWithLevels = <W extends RawWord>(
  words: W[],
  levels: Float32Array,
  opts: RefineOptions = {},
): W[] => {
  if (levels.length === 0) return words
  const thr = opts.thresholdDb ?? boundaryThreshold(levels)
  const loud = (us: number): boolean => (levels[Math.floor(us / FRAME_US)] ?? -120) >= thr
  const minGapFrames = MIN_GAP_US / FRAME_US
  const dropBelow = opts.hallucinationConfidence ?? 0.5
  const kept: W[] = []
  for (const w of words) {
    let start = w.start
    let end = Math.max(w.end, start + MIN_WORD_US)
    const latestStart = end - MIN_WORD_US

    // Onset: the first loud frame after the last pause inside [start, end - MIN].
    let run = 0
    let anyLoud = false
    for (let t = start; t < latestStart; t += FRAME_US) {
      if (loud(t)) {
        if (run >= minGapFrames || !anyLoud) start = t
        anyLoud = true
        run = 0
      } else {
        run++
      }
    }
    if (!anyLoud && run >= minGapFrames) start = latestStart

    // Offset: trim a trailing pause (DTW ends occasionally run into the following silence).
    let lastLoud = -1
    for (let t = start; t < end; t += FRAME_US) if (loud(t)) lastLoud = t
    if (lastLoud >= 0 && end - (lastLoud + FRAME_US) >= 2 * MIN_GAP_US) {
      end = Math.max(start + MIN_WORD_US, lastLoud + FRAME_US + MIN_GAP_US / 2)
    }
    if (end - start > maxWordUs(w.text)) start = end - maxWordUs(w.text)

    const silent = lastLoud < 0 && !anyLoud
    if (silent && w.confidence < dropBelow) continue
    w.start = Math.round(start)
    w.end = Math.round(end)
    kept.push(w)
  }
  return kept
}
