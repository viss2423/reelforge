/**
 * Highlights: pick the hook and the best moments of the footage, in story order (hook →
 * value → payoff), and fit them to a 15/30/60 s reel. The LLM ranks numbered segments
 * (sentences or shots, never raw timestamps, so every answer maps onto real cut points);
 * without an LLM a heuristic ranker (speech density, attention words, visual quality) is
 * used. Fitting to the target length, variants and boundaries are deterministic code.
 */
import type { Us } from '@reelforge/core'
import { z } from 'zod'
import { buildSegments, isCta, type Segment, type SourceInput } from './segments.ts'
import type { LlmPort } from './types.ts'

export type MomentRole = 'hook' | 'value' | 'payoff'

export interface Moment {
  assetId: string
  start: Us
  end: Us
  role: MomentRole
  reason: string
  /** 0..1 */
  score: number
  /** Segment id this came from. */
  segment: number
}

export interface Variant {
  id: 'story' | 'punchy' | 'chrono'
  label: string
  moments: Moment[]
  /** Sum of moment lengths (µs). */
  duration: Us
}

export interface Ranking {
  ranker: 'llm' | 'heuristic'
  hook: { id: number; why: string }
  /** Story order, excluding the hook. */
  moments: Array<{ id: number; score: number; why: string }>
}

export interface HighlightsResult {
  ranker: Ranking['ranker']
  target: Us
  segments: number
  variants: Variant[]
  /** LLM stats when the LLM ranked. */
  model?: string
  tokensPerSecond?: number
  ms: number
}

/* ------------------------------------------------------------------ prompt */

/** Most segments shown to the model (long inputs are pre-filtered by heuristic score). */
export const MAX_PROMPT_SEGMENTS = 80
const MAX_TEXT = 140

const secs = (us: Us): string => (us / 1_000_000).toFixed(1)

/** Pre-filter to the best `max` segments, kept in timeline order. */
export const promptSegments = (segs: readonly Segment[], max = MAX_PROMPT_SEGMENTS): Segment[] => {
  if (segs.length <= max) return [...segs]
  const keep = new Set(
    segs
      .toSorted((a, b) => b.score - a.score)
      .slice(0, max)
      .map((s) => s.id),
  )
  return segs.filter((s) => keep.has(s.id))
}

export const HIGHLIGHTS_SYSTEM =
  'You are a top short-form video editor (Reels, TikTok, Shorts). You pick the moments that keep viewers watching. ' +
  'Hook: the single most attention-grabbing moment (a bold claim, surprising fact, question, conflict or striking visual) — it plays first. ' +
  'Then the moments that deliver value or story, in an order that makes sense, ending with a payoff (conclusion, punchline, result or call to action). ' +
  'Skip greetings, filler, repetition and setup that needs missing context. Reasons: 2–5 words, in English.'

export interface HighlightsPromptInput {
  segments: readonly Segment[]
  target: Us
  vibe?: string
  topic?: string
}

export const highlightsPrompt = (i: HighlightsPromptInput): string => {
  const lines = i.segments.map((s) => {
    const text = s.text.length > MAX_TEXT ? `${s.text.slice(0, MAX_TEXT - 1)}…` : s.text
    return `#${s.id} (${secs(s.end - s.start)}s) ${s.kind === 'speech' ? `"${text}"` : text}`
  })
  return [
    `Make a ${Math.round(i.target / 1_000_000)} second reel from this footage.`,
    ...(i.topic ? [`Topic: ${i.topic}.`] : []),
    ...(i.vibe ? [`Vibe: ${i.vibe}.`] : []),
    'Segments (id, length, content):',
    ...lines,
    '',
    `Pick the hook and then the moments in story order. Their lengths should add up to about ${Math.round(i.target / 1_000_000)} s.`,
  ].join('\n')
}

