/**
 * Suggestion ranking (pure). Each track gets a 0..1 score from weighted signals, with short
 * human-readable reasons the UI shows under the pick:
 *
 * | signal   | weight | rule                                                              |
 * | -------- | ------ | ----------------------------------------------------------------- |
 * | match    | 0.30   | share of mood/vibe/genre words found in title, tags and genres    |
 * | tempo    | 0.20   | closeness to the target BPM (or the mood's range); half/double ok |
 * | length   | 0.15   | long enough to fill the reel from its chorus                      |
 * | speech   | 0.15   | with speech: instrumentals preferred, vocals penalised            |
 * | energy   | 0.10   | analysed energy vs the mood's expected energy                     |
 * | licence  | 0.07   | no credit needed (CC0/PD) beats CC BY                             |
 * | cached   | 0.03   | already on the host: instant preview and import                   |
 *
 * Unknown signals (no BPM yet, not analysed) score neutral (0.5) so catalogue metadata and
 * analysis compete fairly.
 *
 * Trend order (the default for Auto music and Auto Edit): with trending-sound profiles the
 * final score is 0.55 × the score above + 0.45 × similarity to the closest trending sound
 * (tempo 0.5, genre/mood words 0.25, energy 0.25; chart rank scales it), so the pick sounds
 * like what is popular today while still fitting the reel.
 */
import type { LibraryTrack, MusicMood, RankedTrack, TrendSoundProfile } from '@reelforge/core'
import { MOODS, tokens } from './types.ts'

export interface RankQuery {
  mood?: MusicMood | undefined
  vibe?: string | undefined
  genre?: string | undefined
  targetBpm?: number | undefined
  /** µs to fill. */
  duration: number
  hasSpeech: boolean
  /** Trending sounds to resemble (trend order). */
  trend?: readonly TrendSoundProfile[] | undefined
}

const VOCAL_TAGS = new Set(['vocal', 'vocals', 'singing', 'singer', 'lyrics', 'rap', 'acapella'])

/** Tempo similarity 0..1 allowing half/double time (a 70 BPM track works at 140). */
export const tempoMatch = (bpm: number, target: number): number => {
  let best = Infinity
  for (const k of [0.5, 1, 2]) best = Math.min(best, Math.abs(Math.log2((bpm * k) / target)))
  // 0 octaves → 1, ±0.25 octave (≈ ±19%) → 0.
  return Math.max(0, 1 - best / 0.25)
}

const wanted = (q: RankQuery): string[] => {
  const words = new Set<string>([...tokens(q.vibe), ...tokens(q.genre)])
  if (q.mood) for (const t of MOODS[q.mood].tags) words.add(t)
  return [...words]
}

/** 0..1 similarity of a library track to one trending sound. */
export const trendSimilarity = (t: LibraryTrack, s: TrendSoundProfile): number => {
  const tempo = t.bpm && s.bpm ? tempoMatch(t.bpm, s.bpm) : 0.5
  const words = new Set([...tokens(s.genre), ...(s.mood ? MOODS[s.mood].tags : [])])
  const hay = new Set([...t.tags, ...t.genres])
  const hits = [...words].filter((w) => hay.has(w)).length
  const style = words.size ? Math.min(1, hits / Math.min(2, words.size)) : 0.5
  const energy =
    t.energy !== undefined && s.energy !== undefined ? 1 - Math.abs(t.energy - s.energy) : 0.5
  return 0.5 * tempo + 0.25 * style + 0.25 * energy
}

/** Closest trending sound (chart rank weighs in) and its similarity. */
export const bestTrendMatch = (
  t: LibraryTrack,
  sounds: readonly TrendSoundProfile[],
): { sound: TrendSoundProfile; similarity: number; score: number } | undefined => {
  let best: { sound: TrendSoundProfile; similarity: number; score: number } | undefined
  for (const s of sounds) {
    const similarity = trendSimilarity(t, s)
    const score = similarity * (0.7 + 0.3 * (s.weight ?? 1))
    if (!best || score > best.score) best = { sound: s, similarity, score }
  }
  return best
}

export const scoreTrack = (t: LibraryTrack, q: RankQuery): RankedTrack => {
  const reasons: string[] = []
  const words = wanted(q)
  const hay = new Set([...t.tags, ...t.genres, ...tokens(t.title)])
  let match = 0.5
  if (words.length > 0) {
    const hits = words.filter((w) => hay.has(w)).length
    // A couple of hits is a strong match: saturate at 3.
    match = Math.min(1, hits / Math.min(3, words.length))
    if (hits > 0) reasons.push(q.mood ?? 'matches')
  }

  let tempo = 0.5
  const target =
    q.targetBpm ?? (q.mood ? (MOODS[q.mood].bpm[0] + MOODS[q.mood].bpm[1]) / 2 : undefined)
  if (t.bpm && target) {
    tempo = tempoMatch(t.bpm, target)
    if (q.mood && !q.targetBpm) {
      const [lo, hi] = MOODS[q.mood].bpm
      if (t.bpm >= lo && t.bpm <= hi) tempo = Math.max(tempo, 0.9)
    }
  }
  if (t.bpm) reasons.push(`${Math.round(t.bpm)} BPM`)

  const length = Math.min(1, t.duration / Math.max(1, q.duration * 1.5))

  let speech = 0.5
  const vocal = t.instrumental === false || t.tags.some((x) => VOCAL_TAGS.has(x))
  if (t.instrumental === true) {
    speech = q.hasSpeech ? 1 : 0.6
    reasons.push('instrumental')
  } else if (vocal) speech = q.hasSpeech ? 0 : 0.5

  const energy =
    t.energy !== undefined && q.mood ? 1 - Math.abs(t.energy - MOODS[q.mood].energy) : 0.5

  const licence = t.licence.attributionRequired ? 0.4 : 1
  reasons.push(
    t.licence.attributionRequired ? `${t.licence.name}, credit in caption` : 'no credit needed',
  )

  const score =
    0.3 * match +
    0.2 * tempo +
    0.15 * length +
    0.15 * speech +
    0.1 * energy +
    0.07 * licence +
    0.03 * (t.cached ? 1 : 0)
  const trend = q.trend?.length ? bestTrendMatch(t, q.trend) : undefined
  if (!trend) return { ...t, score: Math.round(score * 1000) / 1000, reasons }
  if (trend.similarity >= 0.6) reasons.unshift(`sounds like ${trend.sound.title}`)
  return {
    ...t,
    score: Math.round((0.55 * score + 0.45 * trend.score) * 1000) / 1000,
    reasons,
    trendMatch: {
      title: trend.sound.title,
      ...(trend.sound.artist ? { artist: trend.sound.artist } : {}),
      similarity: Math.round(trend.similarity * 1000) / 1000,
    },
  }
}

/** Ranks tracks best-first; ties keep the input (source relevance) order. */
export const rankTracks = (tracks: readonly LibraryTrack[], q: RankQuery): RankedTrack[] =>
  tracks
    .map((t, i) => ({ r: scoreTrack(t, q), i }))
    .toSorted((a, b) => b.r.score - a.r.score || a.i - b.i)
    .map((x) => x.r)

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** Drops the same recording found through two sources (keeps the first, i.e. best source). */
export const dedupeTracks = <T extends LibraryTrack>(tracks: readonly T[]): T[] => {
  const seen = new Set<string>()
  const out: T[] = []
  for (const t of tracks) {
    const key = `${norm(t.title)}|${norm(t.artist)}`
    if (seen.has(key) || seen.has(t.id)) continue
    seen.add(key)
    seen.add(t.id)
    out.push(t)
  }
  return out
}
