/**
 * Copywriter: three on-screen hook texts, a post caption and 5–10 hashtags, written in the
 * video's language from its transcript (or, for footage without speech, from the topic,
 * vibe and file names).
 */
import { z } from 'zod'
import type { LlmPort } from './types.ts'

export interface CopyResult {
  language: string
  hooks: string[]
  caption: string
  hashtags: string[]
  model?: string
  tokensPerSecond?: number
  ms: number
}

/** Prompt text budget: ~1 500 words covers a 10-minute talk; longer inputs are sampled. */
export const MAX_TRANSCRIPT_CHARS = 9_000

/** Keeps the start, middle and end of a long transcript (where hooks and payoffs live). */
export const condense = (text: string, max = MAX_TRANSCRIPT_CHARS): string => {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const part = Math.floor((max - 10) / 3)
  const mid = Math.floor(t.length / 2 - part / 2)
  return `${t.slice(0, part)} … ${t.slice(mid, mid + part)} … ${t.slice(-part)}`
}

const LANGS: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  pt: 'Portuguese',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  nl: 'Dutch',
  hi: 'Hindi',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  ru: 'Russian',
  ar: 'Arabic',
  tr: 'Turkish',
  pl: 'Polish',
  id: 'Indonesian',
  vi: 'Vietnamese',
  th: 'Thai',
}

/** ISO 639-1 → language name for the prompt ('auto'/unknown → undefined). */
export const languageName = (code: string | undefined): string | undefined =>
  code ? LANGS[code.toLowerCase()] : undefined

export const COPY_SYSTEM =
  'You write viral short-form video copy (Reels, TikTok, Shorts). ' +
  'Hooks are on-screen text for the first seconds: max 8 words, punchy, curiosity or benefit driven, no hashtags, no quotes, no emojis. ' +
  'The caption is 1–3 short sentences with at most 2 emojis that make people watch and comment. ' +
  'Hashtags: 5–10 relevant ones, a mix of broad and niche, lower case, no spaces.'

export interface CopyPromptInput {
  transcript?: string
  topic?: string
  vibe?: string
  names?: readonly string[]
  language?: string
}

export const copyPrompt = (i: CopyPromptInput): string => {
  const lang = languageName(i.language)
  return [
    lang
      ? `Write everything in ${lang}.`
      : 'Write everything in the same language as the transcript (English if there is none).',
    ...(i.topic ? [`Topic: ${i.topic}`] : []),
    ...(i.vibe ? [`Vibe: ${i.vibe}`] : []),
    ...(i.names?.length ? [`Clip names: ${i.names.slice(0, 12).join(', ')}`] : []),
    i.transcript ? `Transcript:\n${condense(i.transcript)}` : 'The video has no speech.',
  ].join('\n')
}

export const COPY_SCHEMA = {
  type: 'object',
  properties: {
    hooks: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: { type: 'string', minLength: 3, maxLength: 60 },
    },
    caption: { type: 'string', minLength: 10, maxLength: 300 },
    hashtags: {
      type: 'array',
      minItems: 5,
      maxItems: 10,
      items: { type: 'string', pattern: '^#?[^\\s#]{2,30}$' },
    },
  },
  required: ['hooks', 'caption', 'hashtags'],
  additionalProperties: false,
} as const

const Answer = z.object({
  hooks: z.array(z.string()),
  caption: z.string(),
  hashtags: z.array(z.string()),
})

/** `Travel Tips` / `#travel` / `travel,` → `#traveltips` style tags, unique, 5–10. */
export const cleanHashtags = (tags: readonly string[]): string[] => {
  const out: string[] = []
  for (const raw of tags) {
    const body = raw
      .normalize('NFC')
      .replace(/^#+/, '')
      .replace(/[^\p{L}\p{N}_]/gu, '')
      .toLowerCase()
    if (body.length < 2) continue
    const tag = `#${body}`
    if (!out.includes(tag)) out.push(tag)
  }
  return out.slice(0, 10)
}

/** The fewest hashtags a result carries (what the UI and the docs promise). */
export const MIN_HASHTAGS = 5

/** Broad tags that suit any reel: the last resort when the model's own run short. */
const EVERGREEN = ['#reels', '#reelsinstagram', '#explore', '#viral', '#trending']

/**
 * Cleaning can merge or drop the model's tags ("#Travel" and "travel" are one tag), so
 * a result may come back short: tops it up from the topic and vibe, then broad tags.
 */
export const topUpHashtags = (
  tags: readonly string[],
  ctx: { topic?: string | undefined; vibe?: string | undefined } = {},
): string[] => {
  if (tags.length >= MIN_HASHTAGS) return [...tags]
  const words = [ctx.topic, ctx.vibe].flatMap((t) => (t ? [t, ...t.split(/\s+/)] : []))
  const extra = cleanHashtags(words).filter((t) => t.length > 3)
  return cleanHashtags([...tags, ...extra, ...EVERGREEN]).slice(
    0,
    Math.max(MIN_HASHTAGS, tags.length),
  )
}

/** Strips quotes/hashtags/emoji clutter models sometimes add to hook lines. */
export const cleanHook = (s: string): string =>
  s
    .replace(/#[^\s#]+/g, '')
    .replace(/^["'“”‘’«»\s]+|["'“”‘’«»\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

export const parseCopy = (
  json: unknown,
  ctx: { topic?: string | undefined; vibe?: string | undefined } = {},
): Pick<CopyResult, 'hooks' | 'caption' | 'hashtags'> => {
  const a = Answer.parse(json)
  const hooks = [...new Set(a.hooks.map(cleanHook).filter((h) => h.length >= 3))]
  if (!hooks.length) throw new Error('The AI wrote no usable hook text')
  return {
    hooks,
    caption: a.caption.trim(),
    hashtags: topUpHashtags(cleanHashtags(a.hashtags), ctx),
  }
}

export interface CopyInput extends CopyPromptInput {
  llm: LlmPort
  signal?: AbortSignal
}

export const writeCopy = async (i: CopyInput): Promise<CopyResult> => {
  const started = performance.now()
  const r = await i.llm.complete({
    system: COPY_SYSTEM,
    prompt: copyPrompt(i),
    schema: COPY_SCHEMA,
    maxTokens: 420,
    temperature: 0.7,
    ...(i.signal ? { signal: i.signal } : {}),
  })
  const info = await i.llm.info?.()
  return {
    language: i.language ?? 'auto',
    ...parseCopy(r.json, i),
    tokensPerSecond: r.tokensPerSecond,
    ...(info ? { model: info.model } : {}),
    ms: Math.round(performance.now() - started),
  }
}
