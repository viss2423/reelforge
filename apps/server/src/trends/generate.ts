/**
 * Item generation. Two producers feed the live pack:
 *
 * - `remixTemplates` (always, no LLM): re-times the best-matching existing templates to the
 *   tempo of today's top sounds, with the sound named in `musicHint`. Deterministic.
 * - `llmGenerate` (when a local LLM is available): fresh caption styles, hook text presets
 *   and templates written against the day's signals, as closed-vocabulary specs compiled by
 *   catalogue.ts.
 *
 * Reel ideas per topic come from the LLM when available, else from a template-based
 * fallback, so the Trending Now screen is never empty.
 */
import {
  displayTitle,
  type CaptionStylePreset,
  type TemplatePreset,
  type TextPreset,
} from '@reelforge/core'
import { z } from 'zod'
import { editTempo, genreBpm } from './bpm.ts'
import {
  CaptionSpec,
  LIVE_PACK,
  TemplateSpec,
  TextSpec,
  compileCaption,
  compileTemplate,
  compileText,
  listSchema,
  musicTitle,
  slugify,
  uniqueId,
  type Catalogue,
} from './catalogue.ts'
import { normalize, topOf } from './extract.ts'
import type { LlmPort } from './llm-port.ts'
import { bestMatches } from './rank.ts'
import type { TrendSignal } from './types.ts'

/** Where a generated item came from (shown as "from <trend>" in the UI). */
export interface Origin {
  trend: string
  kind: TrendSignal['kind'] | 'mixed'
}

export interface Generated {
  captionStyles: Array<{ item: CaptionStylePreset; origin: Origin }>
  textPresets: Array<{ item: TextPreset; origin: Origin }>
  templates: Array<{ item: TemplatePreset; origin: Origin }>
  hashtags: string[]
  /** LLM throughput of the run (tokens/s), when used. */
  tokensPerSecond?: number
  errors: string[]
}

export interface Sound {
  title: string
  artist?: string | undefined
  bpm: number
  measured: boolean
  weight: number
  genre?: string | undefined
}

/** Top sounds with a tempo (measured, else the genre's typical tempo). */
export const soundsOf = (signals: readonly TrendSignal[], n = 8): Sound[] =>
  topOf(signals, 'sound', n).map((s) => ({
    title: displayTitle(s.text),
    artist: s.meta?.artist,
    bpm: editTempo(s.meta?.bpm ?? genreBpm(s.meta?.genre)),
    measured: s.meta?.bpm !== undefined,
    weight: s.weight,
    ...(s.meta?.genre ? { genre: s.meta.genre } : {}),
  }))

/** Score for a fresh item: hot because it is built from what is trending today. */
const freshScore = (weight: number): number => Math.round(85 + 12 * Math.min(1, weight))

/* ------------------------------------------------------------------ remix (no LLM) */

/**
 * For each of the top sounds, take the existing template that best matches today's formats
 * and aesthetics, and re-cut it on that sound's beat (same number of beats per slot).
 */
export const remixTemplates = (
  cat: Catalogue,
  signals: readonly TrendSignal[],
  taken: Set<string>,
  count = 3,
): Array<{ item: TemplatePreset; origin: Origin }> => {
  const pool = cat.packs.flatMap((m) =>
    m.templates.map((item) => ({ ref: `${m.id}/${item.id}`, item })),
  )
  const style = signals.filter((s) => s.kind === 'format' || s.kind === 'aesthetic')
  const picks = bestMatches(pool, style, count * 2)
  const out: Array<{ item: TemplatePreset; origin: Origin }> = []
  for (const [i, sound] of soundsOf(signals, count).entries()) {
    const pick = picks[i % Math.max(1, picks.length)]
    if (!pick) break
    const t = pick.item
    const oldBpm = t.musicHint?.bpm ?? 120
    const beatsPer = t.slots.map((s) => Math.max(1, Math.round((s.duration * oldBpm) / 60_000_000)))
    const beat = 60_000_000 / sound.bpm
    const slots = t.slots.map((s, j) => {
      const duration = Math.round(beatsPer[j]! * beat)
      const slot = { ...s, duration }
      if (s.transitionIn) {
        const prev = Math.round(beatsPer[j - 1]! * beat)
        const d = Math.max(50_000, Math.min(s.transitionIn.duration, duration / 2, prev / 2))
        if (d <= Math.min(duration, prev) / 2)
          slot.transitionIn = { ...s.transitionIn, duration: Math.round(d) }
        else delete slot.transitionIn
      }
      return slot
    })
    const name = `${t.name} · ${sound.title}`.slice(0, 40)
    out.push({
      item: {
        ...t,
        id: uniqueId(`${t.id}-${sound.title}`, taken),
        name,
        description:
          `${t.description || t.name} Re-cut on the beat of "${sound.title}" (${sound.bpm} BPM).`.slice(
            0,
            200,
          ),
        trendScore: freshScore(sound.weight),
        tags: [...new Set([...t.tags, 'remix', 'beat-sync'])],
        slots,
        musicHint: { title: musicTitle(sound, sound.bpm), bpm: sound.bpm },
      },
      origin: { trend: sound.title, kind: 'sound' },
    })
  }
  return out
}

