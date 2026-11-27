/**
 * Signal extraction: raw source items (search terms, video/post titles, songs) → weighted,
 * de-duplicated trend signals (topics, hashtags, sounds, edit formats, aesthetics, caption
 * cues). Pure and deterministic; the lexicons below are the engine's vocabulary and the
 * same words pack items are tagged with, which is what makes ranking work without an LLM.
 */
import type { SignalKind, SourceItem, TrendSignal } from './types.ts'

/** Canonical phrase → pattern (matched on normalised text). */
type Lexicon = ReadonlyArray<readonly [string, RegExp]>

export const FORMATS: Lexicon = [
  ['pov', /\bpov\b|point of view/],
  ['photo dump', /photo ?dump|camera roll/],
  ['grwm', /\bgrwm\b|get ready with me/],
  ['day in my life', /day in (my|the) life|\bditl\b|a day with me/],
  ['storytime', /story ?time/],
  ['outfit transition', /outfit (transition|change|check)|\bootd\b/],
  ['before and after', /before (and|&|n) after/],
  ['glow up', /glow ?up|transformation/],
  ['tutorial', /tutorial|how to\b|step by step/],
  ['recipe', /recipe|what i eat|cooking/],
  ['unboxing', /unboxing|haul/],
  ['routine', /(morning|night|skincare|gym) routine/],
  ['tier list', /tier list|ranking (every|all)/],
  ['reaction', /reacting to|reaction/],
  ['wait for it', /wait for it|watch (till|until) the end/],
  ['part two', /\bpart (2|two|ii)\b/],
  ['come with me', /come with me|join me/],
  ['vlog', /\bvlog/],
  ['challenge', /challenge\b/],
  ['countdown', /\btop (3|5|10)\b|countdown/],
  ['travel', /\btravel|\btrip\b|vacation|itinerary/],
  ['workout', /workout|\bgym\b|fitness/],
  ['podcast', /podcast|interview/],
  ['product', /review\b|must ?haves?|amazon finds|product/],
  ['recap', /recap|year in review|wrapped/],
  ['carousel', /carousel|slideshow/],
  ['beat sync', /beat ?sync|on beat|edit\b/],
]

export const AESTHETICS: Lexicon = [
  ['y2k', /\by2k\b|digicam/],
  ['coquette', /coquette/],
  ['clean girl', /clean girl|that girl/],
  ['old money', /old money|quiet luxury/],
  ['cottagecore', /cottagecore/],
  ['dark academia', /dark academia/],
  ['retro', /\bretro\b|throwback|\b2016\b|nostalgi/],
  ['vintage', /vintage|sepia/],
  ['film', /\bfilm (look|grain|camera)|\b35 ?mm|analog/],
  ['cinematic', /cinematic|movie look/],
  ['neon', /\bneon\b|cyberpunk/],
  ['pastel', /pastel/],
  ['minimal', /minimal/],
  ['cozy', /\bcozy|\bcosy|hygge/],
  ['moody', /\bmoody|dark aesthetic/],
  ['lofi', /lo-?fi/],
  ['dreamy', /dreamy|ethereal/],
  ['glitch', /glitch|\bvhs\b/],
  ['warm', /\bwarm|golden hour|autumn|fall\b/],
  ['cool', /\bwinter|\bsnow|\bicy\b|frost/],
  ['holiday', /christmas|holiday|xmas|festive|thanksgiving|halloween|new year/],
  ['red', /\bred\b/],
  ['pink', /\bpink\b/],
  ['green', /\bgreen\b/],
  ['gold', /\bgold(en)?\b/],
  ['black and white', /black (and|&) white|\bb&w\b|monochrome/],
]

export const CAPTION_CUES: Lexicon = [
  ['lowercase', /lowercase|lower case|no caps/],
  ['uppercase', /all caps|uppercase/],
  ['karaoke', /karaoke|word highlight/],
  ['word by word', /word by word|one word at a time/],
  ['typewriter', /typewriter|typing/],
  ['text message', /text message|imessage|texting/],
  ['handwritten', /handwritten|handwriting|\bmarker\b/],
  ['bold', /\bbold\b|big text/],
  ['highlight', /highlight/],
  ['subtitles', /subtitles|captions?\b/],
]

/** Calendar moments that are always in season (free, always-available signals). */
const SEASONAL: Record<number, string[]> = {
  0: ['new year', 'winter', 'goals'],
  1: ['valentines', 'winter', 'love'],
  2: ['spring', 'spring break'],
  3: ['spring', 'easter'],
  4: ['summer', 'graduation'],
  5: ['summer', 'travel'],
  6: ['summer', 'travel'],
  7: ['summer', 'back to school'],
  8: ['autumn', 'back to school'],
  9: ['autumn', 'halloween'],
  10: ['autumn', 'holiday', 'thanksgiving', 'black friday'],
  11: ['holiday', 'christmas', 'winter', 'recap', 'new year'],
}

/** How much a source's items count (search demand and creator chatter weigh most). */
export const SOURCE_WEIGHT: Record<string, number> = {
  'google-trends': 1,
  wikipedia: 0.6,
  youtube: 1,
  reddit: 0.8,
  'apple-music': 1,
  deezer: 1,
  calendar: 0.5,
}

