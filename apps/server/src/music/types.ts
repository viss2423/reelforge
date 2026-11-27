/** Music library internals: the source adapter contract and the mood vocabulary. */
import type { LibraryTrack, MusicMood } from '@reelforge/core'

/** A track as a source returns it: the wire model plus where to download the audio. */
export interface SourceTrack extends LibraryTrack {
  /** Direct https URL of the full track (never sent to clients). */
  audioUrl: string
}

export interface SourceQuery {
  /** Free-text search terms. */
  terms: string
  /** Tag/genre filters (lower case). */
  tags: string[]
  /** Ask for instrumentals (speech on the reel). */
  instrumental?: boolean
  limit: number
}

/**
 * A royalty-free music catalogue. Adapters only return tracks whose licence passes the
 * policy in licence.ts, map them to `SourceTrack`, and never scrape web pages: each one
 * uses the catalogue's documented public API within its rate limits.
 */
export interface MusicSource {
  readonly id: string
  readonly name: string
  readonly homepage: string
  /** undefined when usable; otherwise why not (e.g. "needs a free client id"). */
  unavailable(): string | undefined
  search(query: SourceQuery, signal?: AbortSignal): Promise<SourceTrack[]>
}

export interface MoodProfile {
  /** Search terms for text-search catalogues. */
  terms: string
  /** Tags that count as a match when ranking. */
  tags: readonly string[]
  /** Typical tempo range (BPM). */
  bpm: readonly [number, number]
  /** Expected energy 0..1. */
  energy: number
}

export const MOODS: Readonly<Record<MusicMood, MoodProfile>> = {
  upbeat: {
    terms: 'upbeat happy',
    tags: ['upbeat', 'happy', 'positive', 'fun', 'pop', 'bright'],
    bpm: [100, 135],
    energy: 0.7,
  },
  energetic: {
    terms: 'energetic',
    tags: [
      'energetic',
      'energy',
      'workout',
      'edm',
      'electronic',
      'rock',
      'dance',
      'powerful',
      'speed_high',
    ],
    bpm: [120, 160],
    energy: 0.9,
  },
  chill: {
    terms: 'chill',
    tags: ['chill', 'relaxing', 'calm', 'ambient', 'mellow', 'downtempo', 'lounge'],
    bpm: [70, 105],
    energy: 0.3,
  },
  emotional: {
    terms: 'emotional piano',
    tags: ['emotional', 'sad', 'piano', 'melancholic', 'touching', 'soft'],
    bpm: [60, 95],
    energy: 0.3,
  },
  cinematic: {
    terms: 'cinematic',
    tags: ['cinematic', 'epic', 'orchestral', 'soundtrack', 'trailer', 'film'],
    bpm: [80, 130],
    energy: 0.7,
  },
  dark: {
    terms: 'dark',
    tags: ['dark', 'suspense', 'tension', 'mysterious', 'horror', 'trap'],
    bpm: [70, 140],
    energy: 0.6,
  },
  romantic: {
    terms: 'romantic love',
    tags: ['romantic', 'love', 'tender', 'acoustic', 'warm'],
    bpm: [65, 100],
    energy: 0.35,
  },
  funny: {
    terms: 'funny quirky',
    tags: ['funny', 'comedy', 'quirky', 'playful', 'ukulele', 'whistle'],
    bpm: [95, 130],
    energy: 0.6,
  },
  inspiring: {
    terms: 'inspiring motivational',
    tags: ['inspiring', 'inspirational', 'motivational', 'uplifting', 'corporate', 'hopeful'],
    bpm: [90, 130],
    energy: 0.6,
  },
  lofi: {
    terms: 'lofi hip hop',
    tags: ['lofi', 'lo-fi', 'hip_hop', 'hip-hop', 'hiphop', 'jazzy', 'beats', 'chillhop'],
    bpm: [70, 95],
    energy: 0.35,
  },
}

/** Lower-cased word tokens of a free-text string. */
export const tokens = (s: string | undefined): string[] =>
  (s ?? '')
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((w) => w.length > 1)