/* ------------------------------------------------------------------ LLM */

const SYSTEM = `You design content for ReelForge, a 9:16 short-form video editor.
Write ORIGINAL presets inspired by today's trend signals. Never use brand, platform,
creator or song-lyric text in names or sample text. Use only the fonts, refs and values
listed in the prompt. Reply with JSON only, matching the schema.`

/** Compact, prompt-sized description of the day's signals. */
export const signalBrief = (signals: readonly TrendSignal[], sounds: readonly Sound[]): string => {
  const line = (kind: TrendSignal['kind'], n: number) =>
    topOf(signals, kind, n)
      .map((s) => s.text)
      .join(', ') || '(none)'
  return [
    `Formats: ${line('format', 8)}`,
    `Aesthetics/colours: ${line('aesthetic', 8)}`,
    `Caption cues: ${line('caption', 5)}`,
    `Hashtags: ${line('hashtag', 10)}`,
    `Topics: ${line('topic', 10)}`,
    `Sounds: ${sounds.map((s) => `${s.title} (${s.bpm} BPM)`).join('; ') || '(none)'}`,
  ].join('\n')
}

const ask = async <T>(
  llm: LlmPort,
  schema: z.ZodType<{ items: T[] }>,
  jsonSchema: object,
  prompt: string,
  signal: AbortSignal,
  tps: number[],
  maxTokens = 1_800,
): Promise<T[]> => {
  const res = await llm.complete({
    system: SYSTEM,
    prompt,
    schema: jsonSchema,
    maxTokens,
    temperature: 0.8,
    signal,
  })
  tps.push(res.tokensPerSecond)
  const raw = res.json ?? extractJson(res.text)
  const parsed = z.object({ items: z.array(z.unknown()) }).safeParse(raw)
  if (!parsed.success) throw new Error('LLM reply is not {items: [...]}')
  // Keep the valid items of a partly valid reply.
  const ok: T[] = []
  for (const it of parsed.data.items) {
    const one = schema.safeParse({ items: [it] })
    if (one.success) ok.push(...one.data.items)
  }
  return ok
}

/** First JSON object in a free-text reply (models that ignore the schema hint). */
export const extractJson = (text: string): unknown => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

const fontList = (cat: Catalogue): string =>
  [...cat.fonts]
    .map(
      ([f, files]) =>
        `${f} (${[...new Set(files.filter((x) => !x.italic).map((x) => x.weight))].join('/')})`,
    )
    .join(', ')

const originFrom = (tags: readonly string[], signals: readonly TrendSignal[]): Origin => {
  const words = ` ${normalize(tags.join(' '))} `
  const hit = signals.find(
    (s) => s.kind !== 'topic' && s.kind !== 'sound' && words.includes(` ${s.text} `),
  )
  return hit ? { trend: hit.text, kind: hit.kind } : { trend: 'today’s trends', kind: 'mixed' }
}

export interface LlmGenerateOptions {
  llm: LlmPort
  cat: Catalogue
  signals: readonly TrendSignal[]
  taken: Set<string>
  signal: AbortSignal
  counts?: { captions?: number; texts?: number; templates?: number }
}

