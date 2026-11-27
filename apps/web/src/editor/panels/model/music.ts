/**
 * Auto music: ask the host for ranked royalty-free tracks for this reel, import the pick
 * (download + BPM/chorus analysis on the host) and place it with core `insertMusicClip`
 * (trimmed to the reel, entering at the chorus, fades, beat markers, ducking under speech).
 */
import {
  insertMusicClip,
  reelLength,
  resolvePackItem,
  type Asset,
  type LibraryTrack,
  type MusicImportResult,
  type MusicMood,
  type MusicSuggestResult,
  type PackManifest,
  type Project,
  type RankedTrack,
} from '@reelforge/core'
import { editorStore, type EditorStoreApi } from '@/state/editorStore.ts'
import { edit } from './commands.ts'

export const MOOD_OPTIONS: readonly { value: MusicMood; label: string }[] = [
  { value: 'upbeat', label: 'Upbeat' },
  { value: 'energetic', label: 'Energetic' },
  { value: 'chill', label: 'Chill' },
  { value: 'lofi', label: 'Lo-fi' },
  { value: 'emotional', label: 'Emotional' },
  { value: 'cinematic', label: 'Cinematic' },
  { value: 'inspiring', label: 'Inspiring' },
  { value: 'romantic', label: 'Romantic' },
  { value: 'funny', label: 'Funny' },
  { value: 'dark', label: 'Dark' },
]

/** The slice of the API client auto music needs (injectable for tests). */
export interface MusicApi {
  musicSuggest(
    req: {
      mood?: MusicMood
      vibe?: string
      duration: number
      hasSpeech: boolean
      analyze?: number
      limit?: number
      projectId?: string
    },
    signal?: AbortSignal,
  ): Promise<MusicSuggestResult>
  musicImport(trackId: string, length?: number, signal?: AbortSignal): Promise<MusicImportResult>
}

const FALLBACK_LENGTH = 30_000_000

/** Length the music must fill: the reel's picture, or 30 s for an empty project. */
export const musicLength = (p: Project | null): number => (p && reelLength(p)) || FALLBACK_LENGTH

/**
 * Whether the reel has speech (→ instrumentals + ducking): captions or transcripts with
 * words, or a voiceover clip.
 */
export const detectSpeech = (
  p: Project | null,
  assets: Readonly<Record<string, Asset>>,
): boolean => {
  if (!p) return false
  if ((p.captions?.words.length ?? 0) > 0) return true
  for (const t of p.tracks)
    for (const c of t.clips) {
      if (c.type === 'audio' && c.role === 'voiceover') return true
      if (
        (c.type === 'video' || c.type === 'audio') &&
        (assets[c.assetId]?.transcript?.length ?? 0) > 0
      )
        return true
    }
  return false
}

/** The template's "trending sound" suggestion (a name to pick in the app when posting). */
export const trendingHint = (
  p: Project | null,
  manifests: readonly PackManifest[] | undefined,
): { title: string; bpm?: number; url?: string } | undefined =>
  p?.templateRef && manifests
    ? resolvePackItem(manifests, 'templates', p.templateRef)?.musicHint
    : undefined

/** Imports `track` and places it as the music bed. Returns the new clip id. */
export const placeTrack = async (
  api: MusicApi,
  track: Pick<LibraryTrack, 'id'>,
  opts: { duck: boolean; store?: EditorStoreApi; signal?: AbortSignal },
): Promise<{ clipId: string | undefined; imported: MusicImportResult }> => {
  const store = opts.store ?? editorStore
  const length = musicLength(store.getState().project)
  const imported = await api.musicImport(track.id, length, opts.signal)
  store.getState().upsertAsset(imported.asset)
  const clip = edit(
    'Add music',
    (d) =>
      insertMusicClip(d, {
        asset: imported.asset,
        sourceStart: imported.section.start,
        length,
        duck: opts.duck,
        beats: imported.beats,
        downbeats: imported.downbeats,
      }),
    { store },
  )
  if (clip) store.getState().select([clip.id])
  return { clipId: clip?.id, imported }
}

export interface AutoMusicResult {
  pick: RankedTrack
  /** Every suggestion (best first) for "Try another". */
  suggestions: RankedTrack[]
  clipId: string | undefined
  warnings: string[]
}

/** One tap: suggest for this reel's length/speech, then place the best pick. */
export const autoMusic = async (
  api: MusicApi,
  opts: {
    mood?: MusicMood
    vibe?: string
    duck?: boolean
    store?: EditorStoreApi
    signal?: AbortSignal
    onStatus?: (s: string) => void
  },
): Promise<AutoMusicResult> => {
  const store = opts.store ?? editorStore
  const { project, assets } = store.getState()
  const hasSpeech = opts.duck ?? detectSpeech(project, assets)
  opts.onStatus?.('Finding music on your computer…')
  const res = await api.musicSuggest(
    {
      ...(opts.mood ? { mood: opts.mood } : {}),
      ...(opts.vibe?.trim() ? { vibe: opts.vibe.trim() } : {}),
      duration: musicLength(project),
      hasSpeech,
      analyze: 2,
      limit: 6,
      ...(project ? { projectId: project.id } : {}),
    },
    opts.signal,
  )
  const pick = res.tracks[0]
  if (!pick) throw new Error(res.warnings[0] ?? 'No royalty-free music matched — try another vibe')
  opts.onStatus?.(`Adding “${pick.title}”…`)
  const { clipId } = await placeTrack(api, pick, {
    duck: hasSpeech,
    store,
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  return { pick, suggestions: res.tracks, clipId, warnings: res.warnings }
}
