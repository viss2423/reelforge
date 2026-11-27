/**
 * Vibes: the style presets Auto Edit offers, and how each maps onto the trend packs (caption
 * style, hook text preset, look filter, transitions), music mood/tempo and cut density.
 * The newest matching item from the trends feed wins over the static packs.
 */
import type {
  CaptionStyle,
  FilterRef,
  TextPreset,
  TransitionPreset,
  TransitionType,
  Us,
} from '@reelforge/core'
import type { Packs } from '@/api/schemas.ts'
import { catalog, type CatalogItem } from '../../model/catalog.ts'
import { DEFAULT_CAPTION_STYLE } from '../launch.ts'
import type { Trends } from './ports.ts'

export interface Vibe {
  id: string
  label: string
  /** Pack tags this vibe likes. */
  tags: readonly string[]
  /** Music mood and tempo asked of the music library. */
  mood: string
  bpm: number
  /** Cut on every beat / half bar / bar. */
  every: 1 | 2 | 4
  /** Use transitions between moments (hard cuts otherwise). */
  transitions: boolean
  /** Look filter strength (0 = no filter). */
  filter: number
}

export const VIBES: readonly Vibe[] = [
  {
    id: 'energetic',
    label: 'Energetic',
    tags: ['beat', 'fast', 'energy', 'kinetic', 'bold', 'impact', 'flash', 'zoom', 'whip'],
    mood: 'energetic',
    bpm: 128,
    every: 2,
    transitions: true,
    filter: 0.6,
  },
  {
    id: 'cinematic',
    label: 'Cinematic',
    tags: ['cinematic', 'smooth', 'film', 'moody', 'serif', 'blur', 'luxury', 'subtle'],
    mood: 'cinematic',
    bpm: 90,
    every: 4,
    transitions: true,
    filter: 0.8,
  },
  {
    id: 'aesthetic',
    label: 'Aesthetic',
    tags: ['aesthetic', 'minimal', 'lowercase', 'soft', 'pastel', 'analog', 'film', 'smooth'],
    mood: 'chill',
    bpm: 100,
    every: 2,
    transitions: true,
    filter: 0.7,
  },
  {
    id: 'fun',
    label: 'Fun',
    tags: ['pop', 'playful', 'cute', 'meme', 'bouncy', 'comic', 'glitch', 'colorful'],
    mood: 'happy',
    bpm: 118,
    every: 2,
    transitions: true,
    filter: 0.5,
  },
  {
    id: 'talking',
    label: 'Talking head',
    tags: ['podcast', 'bold', 'highlight', 'box', 'hook', 'impact', 'subtle'],
    mood: 'background',
    bpm: 100,
    every: 4,
    transitions: false,
    filter: 0,
  },
]

export const vibeById = (id: string | undefined): Vibe =>
  VIBES.find((v) => v.id === id) ?? VIBES[0]!

export interface AutoStyle {
  caption: { style: CaptionStyle; ref?: string }
  hookText?: { item: TextPreset; ref: string }
  filter?: FilterRef
  transition?: { type: TransitionType; duration: Us }
}

const overlap = (a: readonly string[], b: readonly string[]): number =>
  a.reduce((n, t) => n + (b.includes(t) ? 1 : 0), 0)

/** Best catalog item for the vibe: tag overlap first, then trend score; `boost` refs win ties. */
export const bestMatch = <T extends { tags: string[]; trendScore: number }>(
  items: readonly CatalogItem<T>[],
  tags: readonly string[],
  boost: ReadonlyMap<string, number> = new Map(),
  require?: (item: T) => boolean,
): CatalogItem<T> | undefined => {
  let best: CatalogItem<T> | undefined
  let bestScore = -Infinity
  for (const c of items) {
    if (require && !require(c.item)) continue
    const s = overlap(c.item.tags, tags) * 30 + c.item.trendScore * 0.3 + (boost.get(c.ref) ?? 0)
    if (s > bestScore) {
      best = c
      bestScore = s
    }
  }
  return best
}

/**
 * Refs the trends feed recommends for this vibe, newest first → a score boost (the newest
 * matching generated item decides; older ones still nudge). Generated caption styles and
 * text presets are boosted themselves; templates boost the looks they reference. Items the
 * feed lists without tags are matched by their pack tags (`tagsOf`).
 */
export const trendBoosts = (
  trends: Trends | undefined,
  vibe: Vibe,
  tagsOf: (ref: string) => readonly string[] | undefined = () => undefined,
): Map<string, number> => {
  const out = new Map<string, number>()
  if (!trends) return out
  const matching = trends.templates
    .map((t) => ({ t, tags: t.tags.length ? t.tags : (tagsOf(t.ref) ?? []) }))
    .filter(({ tags }) => overlap(tags, vibe.tags) > 0 || tags.includes(vibe.id))
    .toSorted((a, b) => (b.t.createdAt ?? '').localeCompare(a.t.createdAt ?? ''))
  matching.forEach(({ t }, rank) => {
    const weight = rank === 0 ? 100 : Math.max(5, 40 - rank * 10)
    for (const ref of [t.ref, t.captionStyle, t.filter, t.transition, t.textPreset])
      if (ref && !out.has(ref)) out.set(ref, weight)
  })
  return out
}

/** Caption style, hook text preset, filter and transition for a vibe. */
export const pickStyle = (
  packs: Packs | undefined,
  vibe: Vibe,
  trends?: Trends,
  current?: { style: CaptionStyle; ref?: string },
): AutoStyle => {
  const captions = catalog(packs, 'captionStyles')
  const presets = catalog(packs, 'textPresets')
  const tags = new Map<string, readonly string[]>()
  for (const c of [...captions, ...presets]) tags.set(c.ref, c.item.tags)
  const boost = trendBoosts(trends, vibe, (ref) => tags.get(ref))
  const caption = bestMatch(captions, vibe.tags, boost)
  const hook =
    bestMatch(presets, [...vibe.tags, 'hook'], boost, (t) => t.tags.includes('hook')) ??
    bestMatch(presets, vibe.tags, boost)
  const filter =
    vibe.filter > 0 ? bestMatch(catalog(packs, 'filters'), vibe.tags, boost) : undefined
  const transition = vibe.transitions
    ? bestMatch<TransitionPreset>(catalog(packs, 'transitions'), vibe.tags, boost)
    : undefined
  return {
    // A project that already has captions keeps its look.
    caption:
      current ??
      (caption
        ? { style: caption.item.style, ref: caption.ref }
        : { style: DEFAULT_CAPTION_STYLE }),
    ...(hook ? { hookText: { item: hook.item, ref: hook.ref } } : {}),
    ...(filter ? { filter: { ref: filter.ref, intensity: vibe.filter } } : {}),
    ...(transition
      ? {
          transition: {
            type: transition.item.type,
            duration: Math.min(transition.item.duration, 400_000),
          },
        }
      : {}),
  }
}
