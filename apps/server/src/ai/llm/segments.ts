/**
 * Candidate moments for highlights / Auto Edit. Each source (a clip's asset and the source
 * window it plays) becomes a list of segments the ranker chooses from:
 *
 * - speech: sentences (split on end punctuation, long pauses, or ~12 s), padded slightly so
 *   cuts never clip a word;
 * - visual (B-roll, photo dumps, music-only footage): shots from the cached scene cuts,
 *   long shots chunked into ~3 s pieces;
 * - images: one segment each.
 *
 * Segment ids are dense integers in timeline order, which is what the LLM sees.
 */
import { isFillerWord, isKeyword, type Us, type Word } from '@reelforge/core'

export interface VisualStats {
  /** Mean luma 0..1. */
  brightness: number
  /** Luma standard deviation 0..1. */
  contrast: number
  /** Mean gradient magnitude 0..1 (detail / focus). */
  sharpness: number
  /** Mean absolute change between consecutive samples 0..1 (motion / action). */
  motion: number
}

export interface SourceInput {
  assetId: string
  kind: 'video' | 'image'
  /** Source window the user kept (defaults to the whole asset). */
  start: Us
  end: Us
  words?: readonly Word[]
  /** Shot cuts in source time. */
  scenes?: readonly Us[]
  /** Visual stats sampled along the source (`t` in source µs). */
  visual?: ReadonlyArray<{ t: Us } & VisualStats>
}

export interface Segment {
  id: number
  assetId: string
  kind: 'speech' | 'visual' | 'image'
  start: Us
  end: Us
  /** Transcript text (speech) or a short visual description. */
  text: string
  /** Heuristic quality 0..1 (fallback ranking, tie-breaks, filling to the target). */
  score: number
  visual?: VisualStats
  /** Greeting / housekeeping: never used to pad a reel. */
  weak?: boolean
  /** Word-boundary cut points inside the segment (source µs) for shortening. */
  wordEnds?: Us[]
}

