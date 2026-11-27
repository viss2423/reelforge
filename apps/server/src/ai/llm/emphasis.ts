/**
 * Caption emphasis + emoji, and chapters. The model sees the caption text (in chunks for
 * long videos) and names the words worth highlighting, optionally with one fitting emoji;
 * those are mapped back onto caption word indices here, so output never depends on the
 * model counting words. Chapters are picked by numbered sentence.
 */
import { normalizeWord } from '@reelforge/core'
import { z } from 'zod'
import { languageName } from './copywriter.ts'
import type { LlmPort } from './types.ts'

export interface EmphasisMark {
  /** Index into the caption words. */
  index: number
  emoji?: string
}

export interface Chapter {
  /** Caption word index the chapter starts at. */
  index: number
  title: string
}

export interface EmphasisResult {
  marks: EmphasisMark[]
  chapters: Chapter[]
  model?: string
  tokensPerSecond?: number
  ms: number
}

/** Words per model call. */
export const CHUNK_WORDS = 220
/** At most one emphasised word per this many words (keeps captions readable). */
export const WORDS_PER_MARK = 6
/** At most one emoji per this many emphasised words (emoji on every word is noise). */
export const EMOJI_EVERY = 3

const EMOJI =
  /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})(?:️|‍(?:\p{Extended_Pictographic})|\p{Emoji_Modifier})*$/u

export const isEmoji = (s: string): boolean => EMOJI.test(s.trim())

export const EMPHASIS_SYSTEM =
  'You style captions for short-form videos. Pick the words that carry the meaning or emotion ' +
  '(numbers, names, strong verbs and adjectives, surprises, the payoff of a sentence) so they can be highlighted. ' +
  'Never pick filler, articles, pronouns or common verbs. Give an emoji only when one clearly fits the word. ' +
  'Copy each word exactly as it appears in the text.'

export const emphasisPrompt = (words: readonly string[], language?: string): string => {
  const lang = languageName(language)
  return [
    ...(lang ? [`Language: ${lang}.`] : []),
    `Pick about ${Math.max(1, Math.round(words.length / WORDS_PER_MARK / 1.5))} key words from this caption text:`,
    words.join(' '),
  ].join('\n')
}

export const emphasisSchema = (max: number): object => ({
  type: 'object',
  properties: {
    keywords: {
      type: 'array',
      maxItems: max,
      items: { type: 'string', minLength: 1, maxLength: 30 },
    },
    // Few emoji, listed separately: an emoji slot per keyword doubles the output tokens.
    emoji: {
      type: 'array',
      maxItems: Math.max(1, Math.ceil(max / EMOJI_EVERY)),
      items: {
        type: 'object',
        properties: {
          word: { type: 'string', minLength: 1, maxLength: 30 },
          emoji: { type: 'string', minLength: 1, maxLength: 8 },
        },
        required: ['word', 'emoji'],
        additionalProperties: false,
      },
    },
  },
  required: ['keywords', 'emoji'],
  additionalProperties: false,
})

const Keyword = z.union([z.string(), z.object({ word: z.string(), emoji: z.string().optional() })])
const Keywords = z.object({
  keywords: z.array(Keyword),
  emoji: z.array(z.object({ word: z.string(), emoji: z.string() })).optional(),
})

/** Longest token of a (possibly multi-word) answer, normalised. */
const keyOf = (word: string): string =>
  normalizeWord(word.split(/\s+/).toSorted((a, b) => b.length - a.length)[0] ?? '')

/**
 * Maps model keywords onto word indices `[offset, offset + words.length)`: each keyword marks
 * its first unmarked occurrence; an emoji attaches to its keyword's occurrence only, and
 * emoji are capped (one per EMOJI_EVERY marks).
 */
export const mapKeywords = (
  json: unknown,
  words: readonly string[],
  offset = 0,
): EmphasisMark[] => {
  const parsed = Keywords.parse(json)
  const emojiFor = new Map<string, string>()
  for (const k of parsed.keywords)
    if (typeof k !== 'string' && k.emoji) emojiFor.set(keyOf(k.word), k.emoji.trim())
  for (const e of parsed.emoji ?? [])
    if (!emojiFor.has(keyOf(e.word))) emojiFor.set(keyOf(e.word), e.emoji.trim())
  const norm = words.map((w) => normalizeWord(w))
  const used = new Set<number>()
  const out: EmphasisMark[] = []
  let emojis = 0
  const max = Math.max(1, Math.ceil(words.length / WORDS_PER_MARK))
  for (const k of parsed.keywords) {
    if (out.length >= max) break
    const target = keyOf(typeof k === 'string' ? k : k.word)
    if (!target) continue
    const i = norm.findIndex((w, j) => w === target && !used.has(j))
    if (i < 0) continue
    used.add(i)
    const emoji = emojiFor.get(target)
    const ok = emoji !== undefined && isEmoji(emoji) && emojis < Math.ceil(max / EMOJI_EVERY)
    if (ok) {
      emojis++
      emojiFor.delete(target)
    }
    out.push({ index: offset + i, ...(ok ? { emoji } : {}) })
  }
  return out.toSorted((a, b) => a.index - b.index)
}

