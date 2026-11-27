/**
 * Trending sounds in the editor (Audio panel, Export dialog): today's chart sounds from the
 * trend engine, a one-tap trend-matched royalty-free stand-in, "Preview with my reel" (the
 * official 30 s clip, streamed for playback only) and "Match cuts to this sound".
 */
import {
  musicSyncOptions,
  syncToBeats,
  type MusicMood,
  type MusicSuggestRequest,
  type MusicSuggestResult,
  type Project,
  type RankedTrack,
  type Us,
} from '@reelforge/core'
import type { SoundRef } from '@/api/client.ts'
import type { SoundBeats, Trends } from '@/api/schemas.ts'
import { editorStore, type EditorStoreApi } from '@/state/editorStore.ts'
import { edit } from './commands.ts'
import { detectSpeech, musicLength, placeTrack, type MusicApi } from './music.ts'

export type TrendSound = Trends['sounds'][number]

const MOODS: ReadonlySet<string> = new Set<MusicMood>([
  'upbeat',
  'energetic',
  'chill',
  'emotional',
  'cinematic',
  'dark',
  'romantic',
  'funny',
  'inspiring',
  'lofi',
])

/** The sound as a trend profile for the music ranker. */
export const soundProfile = (s: TrendSound): NonNullable<MusicSuggestRequest['sound']> => ({
  title: s.title,
  ...(s.artist ? { artist: s.artist } : {}),
  ...(s.bpm > 0 ? { bpm: s.bpm } : {}),
  ...(s.genre ? { genre: s.genre } : {}),
  ...(s.mood && MOODS.has(s.mood) ? { mood: s.mood as MusicMood } : {}),
  ...(s.energy !== undefined ? { energy: Math.min(1, Math.max(0, s.energy)) } : {}),
})

export const soundRef = (s: Pick<TrendSound, 'title' | 'artist'>): SoundRef => ({
  title: s.title,
  ...(s.artist ? { artist: s.artist } : {}),
})

/** "New today" / "3 days on the charts" from the first time the engine saw it. */
export const freshness = (s: Pick<TrendSound, 'firstSeen' | 'fresh'>, now = Date.now()): string => {
  if (s.fresh) return 'New today'
  if (!s.firstSeen) return 'Trending'
  const days = Math.max(1, Math.round((now - Date.parse(s.firstSeen)) / 86_400_000))
  return `${days} day${days === 1 ? '' : 's'} on the charts`
}

/** Name to paste into Instagram's sound picker. */
export const postingName = (s: Pick<TrendSound, 'title' | 'artist'>): string =>
  s.artist ? `${s.title} – ${s.artist}` : s.title

/** One tap: the royalty-free track most similar to `sound`, placed as the music bed. */
export const findSimilarFreeTrack = async (
  api: MusicApi & {
    musicSuggest(req: MusicSuggestRequest, signal?: AbortSignal): Promise<MusicSuggestResult>
  },
  sound: TrendSound,
  opts: { store?: EditorStoreApi; signal?: AbortSignal } = {},
): Promise<{ pick: RankedTrack; clipId: string | undefined }> => {
  const store = opts.store ?? editorStore
  const { project, assets } = store.getState()
  const hasSpeech = detectSpeech(project, assets)
  const res = await api.musicSuggest(
    {
      order: 'trend',
      sound: soundProfile(sound),
      duration: musicLength(project),
      hasSpeech,
      analyze: 1,
      limit: 3,
    },
    opts.signal,
  )
  const pick = res.tracks[0]
  if (!pick) throw new Error(res.warnings[0] ?? 'No similar royalty-free track was found')
  const { clipId } = await placeTrack(api, pick, {
    duck: hasSpeech,
    store,
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  return { pick, clipId }
}

/** Repeats a sound's beat grid (one preview clip long) across `length` of timeline. */
export const loopGrid = (
  g: Pick<SoundBeats, 'beats' | 'downbeats' | 'duration'>,
  length: Us,
): { beats: Us[]; downbeats: Us[] } => {
  const beats: Us[] = []
  const downbeats: Us[] = []
  if (g.duration <= 0) return { beats, downbeats }
  for (let k = 0; k * g.duration < length; k++) {
    const off = k * g.duration
    for (const b of g.beats) if (off + b < length) beats.push(Math.round(off + b))
    for (const b of g.downbeats) if (off + b < length) downbeats.push(Math.round(off + b))
  }
  return { beats, downbeats }
}

/** Re-times the main-track cuts to the sound's beat (bars when the grid is clear). */
export const matchCutsToSound = (
  g: Pick<SoundBeats, 'beats' | 'downbeats' | 'duration'>,
  store: EditorStoreApi = editorStore,
): boolean => {
  const project = store.getState().project
  if (!project) return false
  const { beats, downbeats } = loopGrid(g, musicLength(project) + g.duration)
  if (beats.length < 2) return false
  return (
    edit(
      'Match cuts to sound',
      (d: Project) => {
        syncToBeats(d, beats, musicSyncOptions(2, beats, downbeats))
        return true
      },
      { store },
    ) ?? false
  )
}