const SENTENCE_END = /[.!?。！？…]["')\]]?$/
const CLAUSE_END = /[,;:，、]$/
const MAX_SENTENCE: Us = 12_000_000
const PAUSE_BREAK: Us = 700_000
const PAD_START: Us = 80_000
const PAD_END: Us = 150_000
const SHOT_CHUNK: Us = 3_000_000
const MIN_SEGMENT: Us = 600_000
/** Image duration used when an image becomes a segment. */
export const IMAGE_SEGMENT: Us = 2_000_000

/** Words per minute below which footage counts as non-speech (music, ambience, mumbles). */
const SPEECH_WPM = 40

export const isSpeechSource = (s: SourceInput): boolean => {
  const words = s.words?.filter((w) => w.start >= s.start && w.end <= s.end && !w.filler) ?? []
  const minutes = Math.max(1, s.end - s.start) / 60_000_000
  return words.length >= 3 && words.length / minutes >= SPEECH_WPM
}

/** Groups words into sentence-like runs. */
export const sentences = (words: readonly Word[]): Word[][] => {
  const out: Word[][] = []
  let cur: Word[] = []
  const flush = () => {
    if (cur.length) out.push(cur)
    cur = []
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    const prev = cur.at(-1)
    if (prev && w.start - prev.end > PAUSE_BREAK) flush()
    else if (cur.length && w.end - cur[0]!.start > MAX_SENTENCE) {
      // Prefer breaking after the last clause boundary in the run.
      const k = cur.findLastIndex((x) => CLAUSE_END.test(x.text.trim()))
      if (k >= 2 && k < cur.length - 1) {
        out.push(cur.slice(0, k + 1))
        cur = cur.slice(k + 1)
      } else flush()
    }
    cur.push(w)
    if (SENTENCE_END.test(w.text.trim())) flush()
  }
  flush()
  return out
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

const HOOK_CUES =
  /\b(how|why|what|secret|never|stop|mistake|nobody|truth|best|worst|you|your|actually|here'?s|imagine|wait|crazy|insane|biggest|only|first|finally|realized)\b/i
/** Greetings / housekeeping that a highlight reel skips (several languages). */
const GREETING =
  /(?:^|[\s,.!?])(hey guys|hi guys|hello|welcome back|welcome to|today i|in this video|let'?s get into|let'?s get started|hola|bienvenid|hallo|willkommen|bonjour|bienvenue|ciao|namaste|that was it|that'?s it for)/iu
const CTA_CUES = /\b(follow|subscribe|comment|share|save|link|bio|like|let me know|part \d|tag)\b/i

/** Greetings, housekeeping and pure filler runs. */
export const isWeak = (words: readonly Word[]): boolean => {
  const content = words.filter((w) => !w.filler && !isFillerWord(w.text))
  return GREETING.test(words.map((w) => w.text).join(' ')) || content.length < 3
}

/** Heuristic score of a sentence: information density, attention words, clarity. */
export const scoreSpeech = (words: readonly Word[]): number => {
  const text = words.map((w) => w.text).join(' ')
  const dur = Math.max(1, words.at(-1)!.end - words[0]!.start) / 1_000_000
  const content = words.filter((w) => !w.filler && !isFillerWord(w.text))
  const fillers = words.length - content.length
  const keywords = content.filter((w) => isKeyword(w.text)).length
  const conf = content.reduce((s, w) => s + w.confidence, 0) / Math.max(1, content.length)
  const pace = content.length / dur // words per second; lively speech ≈ 2.5–3.5
  let s = 0.35 * clamp01(pace / 3.2) + 0.2 * clamp01(keywords / 3) + 0.2 * conf
  if (HOOK_CUES.test(text)) s += 0.12
  if (/[?!]/.test(text)) s += 0.08
  if (content.length < 4) s -= 0.15
  if (GREETING.test(text)) s -= 0.3
  s -= 0.1 * clamp01(fillers / Math.max(1, words.length) / 0.2)
  if (dur > 10) s -= 0.05
  return clamp01(s)
}

/** Visual interest 0..1: well exposed, contrasty, sharp, with some motion. */
export const scoreVisual = (v: VisualStats | undefined): number => {
  if (!v) return 0.5
  const exposure = 1 - Math.min(1, Math.abs(v.brightness - 0.5) / 0.4)
  return clamp01(
    0.3 * exposure +
      0.25 * clamp01(v.contrast / 0.25) +
      0.25 * clamp01(v.sharpness / 0.12) +
      0.2 * clamp01(v.motion / 0.15),
  )
}

const mean = (xs: readonly number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0

/** Averages visual samples within [a, b) (falls back to the nearest sample). */
export const visualOver = (
  samples: SourceInput['visual'],
  a: Us,
  b: Us,
): VisualStats | undefined => {
  if (!samples?.length) return undefined
  let inside = samples.filter((s) => s.t >= a && s.t < b)
  if (!inside.length) {
    const mid = (a + b) / 2
    inside = [
      samples.reduce((best, s) => (Math.abs(s.t - mid) < Math.abs(best.t - mid) ? s : best)),
    ]
  }
  return {
    brightness: mean(inside.map((s) => s.brightness)),
    contrast: mean(inside.map((s) => s.contrast)),
    sharpness: mean(inside.map((s) => s.sharpness)),
    motion: mean(inside.map((s) => s.motion)),
  }
}

/** Short words for the LLM: "bright · detailed · fast motion". */
export const describeVisual = (v: VisualStats | undefined): string => {
  if (!v) return 'footage'
  const parts = [
    v.brightness < 0.25 ? 'dark' : v.brightness > 0.7 ? 'bright' : 'balanced light',
    v.contrast > 0.22 ? 'punchy' : v.contrast < 0.1 ? 'flat' : 'normal contrast',
    v.sharpness > 0.1 ? 'detailed' : v.sharpness < 0.04 ? 'soft' : 'clear',
    v.motion > 0.12 ? 'fast motion' : v.motion < 0.03 ? 'static' : 'some motion',
  ]
  return parts.join(' · ')
}

const speechSegments = (s: SourceInput): Omit<Segment, 'id'>[] => {
  const words = (s.words ?? [])
    .filter((w) => w.end > s.start && w.start < s.end && w.text.trim())
    .toSorted((a, b) => a.start - b.start)
  const out: Omit<Segment, 'id'>[] = []
  let prevEnd = s.start
  for (const run of sentences(words)) {
    // Leading/trailing fillers make weak cut points: trim them off the segment.
    let a = 0
    let b = run.length - 1
    while (a < b && (run[a]!.filler || isFillerWord(run[a]!.text))) a++
    while (b > a && (run[b]!.filler || isFillerWord(run[b]!.text))) b--
    const core = run.slice(a, b + 1)
    const start = Math.max(prevEnd, s.start, core[0]!.start - PAD_START)
    const end = Math.min(s.end, core.at(-1)!.end + PAD_END)
    prevEnd = core.at(-1)!.end
    if (end - start < MIN_SEGMENT) continue
    out.push({
      assetId: s.assetId,
      kind: 'speech',
      start,
      end,
      text: core.map((w) => w.text.trim()).join(' '),
      score: scoreSpeech(core),
      ...(isWeak(core) ? { weak: true } : {}),
      wordEnds: core.map((w) => Math.min(s.end, w.end + PAD_END)),
      ...(s.visual ? { visual: visualOver(s.visual, start, end)! } : {}),
    })
  }
  return out
}

const visualSegments = (s: SourceInput): Omit<Segment, 'id'>[] => {
  const cuts = [
    s.start,
    ...(s.scenes ?? []).filter((t) => t > s.start + MIN_SEGMENT && t < s.end - MIN_SEGMENT),
    s.end,
  ]
  const out: Omit<Segment, 'id'>[] = []
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i]!
    const b = cuts[i + 1]!
    const pieces = Math.max(1, Math.round((b - a) / SHOT_CHUNK))
    const len = (b - a) / pieces
    for (let k = 0; k < pieces; k++) {
      const start = Math.round(a + k * len)
      const end = Math.round(a + (k + 1) * len)
      if (end - start < MIN_SEGMENT) continue
      const v = visualOver(s.visual, start, end)
      out.push({
        assetId: s.assetId,
        kind: 'visual',
        start,
        end,
        text: `[no speech · shot ${i + 1}${pieces > 1 ? ` part ${k + 1}` : ''} · ${describeVisual(v)}]`,
        score: scoreVisual(v),
        ...(v ? { visual: v } : {}),
      })
    }
  }
  return out
}

/** All candidate segments of all sources, ids in timeline order. */
export const buildSegments = (sources: readonly SourceInput[]): Segment[] => {
  const all: Omit<Segment, 'id'>[] = []
  for (const s of sources) {
    if (s.kind === 'image') {
      const v = visualOver(s.visual, 0, 1)
      all.push({
        assetId: s.assetId,
        kind: 'image',
        start: 0,
        end: IMAGE_SEGMENT,
        text: `[photo · ${describeVisual(v)}]`,
        score: scoreVisual(v),
        ...(v ? { visual: v } : {}),
      })
    } else if (isSpeechSource(s)) all.push(...speechSegments(s))
    else all.push(...visualSegments(s))
  }
  return all.map((seg, id) => ({ id, ...seg }))
}

/** True if a segment reads like a call to action (good payoff/ending). */
export const isCta = (seg: Segment): boolean => seg.kind === 'speech' && CTA_CUES.test(seg.text)