/* ------------------------------------------------------------------ chapters */

/** Sentence starts (word indices) from end punctuation. */
export const sentenceStarts = (words: readonly string[]): number[] => {
  const out = [0]
  for (let i = 0; i < words.length - 1; i++)
    if (/[.!?。！？]["')\]]?$/.test(words[i]!.trim())) out.push(i + 1)
  return out
}

export const CHAPTERS_SYSTEM =
  'You split a video transcript into 2–6 chapters at topic changes. Titles are 1–4 words, in the transcript language.'

export const chaptersPrompt = (words: readonly string[], starts: readonly number[]): string =>
  starts
    .map((s, k) => {
      const end = starts[k + 1] ?? words.length
      const text = words.slice(s, end).join(' ')
      return `#${k} ${text.length > 160 ? `${text.slice(0, 159)}…` : text}`
    })
    .join('\n')

export const chaptersSchema = (count: number): object => ({
  type: 'object',
  properties: {
    chapters: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          sentence: { type: 'integer', minimum: 0, maximum: Math.max(0, count - 1) },
          title: { type: 'string', minLength: 1, maxLength: 40 },
        },
        required: ['sentence', 'title'],
        additionalProperties: false,
      },
    },
  },
  required: ['chapters'],
  additionalProperties: false,
})

const ChapterAnswer = z.object({
  chapters: z.array(z.object({ sentence: z.number().int(), title: z.string() })),
})

export const parseChapters = (json: unknown, starts: readonly number[]): Chapter[] => {
  const seen = new Set<number>()
  const out: Chapter[] = []
  for (const c of ChapterAnswer.parse(json).chapters) {
    const index = starts[c.sentence]
    const title = c.title.trim()
    if (index === undefined || seen.has(index) || !title) continue
    seen.add(index)
    out.push({ index, title })
  }
  return out.toSorted((a, b) => a.index - b.index)
}

/* ------------------------------------------------------------------ orchestration */

export interface EmphasisInput {
  words: readonly string[]
  language?: string
  chapters?: boolean
  llm: LlmPort
  signal?: AbortSignal
  onProgress?: (p: number) => void
}

/** Minimum sentences before chapters make sense. */
const MIN_CHAPTER_SENTENCES = 6

export const computeEmphasis = async (i: EmphasisInput): Promise<EmphasisResult> => {
  const started = performance.now()
  const marks: EmphasisMark[] = []
  const chunks = Math.max(1, Math.ceil(i.words.length / CHUNK_WORDS))
  const starts = sentenceStarts(i.words)
  const wantChapters = i.chapters === true && starts.length >= MIN_CHAPTER_SENTENCES
  const steps = chunks + (wantChapters ? 1 : 0)
  let tps = 0
  for (let c = 0; c < chunks; c++) {
    const slice = i.words.slice(c * CHUNK_WORDS, (c + 1) * CHUNK_WORDS)
    if (!slice.length) break
    const max = Math.max(1, Math.ceil(slice.length / WORDS_PER_MARK))
    const r = await i.llm.complete({
      system: EMPHASIS_SYSTEM,
      prompt: emphasisPrompt(slice, i.language),
      schema: emphasisSchema(max),
      maxTokens: 60 + max * 14,
      temperature: 0.2,
      ...(i.signal ? { signal: i.signal } : {}),
    })
    tps = r.tokensPerSecond
    marks.push(...mapKeywords(r.json, slice, c * CHUNK_WORDS))
    i.onProgress?.((c + 1) / steps)
  }
  let chapters: Chapter[] = []
  if (wantChapters) {
    const r = await i.llm.complete({
      system: CHAPTERS_SYSTEM,
      prompt: chaptersPrompt(i.words, starts),
      schema: chaptersSchema(starts.length),
      maxTokens: 200,
      temperature: 0.2,
      ...(i.signal ? { signal: i.signal } : {}),
    })
    chapters = parseChapters(r.json, starts)
  }
  const info = await i.llm.info?.()
  return {
    marks,
    chapters,
    tokensPerSecond: tps,
    ...(info ? { model: info.model } : {}),
    ms: Math.round(performance.now() - started),
  }
}
