/**
 * Ranking without an LLM: every pack item (name, tags, description) is matched against the
 * day's signals, and its `trendScore` is moved toward what is trending. Items nobody talks
 * about cool off slowly instead of dropping out, so the catalogue never empties.
 *
 *   match   = Σ signal.weight × kindWeight   over signals whose phrase occurs in the item
 *   heat    = 1 − e^(−match)                  (diminishing returns, 0..1)
 *   score   = clamp(round(base × 0.9 + heat × 25), 0, 100)
 */
import type { PackManifest } from '@reelforge/core'
import { normalize } from './extract.ts'
import type { SignalKind, TrendSignal } from './types.ts'

const KIND_WEIGHT: Record<SignalKind, number> = {
  format: 1.2,
  aesthetic: 1,
  caption: 1,
  hashtag: 0.8,
  topic: 0.5,
  sound: 0.3,
}

const COLLECTIONS = [
  'captionStyles',
  'textPresets',
  'filters',
  'animations',
  'transitions',
  'effects',
  'stickers',
  'templates',
] as const

interface Rankable {
  name: string
  tags: string[]
  trendScore: number
  description?: string
}

/** Searchable text of an item, padded with spaces so phrase checks respect word edges. */
export const itemText = (item: Rankable, id: string): string =>
  ` ${normalize([item.name, id, ...item.tags, item.description ?? ''].join(' '))} `

/** Signals whose phrase (or its hashtag form, "photodump") occurs in `text`. */
export const matchStrength = (text: string, signals: readonly TrendSignal[]): number => {
  const squashed = text.replaceAll(' ', '')
  let m = 0
  for (const s of signals) {
    const phrase = normalize(s.text)
    if (phrase.length < 3) continue
    const hit =
      text.includes(` ${phrase} `) ||
      (s.kind === 'hashtag' && phrase.length >= 5 && squashed.includes(phrase.replaceAll(' ', '')))
    if (hit) m += s.weight * KIND_WEIGHT[s.kind]
  }
  return m
}

export const rescore = (base: number, match: number): number => {
  const heat = 1 - Math.exp(-match)
  return Math.max(0, Math.min(100, Math.round(base * 0.9 + heat * 25)))
}

/**
 * New scores for every item of `manifests` (`<packId>/<itemId>` → score), using each item's
 * shipped score as the base so repeated runs never compound.
 */
export const rankItems = (
  manifests: readonly PackManifest[],
  signals: readonly TrendSignal[],
): Map<string, number> => {
  const useful = signals.filter((s) => s.weight >= 0.05)
  const out = new Map<string, number>()
  for (const m of manifests)
    for (const c of COLLECTIONS)
      for (const item of m[c] as Array<Rankable & { id: string }>)
        out.set(
          `${m.id}/${item.id}`,
          rescore(item.trendScore, matchStrength(itemText(item, item.id), useful)),
        )
  return out
}

/** Items of a collection that best match the signals (for "suggested template"). */
export const bestMatches = <T extends Rankable & { id: string }>(
  items: ReadonlyArray<{ ref: string; item: T }>,
  signals: readonly TrendSignal[],
  n: number,
): Array<{ ref: string; item: T; match: number }> =>
  items
    .map((x) => ({ ...x, match: matchStrength(itemText(x.item, x.item.id), signals) }))
    .sort((a, b) => b.match - a.match || b.item.trendScore - a.item.trendScore)
    .slice(0, n)