/** JSON Schema for the LLM answer; segment ids are an enum so every id is valid. */
export const highlightsSchema = (ids: readonly number[], maxMoments: number): object => ({
  type: 'object',
  properties: {
    hook: {
      type: 'object',
      properties: { id: { type: 'integer', enum: ids }, why: { type: 'string', maxLength: 40 } },
      required: ['id', 'why'],
      additionalProperties: false,
    },
    moments: {
      type: 'array',
      minItems: 1,
      maxItems: maxMoments,
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer', enum: ids },
          score: { type: 'integer', minimum: 1, maximum: 10 },
          why: { type: 'string', maxLength: 40 },
        },
        required: ['id', 'score', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['hook', 'moments'],
  additionalProperties: false,
})

const LlmAnswer = z.object({
  hook: z.object({ id: z.number().int(), why: z.string() }),
  moments: z.array(z.object({ id: z.number().int(), score: z.number(), why: z.string() })),
})

/** Validates the model's answer against the segment set (drops unknown/duplicate ids). */
export const parseRanking = (json: unknown, segs: readonly Segment[]): Ranking => {
  const a = LlmAnswer.parse(json)
  const valid = new Set(segs.map((s) => s.id))
  if (!valid.has(a.hook.id)) throw new Error('the model chose an unknown hook segment')
  const seen = new Set([a.hook.id])
  const moments: Ranking['moments'] = []
  for (const m of a.moments) {
    if (!valid.has(m.id) || seen.has(m.id)) continue
    seen.add(m.id)
    moments.push({ id: m.id, score: Math.min(1, Math.max(0, m.score / 10)), why: m.why.trim() })
  }
  return { ranker: 'llm', hook: { id: a.hook.id, why: a.hook.why.trim() }, moments }
}

/* ------------------------------------------------------------------ heuristic ranker */

const len = (s: Segment): Us => s.end - s.start

/** Ranking without an LLM: best short, punchy segment as the hook; best others in time order. */
export const heuristicRanking = (segs: readonly Segment[]): Ranking => {
  if (!segs.length) throw new Error('nothing to choose from')
  const hookable = segs.filter((s) => len(s) <= 6_000_000)
  const hook = (hookable.length ? hookable : segs).reduce((best, s) =>
    s.score > best.score ? s : best,
  )
  const rest = segs.filter((s) => s.id !== hook.id).toSorted((a, b) => b.score - a.score)
  const moments = rest
    .slice(0, 40)
    .toSorted((a, b) => a.id - b.id)
    .map((s) => ({
      id: s.id,
      score: s.score,
      why: s.kind === 'speech' ? 'clear, dense speech' : 'strong visual',
    }))
  return {
    ranker: 'heuristic',
    hook: {
      id: hook.id,
      why: hook.kind === 'speech' ? 'attention-grabbing line' : 'eye-catching shot',
    },
    moments,
  }
}

/* ------------------------------------------------------------------ fitting */

/** Longest hook (speech is cut at a word end; visuals are trimmed). */
const HOOK_MAX_SPEECH: Us = 5_000_000
const HOOK_MAX_VISUAL: Us = 2_000_000

/** Model picks shorter than this share of the target get topped up with heuristic picks. */
const FILL_BELOW = 0.6
const FILL_MIN_SCORE = 0.35

/** Shortens a segment to at most `max`, at a word end for speech. */
export const trimSegment = (s: Segment, max: Us): { start: Us; end: Us } => {
  if (len(s) <= max) return { start: s.start, end: s.end }
  if (s.kind === 'speech' && s.wordEnds?.length) {
    const fits = s.wordEnds.filter((e) => e - s.start <= max)
    const end = fits.at(-1) ?? s.wordEnds[0]!
    return { start: s.start, end: Math.max(end, s.start + 1) }
  }
  return { start: s.start, end: s.start + max }
}

export interface FitOptions {
  target: Us
  /** Cap per moment (punchy variant). */
  maxMoment?: Us
  /** Ignore the ranking order and use timeline order after the hook. */
  chronological?: boolean
}

/** Turns a ranking into moments that add up to ≈ target. */
export const fitToTarget = (segs: readonly Segment[], rank: Ranking, o: FitOptions): Moment[] => {
  const byId = new Map(segs.map((s) => [s.id, s]))
  const hookSeg = byId.get(rank.hook.id)
  if (!hookSeg) return []
  const hookRange = trimSegment(
    hookSeg,
    Math.min(
      o.maxMoment ?? Infinity,
      hookSeg.kind === 'speech' ? HOOK_MAX_SPEECH : HOOK_MAX_VISUAL,
    ),
  )
  const out: Moment[] = [
    {
      assetId: hookSeg.assetId,
      ...hookRange,
      role: 'hook',
      reason: rank.hook.why,
      score: Math.max(hookSeg.score, 0.8),
      segment: hookSeg.id,
    },
  ]
  let total = hookRange.end - hookRange.start
  const slack = Math.max(1_000_000, o.target * 0.08)
  const reasons = new Map(rank.moments.map((m) => [m.id, m]))
  // Ranked picks first; the heuristic's best (never weak segments the model left out) only
  // tops up a reel the model left far too short.
  const ranked = rank.moments.map((m) => m.id)
  const rankedLen = ranked.reduce((n, id) => {
    const s = byId.get(id)
    return n + (s ? Math.min(len(s), o.maxMoment ?? Infinity) : 0)
  }, total)
  const topUp =
    rank.ranker === 'heuristic' || rankedLen < o.target * FILL_BELOW
      ? segs
          .filter((s) => !reasons.has(s.id) && !s.weak && s.score >= FILL_MIN_SCORE)
          .toSorted((a, b) => b.score - a.score)
          .map((s) => s.id)
      : []
  const order = [...ranked, ...topUp]
  const chosen: Array<{ seg: Segment; range: { start: Us; end: Us } }> = []
  for (const id of order) {
    if (id === hookSeg.id) continue
    const seg = byId.get(id)
    if (!seg) continue
    if (total >= o.target - 500_000) break
    const range = trimSegment(seg, o.maxMoment ?? Infinity)
    const d = range.end - range.start
    if (total + d > o.target + slack) {
      // A long sentence that does not fit: try it shortened at a word boundary.
      const room = o.target + slack - total
      if (room < 1_200_000 || seg.kind === 'image') continue
      const cut = trimSegment(seg, room)
      if (cut.end - cut.start < 1_000_000) continue
      chosen.push({ seg, range: cut })
      total += cut.end - cut.start
      continue
    }
    chosen.push({ seg, range })
    total += d
  }
  if (o.chronological) chosen.sort((a, b) => a.seg.id - b.seg.id)
  else {
    // Model picks keep the model's story order; filler goes to its timeline position.
    const ranked = chosen.filter((c) => reasons.has(c.seg.id))
    const filler = chosen.filter((c) => !reasons.has(c.seg.id))
    for (const f of filler) {
      const at = ranked.findIndex((r) => r.seg.id > f.seg.id)
      ranked.splice(at < 0 ? ranked.length : at, 0, f)
    }
    chosen.splice(0, chosen.length, ...ranked)
  }
  // A call to action is the natural ending.
  const cta = chosen.findIndex((c) => isCta(c.seg))
  if (cta >= 0 && cta < chosen.length - 1) chosen.push(...chosen.splice(cta, 1))
  chosen.forEach((c, i) => {
    const r = reasons.get(c.seg.id)
    out.push({
      assetId: c.seg.assetId,
      ...c.range,
      role: i === chosen.length - 1 && chosen.length > 1 ? 'payoff' : 'value',
      reason: r?.why ?? (c.seg.kind === 'speech' ? 'supporting moment' : 'visual variety'),
      score: r?.score ?? c.seg.score,
      segment: c.seg.id,
    })
  })
  return out
}

const sumLen = (ms: readonly Moment[]): Us => ms.reduce((n, m) => n + (m.end - m.start), 0)
const key = (ms: readonly Moment[]): string =>
  ms.map((m) => `${m.segment}:${m.start}:${m.end}`).join('|')

/** Story (ranked order), Fast & punchy (short moments), In order (chronological). */
export const buildVariants = (segs: readonly Segment[], rank: Ranking, target: Us): Variant[] => {
  const speech = segs.some((s) => s.kind === 'speech')
  const defs: Array<{ id: Variant['id']; label: string; o: FitOptions }> = [
    { id: 'story', label: 'Story', o: { target } },
    {
      id: 'punchy',
      label: 'Fast & punchy',
      o: { target, maxMoment: speech ? 4_000_000 : 1_500_000 },
    },
    { id: 'chrono', label: 'In order', o: { target, chronological: true } },
  ]
  const out: Variant[] = []
  const seen = new Set<string>()
  for (const d of defs) {
    const moments = fitToTarget(segs, rank, d.o)
    const k = key(moments)
    if (!moments.length || seen.has(k)) continue
    seen.add(k)
    out.push({ id: d.id, label: d.label, moments, duration: sumLen(moments) })
  }
  return out
}

/* ------------------------------------------------------------------ orchestration */

export interface HighlightsInput {
  sources: readonly SourceInput[]
  target: Us
  vibe?: string
  topic?: string
  llm?: LlmPort
  signal?: AbortSignal
}

/** Segments → ranking (LLM, else heuristic) → variants. */
export const computeHighlights = async (i: HighlightsInput): Promise<HighlightsResult> => {
  const started = performance.now()
  const segs = buildSegments(i.sources)
  if (!segs.length) throw new Error('There is nothing long enough to cut a reel from')
  let rank: Ranking | undefined
  let stats: Pick<HighlightsResult, 'model' | 'tokensPerSecond'> = {}
  if (i.llm && segs.length > 1 && (await i.llm.available())) {
    const shown = promptSegments(segs)
    const maxMoments = Math.min(shown.length - 1, Math.max(3, Math.ceil(i.target / 2_000_000)))
    const r = await i.llm.complete({
      system: HIGHLIGHTS_SYSTEM,
      prompt: highlightsPrompt({
        segments: shown,
        target: i.target,
        ...(i.vibe ? { vibe: i.vibe } : {}),
        ...(i.topic ? { topic: i.topic } : {}),
      }),
      schema: highlightsSchema(
        shown.map((s) => s.id),
        Math.max(1, maxMoments),
      ),
      maxTokens: 120 + maxMoments * 40,
      temperature: 0.2,
      ...(i.signal ? { signal: i.signal } : {}),
    })
    rank = parseRanking(r.json, segs)
    const info = await i.llm.info?.()
    stats = { tokensPerSecond: r.tokensPerSecond, ...(info ? { model: info.model } : {}) }
  }
  rank ??= heuristicRanking(segs)
  return {
    ranker: rank.ranker,
    target: i.target,
    segments: segs.length,
    variants: buildVariants(segs, rank, i.target),
    ...stats,
    ms: Math.round(performance.now() - started),
  }
}
