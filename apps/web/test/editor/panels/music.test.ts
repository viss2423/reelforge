import {
  PackManifest,
  sec,
  type Asset,
  type AudioClip,
  type MusicImportResult,
  type MusicSuggestResult,
  type RankedTrack,
} from '@reelforge/core'
import { describe, expect, it, vi } from 'vitest'
import {
  autoMusic,
  detectSpeech,
  musicLength,
  placeTrack,
  trendingHint,
  type MusicApi,
} from '@/editor/panels/model/music.ts'
import {
  findSimilarFreeTrack,
  freshness,
  loopGrid,
  matchCutsToSound,
  postingName,
  soundProfile,
  type TrendSound,
} from '@/editor/panels/model/trendSounds.ts'
import { createEditorStore } from '@/state/editorStore.ts'
import { makeAsset, makeProject } from '../../fixtures.ts'
import { richAssets, richProject, richStore } from './helpers.ts'

const ranked = (id: string, over: Partial<RankedTrack> = {}): RankedTrack => ({
  id,
  source: 'openverse',
  title: `T ${id}`,
  artist: 'A',
  licence: { code: 'by', name: 'CC BY 4.0', attributionRequired: true },
  duration: sec(120),
  tags: [],
  genres: [],
  cached: true,
  analyzed: true,
  score: 0.8,
  reasons: [],
  ...over,
})

const imported = (id: string): MusicImportResult => ({
  asset: makeAsset({
    id,
    kind: 'audio',
    mime: 'audio/mpeg',
    duration: sec(120),
    hasVideo: false,
    beats: [sec(40), sec(40.5), sec(41)],
    music: {
      source: 'openverse',
      trackId: 'openverse:1',
      title: 'Chorus Song',
      artist: 'A',
      licence: { code: 'by', name: 'CC BY 4.0', attributionRequired: true },
      attribution: '"Chorus Song" by A · CC BY 4.0',
    },
  }) as Asset,
  bpm: 120,
  beats: [sec(40), sec(40.5), sec(41)],
  downbeats: [sec(40)],
  section: { start: sec(40), end: sec(45) },
})

const fakeApi = (tracks: RankedTrack[], warnings: string[] = []) => {
  const api = {
    musicSuggest: vi.fn<MusicApi['musicSuggest']>(async (): Promise<MusicSuggestResult> => ({
      tracks,
      terms: 'x',
      warnings,
      tookMs: 5,
    })),
    musicImport: vi.fn<MusicApi['musicImport']>(async (trackId: string) =>
      imported(`imp-${trackId.split(':')[1]}`),
    ),
  } satisfies MusicApi
  return api
}

const musicClips = (store: ReturnType<typeof richStore>): AudioClip[] =>
  (store.getState().project?.tracks ?? []).flatMap((t) =>
    t.clips.filter((c): c is AudioClip => c.type === 'audio' && c.role === 'music'),
  )

describe('autoMusic', () => {
  it('suggests for the reel length, imports the pick and places it from the chorus', async () => {
    const store = richStore() // main track is 5 s long; has an older music clip
    const api = fakeApi([ranked('openverse:1'), ranked('openverse:2')])
    const status: string[] = []
    const r = await autoMusic(api, {
      mood: 'energetic',
      vibe: ' gym ',
      store,
      onStatus: (s) => status.push(s),
    })
    expect(api.musicSuggest).toHaveBeenCalledWith(
      expect.objectContaining({
        mood: 'energetic',
        vibe: 'gym',
        duration: sec(5),
        hasSpeech: false,
        analyze: 2,
        projectId: expect.any(String),
      }),
      undefined,
    )
    expect(api.musicImport).toHaveBeenCalledWith('openverse:1', sec(5), undefined)
    expect(r.pick.id).toBe('openverse:1')
    expect(r.suggestions).toHaveLength(2)
    const clips = musicClips(store)
    expect(clips).toHaveLength(1) // the old music bed was replaced
    expect(clips[0]).toMatchObject({
      assetId: 'imp-1',
      start: 0,
      duration: sec(5),
      in: sec(40),
      duckUnderVoice: false,
    })
    expect(store.getState().selection.clipIds).toEqual([clips[0]!.id])
    expect(store.getState().assets['imp-1']).toBeDefined()
    expect(
      store
        .getState()
        .project!.markers.filter((m) => m.kind === 'beat')
        .map((m) => m.t),
    ).toEqual([0, sec(0.5), sec(1)])
    expect(status[0]).toMatch(/Finding music/)
    expect(status[1]).toMatch(/T openverse:1/)
    // One undo step removes the music again.
    store.getState().undo()
    expect(musicClips(store).map((c) => c.id)).toEqual(['mus'])
  })

  it('ducks and asks for instrumentals when the reel has speech', async () => {
    const store = richStore()
    store.getState().dispatch('captions', (d) => {
      d.captions = {
        enabled: true,
        language: 'en',
        words: [{ text: 'hi', start: 0, end: 1000, confidence: 1, filler: false, emphasis: false }],
        style: { base: {} } as never,
      }
    })
    const api = fakeApi([ranked('openverse:1')])
    await autoMusic(api, { store })
    expect(api.musicSuggest).toHaveBeenCalledWith(
      expect.objectContaining({ hasSpeech: true }),
      undefined,
    )
    expect(musicClips(store)[0]!.duckUnderVoice).toBe(true)
  })

  it('fails with the host warning when nothing matched', async () => {
    const store = richStore()
    const api = fakeApi([], ['Openverse: offline'])
    await expect(autoMusic(api, { store })).rejects.toThrow('Openverse: offline')
    expect(api.musicImport).not.toHaveBeenCalled()
  })
})

