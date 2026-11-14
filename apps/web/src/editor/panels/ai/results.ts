/**
 * Defensive readers for host job results (`job.result` is `unknown` on the wire). A
 * malformed result becomes a clear error instead of a crash deep inside an op. Shapes match
 * the server's AI handlers (apps/server/src/ai).
 */
import type { Range, Us, Word } from '@reelforge/core'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const isUs = (v: unknown): v is Us => typeof v === 'number' && Number.isFinite(v) && v >= 0

const bad = (kind: string): Error => new Error(`The host returned an unexpected ${kind} result`)

const usList = (v: unknown, kind: string): Us[] => {
  if (!Array.isArray(v)) throw bad(kind)
  return v.filter(isUs).map(Math.round)
}

/** `transcribe` → words in the asset's source time. */
export const readTranscript = (result: unknown): { words: Word[]; language?: string } => {
  if (!isObj(result) || !Array.isArray(result.words)) throw bad('transcript')
  const words: Word[] = []
  for (const w of result.words) {
    if (!isObj(w) || typeof w.text !== 'string' || !isUs(w.start) || !isUs(w.end)) continue
    words.push({
      text: w.text,
      start: Math.round(w.start),
      end: Math.round(Math.max(w.end, w.start)),
      confidence: typeof w.confidence === 'number' ? w.confidence : 1,
      filler: w.filler === true,
      emphasis: w.emphasis === true,
      ...(typeof w.emoji === 'string' ? { emoji: w.emoji } : {}),
    })
  }
  return typeof result.language === 'string' ? { words, language: result.language } : { words }
}

/** `silence` → silent source ranges (already padded by the host). */
export const readSilence = (result: unknown): Range[] => {
  if (!isObj(result) || !Array.isArray(result.ranges)) throw bad('silence')
  const out: Range[] = []
  for (const r of result.ranges) {
    if (isObj(r) && isUs(r.start) && isUs(r.end) && r.end > r.start)
      out.push({ start: Math.round(r.start), end: Math.round(r.end) })
  }
  return out
}

/** `beats` → beat times (source time) and tempo. */
export const readBeats = (result: unknown): { beats: Us[]; bpm: number } => {
  if (!isObj(result)) throw bad('beats')
  return {
    beats: usList(result.beats, 'beats').sort((a, b) => a - b),
    bpm: typeof result.bpm === 'number' ? result.bpm : 0,
  }
}

/** `scenes` → cut times (source time). */
export const readScenes = (result: unknown): Us[] => {
  if (!isObj(result)) throw bad('scenes')
  return usList(result.scenes, 'scenes').sort((a, b) => a - b)
}

/** `reframe` → subject path ({ t: source µs, x: 0..1 of the source width }). */
export const readReframe = (result: unknown): { t: Us; x: number }[] => {
  if (!isObj(result) || !Array.isArray(result.path)) throw bad('reframe')
  const out: { t: Us; x: number }[] = []
  for (const p of result.path) {
    if (isObj(p) && isUs(p.t) && typeof p.x === 'number' && Number.isFinite(p.x))
      out.push({ t: Math.round(p.t), x: Math.min(1, Math.max(0, p.x)) })
  }
  return out
}