export const llmGenerate = async (o: LlmGenerateOptions): Promise<Generated> => {
  const { llm, cat, signals, taken, signal } = o
  const counts = { captions: 3, texts: 5, templates: 4, ...o.counts }
  const sounds = soundsOf(signals)
  const brief = signalBrief(signals, sounds)
  const tps: number[] = []
  const out: Generated = {
    captionStyles: [],
    textPresets: [],
    templates: [],
    hashtags: [],
    errors: [],
  }
  const step = async <T>(label: string, fn: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await fn()
    } catch (err) {
      if (signal.aborted) throw err
      out.errors.push(`${label}: ${(err as Error).message}`)
      return []
    }
  }

  const captions = await step('caption styles', () =>
    ask(
      llm,
      z.object({ items: z.array(CaptionSpec) }),
      listSchema(CaptionSpec, counts.captions),
      `${brief}\n\nFonts (family (weights)): ${fontList(cat)}\n\nCreate ${counts.captions} caption styles that fit these trends. Colours are #RRGGBB. Tags: 2-4 lowercase trend words (formats/aesthetics above).`,
      signal,
      tps,
    ),
  )
  for (const spec of captions.slice(0, counts.captions)) {
    const id = uniqueId(spec.name, taken)
    out.captionStyles.push({
      item: compileCaption(spec, cat, id, freshScore(0.8)),
      origin: originFrom(spec.tags, signals),
    })
  }

  const texts = await step('text presets', () =>
    ask(
      llm,
      z.object({ items: z.array(TextSpec) }),
      listSchema(TextSpec, counts.texts),
      `${brief}\n\nFonts: ${fontList(cat)}\nAnimationIn refs: ${cat.animations.in.join(', ')}\nAnimationOut refs: ${cat.animations.out.join(', ')}\n\nCreate ${counts.texts} hook text presets: sampleText is a short hook in today's trending phrasing (e.g. formats above), max 6 words.`,
      signal,
      tps,
    ),
  )
  for (const spec of texts.slice(0, counts.texts)) {
    const id = uniqueId(spec.name, taken)
    out.textPresets.push({
      item: compileText(spec, cat, id, freshScore(0.8)),
      origin: originFrom(spec.tags, signals),
    })
  }

  const hookRefs = [...out.textPresets.map((t) => `${LIVE_PACK}/${t.item.id}`), ...cat.textPresets]
  const captionRefs = [
    ...out.captionStyles.map((c) => `${LIVE_PACK}/${c.item.id}`),
    ...cat.captionStyles,
  ]
  const templates = await step('templates', () =>
    ask(
      llm,
      z.object({ items: z.array(TemplateSpec) }),
      listSchema(TemplateSpec, counts.templates),
      `${brief}\n\nTransitions: cut, ${['whip', 'flash', 'glitch', 'spin', 'zoomin', 'fade', 'dissolve', 'slideleft', 'slideup', 'smoothleft', 'circleopen', 'pixelize'].join(', ')}\nEffect refs: ${cat.effects.join(', ')}\nFilter refs: ${cat.filters.join(', ')}\nHook preset refs: ${hookRefs.join(', ')}\nCaption style refs: ${captionRefs.join(', ')}\n\nCreate ${counts.templates} reel templates for today's formats. Use a listed sound name and its BPM when one fits (else sound ""). Slots are whole beats (1-16); 4-12 slots; total 8-30 seconds. "trend" names the format/aesthetic/topic it is built for.`,
      signal,
      tps,
      2_600,
    ),
  )
  for (const spec of templates.slice(0, counts.templates)) {
    const sound = sounds.find((s) => normalize(s.title) === normalize(spec.sound))
    const id = uniqueId(spec.name, taken)
    out.templates.push({
      item: compileTemplate(
        spec,
        cat,
        { textPresets: hookRefs, captionStyles: captionRefs },
        id,
        freshScore(sound?.weight ?? 0.7),
        sound,
      ),
      origin: spec.trend
        ? { trend: normalize(spec.trend), kind: 'mixed' }
        : originFrom(spec.tags, signals),
    })
  }

  const tags = await step('hashtags', () =>
    ask(
      llm,
      z.object({ items: z.array(z.string().max(40)) }),
      listSchema(z.string().max(40), 20),
      `${brief}\n\nSuggest 20 hashtags (without #) a creator could add today; mix broad and niche; lowercase; no brand names.`,
      signal,
      tps,
      400,
    ),
  )
  out.hashtags = [
    ...new Set(tags.map((t) => slugify(t).replaceAll('-', '')).filter((t) => t.length >= 3)),
  ]
  if (tps.length)
    out.tokensPerSecond = Math.round((tps.reduce((a, b) => a + b, 0) / tps.length) * 10) / 10
  return out
}

/* ------------------------------------------------------------------ reel ideas */

export const ReelIdea = z.object({
  topic: z.string().max(80),
  title: z.string().max(60),
  hooks: z.array(z.string().max(80)).min(1).max(3),
  shots: z.array(z.string().max(100)).min(2).max(6),
  caption: z.string().max(220),
  hashtags: z.array(z.string().max(40)).max(8),
  template: z.string(),
})
export type ReelIdea = z.infer<typeof ReelIdea>