describe('placeTrack', () => {
  it('places a browsed track on a project with no video using 30 s', async () => {
    const store = createEditorStore()
    store.getState().load(
      makeProject({
        tracks: [
          { id: 'main', kind: 'main', clips: [] },
          { id: 'audio', kind: 'audio', clips: [] },
        ],
      }),
      [],
    )
    const api = fakeApi([])
    const { clipId } = await placeTrack(api, { id: 'openverse:7' }, { duck: false, store })
    expect(api.musicImport).toHaveBeenCalledWith('openverse:7', sec(30), undefined)
    expect(musicClips(store)[0]).toMatchObject({ id: clipId, duration: sec(30) })
  })
})

describe('helpers', () => {
  it('detects speech from captions, transcripts and voiceovers', () => {
    const p = richProject()
    const assets = richAssets()
    expect(detectSpeech(p, assets)).toBe(false)
    expect(detectSpeech(null, assets)).toBe(false)
    expect(
      detectSpeech(p, {
        ...assets,
        a1: {
          ...assets.a1,
          transcript: [
            { text: 'x', start: 0, end: 1, confidence: 1, filler: false, emphasis: false },
          ],
        },
      }),
    ).toBe(true)
    const vo = structuredClone(p)
    const audio = vo.tracks.find((t) => t.kind === 'audio')!
    ;(audio.clips[0] as AudioClip).role = 'voiceover'
    expect(detectSpeech(vo, assets)).toBe(true)
  })

  it('reel length falls back to 30 s', () => {
    expect(musicLength(null)).toBe(sec(30))
    expect(musicLength(richProject())).toBe(sec(5))
  })

  it('reads the template music hint', () => {
    const manifests = [
      PackManifest.parse({
        id: 'trend',
        version: '1',
        name: 'T',
        curatedAt: '2026-11-01',
        templates: [
          {
            id: 'fast',
            name: 'Fast',
            trendScore: 50,
            slots: [],
            musicHint: { title: 'Espresso (sped up)', bpm: 104 },
          },
        ],
      }),
    ]
    const p = { ...richProject(), templateRef: 'trend/fast' }
    expect(trendingHint(p, manifests)).toEqual({ title: 'Espresso (sped up)', bpm: 104 })
    expect(trendingHint(richProject(), manifests)).toBeUndefined()
    expect(trendingHint(p, undefined)).toBeUndefined()
  })
})

describe('trending sounds', () => {
  const sound: TrendSound = {
    title: 'Club Hit',
    artist: 'DJ',
    bpm: 126,
    measured: false,
    sources: ['deezer'],
    link: 'https://www.deezer.com/search/x',
    genre: 'Dance',
    mood: 'energetic',
    energy: 0.85,
    firstSeen: '2026-11-20T08:00:00Z',
    fresh: false,
  }

  it('labels freshness and the name to paste when posting', () => {
    expect(freshness({ ...sound, fresh: true })).toBe('New today')
    expect(freshness(sound, Date.parse('2026-11-23T08:00:00Z'))).toBe('3 days on the charts')
    expect(freshness({ fresh: false })).toBe('Trending')
    expect(postingName(sound)).toBe('Club Hit – DJ')
  })

  it('profiles a sound for the music ranker (unknown moods dropped)', () => {
    expect(soundProfile(sound)).toEqual({
      title: 'Club Hit',
      artist: 'DJ',
      bpm: 126,
      genre: 'Dance',
      mood: 'energetic',
      energy: 0.85,
    })
    expect(soundProfile({ ...sound, mood: 'weird' }).mood).toBeUndefined()
  })

  it('Find similar free track asks for that sound in trend order and places the pick', async () => {
    const store = richStore()
    const api = fakeApi([ranked('openverse:9')])
    const r = await findSimilarFreeTrack(api, sound, { store })
    expect(api.musicSuggest).toHaveBeenCalledWith(
      expect.objectContaining({ order: 'trend', sound: soundProfile(sound), analyze: 1 }),
      undefined,
    )
    expect(r.pick.id).toBe('openverse:9')
    expect(musicClips(store)).toHaveLength(1)
  })

  it('loops the 30 s beat grid over a longer reel', () => {
    const g = { beats: [0, 10_000_000, 20_000_000], downbeats: [0], duration: 30_000_000 }
    expect(loopGrid(g, 65_000_000)).toEqual({
      beats: [0, 10_000_000, 20_000_000, 30_000_000, 40_000_000, 50_000_000, 60_000_000],
      downbeats: [0, 30_000_000, 60_000_000],
    })
    expect(loopGrid({ ...g, duration: 0 }, 10)).toEqual({ beats: [], downbeats: [] })
  })

  it('Match cuts re-times main-track cuts to the sound in one undo step', () => {
    const store = richStore()
    const before = store.getState().project!
    const beats = Array.from({ length: 80 }, (_, i) => 130_000 + i * 370_000)
    const ok = matchCutsToSound(
      { beats, downbeats: beats.filter((_, i) => i % 4 === 0), duration: 30_000_000 },
      store,
    )
    expect(ok).toBe(true)
    expect(store.getState().project).not.toBe(before)
  })
})
