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

/** `beats` → beat and bar-start times (source time) and tempo. */
export const readBeats = (result: unknown): { beats: Us[]; downbeats: Us[]; bpm: number } => {
  if (!isObj(result)) throw bad('beats')
  return {
    beats: usList(result.beats, 'beats').sort((a, b) => a - b),
    downbeats:
      result.downbeats === undefined ? [] : usList(result.downbeats, 'beats').sort((a, b) => a - b),
    bpm: typeof result.bpm === 'number' ? result.bpm : 0,
  }
}

/** `scenes` → cut times (source time). */
export const readScenes = (result: unknown): Us[] => {
  if (!isObj(result)) throw bad('scenes')
  return usList(result.scenes, 'scenes').sort((a, b) => a - b)
}

/**
 * `reframe` → subject path ({ t: source µs, x: 0..1 of the source width, w?: visible width
 * 0..1 when a group has to stay in frame }).
 */
export const readReframe = (result: unknown): { t: Us; x: number; w?: number }[] => {
  if (!isObj(result) || !Array.isArray(result.path)) throw bad('reframe')
  const out: { t: Us; x: number; w?: number }[] = []
  const unit = (v: number) => Math.min(1, Math.max(0, v))
  for (const p of result.path) {
    if (isObj(p) && isUs(p.t) && typeof p.x === 'number' && Number.isFinite(p.x)) {
      const w = typeof p.w === 'number' && Number.isFinite(p.w) && p.w > 0 ? unit(p.w) : undefined
      out.push({ t: Math.round(p.t), x: unit(p.x), ...(w !== undefined ? { w } : {}) })
    }
  }
  return out
}

/** One chosen moment of a highlights variant (source time). */
export interface HighlightMoment {
  assetId: string
  start: Us
  end: Us
  role: 'hook' | 'value' | 'payoff'
  reason: string
}

export interface HighlightVariant {
  id: string
  label: string
  moments: HighlightMoment[]
  duration: Us
}

export interface Highlights {
  ranker: 'llm' | 'heuristic'
  variants: HighlightVariant[]
}

const ROLES = new Set(['hook', 'value', 'payoff'])

/** `highlights` → variants of story-ordered moments. */
export const readHighlights = (result: unknown): Highlights => {
  if (!isObj(result) || !Array.isArray(result.variants)) throw bad('highlights')
  const variants: HighlightVariant[] = []
  for (const v of result.variants) {
    if (!isObj(v) || !Array.isArray(v.moments)) continue
    const moments: HighlightMoment[] = []
    for (const m of v.moments) {
      if (!isObj(m) || typeof m.assetId !== 'string' || !isUs(m.start) || !isUs(m.end)) continue
      if (m.end <= m.start) continue
      moments.push({
        assetId: m.assetId,
        start: Math.round(m.start),
        end: Math.round(m.end),
        role:
          typeof m.role === 'string' && ROLES.has(m.role)
            ? (m.role as HighlightMoment['role'])
            : 'value',
        reason: typeof m.reason === 'string' ? m.reason : '',
      })
    }
    if (!moments.length) continue
    variants.push({
      id: typeof v.id === 'string' ? v.id : `v${variants.length}`,
      label: typeof v.label === 'string' ? v.label : `Version ${variants.length + 1}`,
      moments,
      duration: moments.reduce((n, m) => n + m.end - m.start, 0),
    })
  }
  if (!variants.length) throw bad('highlights')
  return { ranker: result.ranker === 'llm' ? 'llm' : 'heuristic', variants }
}

export interface Copy {
  hooks: string[]
  caption: string
  hashtags: string[]
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : []

/** `copywriter` → hook lines, caption, hashtags. */
export const readCopy = (result: unknown): Copy => {
  if (!isObj(result)) throw bad('copywriter')
  const hooks = strings(result.hooks)
  if (!hooks.length) throw bad('copywriter')
  return {
    hooks,
    caption: typeof result.caption === 'string' ? result.caption : '',
    hashtags: strings(result.hashtags),
  }
}

export interface Emphasis {
  marks: { index: number; emoji?: string }[]
  chapters: { index: number; title: string }[]
}

/** `emphasis` → caption word indices to highlight (+ emoji) and chapter starts. */
export const readEmphasis = (result: unknown): Emphasis => {
  if (!isObj(result) || !Array.isArray(result.marks)) throw bad('emphasis')
  const marks: Emphasis['marks'] = []
  for (const m of result.marks) {
    if (!isObj(m) || !isUs(m.index)) continue
    marks.push({
      index: Math.round(m.index),
      ...(typeof m.emoji === 'string' && m.emoji ? { emoji: m.emoji } : {}),
    })
  }
  const chapters: Emphasis['chapters'] = []
  for (const c of Array.isArray(result.chapters) ? result.chapters : []) {
    if (isObj(c) && isUs(c.index) && typeof c.title === 'string' && c.title.trim())
      chapters.push({ index: Math.round(c.index), title: c.title.trim() })
  }
  return { marks, chapters }
}