/** Lower-case, accents stripped, punctuation → spaces, whitespace collapsed. */
export const normalize = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}#&'\s-]+/gu, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const HASHTAG = /#([\p{L}\p{N}_]{2,40})/gu
/** Platform-generic tags that say nothing about a trend. */
const GENERIC_TAGS = new Set([
  'fyp',
  'foryou',
  'foryoupage',
  'viral',
  'trending',
  'shorts',
  'short',
  'reels',
  'reel',
  'tiktok',
  'youtube',
  'explore',
  'explorepage',
  'instagram',
  'subscribe',
  'like',
])

export const hashtags = (text: string): string[] =>
  [...text.matchAll(HASHTAG)]
    .map((m) => (m[1] ?? '').toLowerCase())
    .filter((t) => !GENERIC_TAGS.has(t) && !/^\d+$/.test(t))

const lexiconHits = (lex: Lexicon, text: string): string[] =>
  lex.filter(([, re]) => re.test(text)).map(([name]) => name)

interface Acc {
  kind: SignalKind
  text: string
  weight: number
  sources: Set<string>
  meta: NonNullable<TrendSignal['meta']>
}

/** A song title without "(feat. …)" / " - Remix" noise, for cross-chart matching. */
export const soundKey = (title: string): string =>
  normalize(title.replace(/\s*[([].*?[)\]]\s*/g, ' ').replace(/\s+-\s+.*$/, ''))

/**
 * Turns per-source items into ranked signals. Weights add up across sources (a song charting
 * on two services beats one charting on one) and are normalised to 0..1 per kind.
 */
export const extractSignals = (
  bySource: ReadonlyArray<{ source: string; items: readonly SourceItem[] }>,
  now: Date,
): TrendSignal[] => {
  const acc = new Map<string, Acc>()
  const add = (
    kind: SignalKind,
    text: string,
    weight: number,
    source: string,
    meta?: TrendSignal['meta'],
  ): void => {
    if (!text || weight <= 0) return
    const key = `${kind}:${text}`
    let a = acc.get(key)
    if (!a) {
      a = { kind, text, weight: 0, sources: new Set(), meta: {} }
      acc.set(key, a)
    }
    a.weight += weight
    a.sources.add(source)
    if (meta?.artist && !a.meta.artist) a.meta.artist = meta.artist
    if (meta?.genre && !a.meta.genre) a.meta.genre = meta.genre
    if (meta?.bpm && !a.meta.bpm) a.meta.bpm = meta.bpm
  }

  for (const { source, items } of bySource) {
    const sw = SOURCE_WEIGHT[source] ?? 0.7
    for (const item of items) {
      const w = Math.max(0, Math.min(1, item.weight)) * sw
      if (item.kind === 'sound') {
        add('sound', soundKey(item.title), w, source, {
          ...(item.meta?.artist ? { artist: item.meta.artist } : {}),
          ...(item.meta?.genre ? { genre: item.meta.genre } : {}),
          ...(item.meta?.bpm ? { bpm: item.meta.bpm } : {}),
        })
        continue
      }
      const raw = `${item.title} ${item.text ?? ''} ${(item.meta?.tags ?? []).map((t) => `#${t.replace(/\s+/g, '')}`).join(' ')}`
      const text = normalize(raw)
      if (item.kind === 'topic') add('topic', normalize(item.title), w, source)
      for (const tag of hashtags(raw)) add('hashtag', tag, w, source)
      for (const f of lexiconHits(FORMATS, text)) add('format', f, w, source)
      for (const f of lexiconHits(AESTHETICS, text)) add('aesthetic', f, w, source)
      for (const f of lexiconHits(CAPTION_CUES, text)) add('caption', f, w * 0.8, source)
    }
  }
  for (const moment of SEASONAL[now.getMonth()] ?? []) {
    add('topic', moment, SOURCE_WEIGHT.calendar ?? 0.5, 'calendar')
    for (const a of lexiconHits(AESTHETICS, moment)) add('aesthetic', a, 0.5, 'calendar')
  }

  const max = new Map<SignalKind, number>()
  for (const a of acc.values()) max.set(a.kind, Math.max(max.get(a.kind) ?? 0, a.weight))
  return [...acc.values()]
    .map((a) => {
      const s: TrendSignal = {
        kind: a.kind,
        text: a.text,
        weight: Math.round((a.weight / (max.get(a.kind) || 1)) * 1000) / 1000,
        sources: [...a.sources].sort(),
      }
      if (Object.keys(a.meta).length) s.meta = a.meta
      return s
    })
    .sort(
      (x, y) => y.weight - x.weight || x.kind.localeCompare(y.kind) || x.text.localeCompare(y.text),
    )
}

/** The top `n` signals of a kind. */
export const topOf = (
  signals: readonly TrendSignal[],
  kind: SignalKind,
  n: number,
): TrendSignal[] => signals.filter((s) => s.kind === kind).slice(0, n)