const HOOKS = [
  'POV: you just found out about {t}',
  'Nobody is talking about this part of {t}',
  'Things I wish I knew about {t}',
  'Wait for the end: {t}',
  'Rating every {t} take so you don’t have to',
]

/** LLM-free ideas: hook formulas + the best-matching template's own structure. */
export const fallbackIdea = (
  topic: string,
  templates: ReadonlyArray<{ ref: string; item: TemplatePreset }>,
  signals: readonly TrendSignal[],
): ReelIdea => {
  const pick = bestMatches(
    templates,
    [
      ...signals.filter((s) => s.kind !== 'topic'),
      { kind: 'topic', text: topic, weight: 1, sources: [] },
    ],
    1,
  )[0]
  const t = pick?.item
  let seed = 7
  for (let i = 0; i < topic.length; i++) seed = (seed * 31 + topic.charCodeAt(i)) >>> 0
  const hooks = [0, 1, 2].map((k) => HOOKS[(seed + k) % HOOKS.length]!.replace('{t}', topic))
  const shots = (t?.slots ?? [])
    .slice(0, 5)
    .map((s, i) =>
      s.text?.text
        ? `Clip ${i + 1}: on-screen text “${s.text.text}”`
        : `Clip ${i + 1}: ${s.kind === 'image' ? 'photo' : 'video'} about ${topic} (${(s.duration / 1e6).toFixed(1)} s)`,
    )
  const tagWords = topic
    .split(' ')
    .filter((w) => w.length > 2)
    .join('')
  return {
    topic,
    title: displayTitle(topic).slice(0, 60),
    hooks,
    shots: shots.length >= 2 ? shots : [`Hook shot about ${topic}`, 'Payoff shot'],
    caption: `${hooks[0]} 👀`,
    hashtags: [...new Set([tagWords, ...topOf(signals, 'hashtag', 4).map((s) => s.text)])]
      .filter(Boolean)
      .slice(0, 6),
    template: pick?.ref ?? '',
  }
}

/** Ideas for `topics`: one LLM call for all of them, falling back per topic. */
export const reelIdeas = async (o: {
  llm: LlmPort | undefined
  topics: readonly string[]
  templates: ReadonlyArray<{ ref: string; item: TemplatePreset }>
  signals: readonly TrendSignal[]
  signal: AbortSignal
}): Promise<{ ideas: ReelIdea[]; usedLlm: boolean; error?: string }> => {
  const refs = o.templates.map((t) => t.ref)
  let fromLlm: ReelIdea[] = []
  let error: string | undefined
  if (o.llm && o.topics.length) {
    try {
      const res = await o.llm.complete({
        system: SYSTEM,
        prompt: `${signalBrief(o.signals, soundsOf(o.signals))}\n\nTemplate refs (name): ${o.templates
          .slice(0, 30)
          .map((t) => `${t.ref} (${t.item.name})`)
          .join(
            ', ',
          )}\n\nFor each topic write one reel idea: 3 hook lines, a 3-6 step shot list, a caption, up to 8 hashtags (no #) and the best template ref.\nTopics:\n${o.topics.map((t) => `- ${t}`).join('\n')}`,
        schema: listSchema(ReelIdea, o.topics.length),
        maxTokens: 400 * o.topics.length + 200,
        temperature: 0.7,
        signal: o.signal,
      })
      const raw = res.json ?? extractJson(res.text)
      const items = z.object({ items: z.array(z.unknown()) }).safeParse(raw)
      fromLlm = (items.success ? items.data.items : []).flatMap((it) => {
        const p = ReelIdea.safeParse(it)
        return p.success ? [p.data] : []
      })
    } catch (err) {
      if (o.signal.aborted) throw err
      error = (err as Error).message
    }
  }
  const ideas = o.topics.map((topic) => {
    const llmIdea = fromLlm.find((i) => normalize(i.topic) === normalize(topic))
    const fb = fallbackIdea(topic, o.templates, o.signals)
    if (!llmIdea) return fb
    return {
      ...llmIdea,
      topic,
      template: refs.includes(llmIdea.template) ? llmIdea.template : fb.template,
      hashtags: llmIdea.hashtags.map((h) => h.replace(/^#/, '')),
    }
  })
  return { ideas, usedLlm: fromLlm.length > 0, ...(error ? { error } : {}) }
}
