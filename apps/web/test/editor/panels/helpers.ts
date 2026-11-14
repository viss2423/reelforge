/** Builders shared by the panel tests: richer projects and a small trend-pack fixture. */
import {
  CaptionStyle,
  PackIndex,
  PackManifest,
  sec,
  TextStyle,
  type Clip,
  type Job,
  type Project,
} from '@reelforge/core'
import type { Packs } from '@/api/schemas.ts'
import { createEditorStore, type EditorStoreApi } from '@/state/editorStore.ts'
import { makeAsset, makeProject, videoClip } from '../../fixtures.ts'

export const textClip = (start: number, duration: number, extra: Partial<Clip> = {}): Clip =>
  ({ id: 'txt', type: 'text', start, duration, text: 'Hello', ...extra }) as Clip

export const audioClip = (start: number, duration: number, extra: Partial<Clip> = {}): Clip =>
  ({ id: 'mus', type: 'audio', assetId: 'music', start, duration, role: 'music', ...extra }) as Clip

export const stickerClip = (start: number, duration: number, extra: Partial<Clip> = {}): Clip =>
  ({ id: 'stk', type: 'sticker', start, duration, ref: 'trend/fire', ...extra }) as Clip

/**
 * main: v1 [0,2s) a1, v2 [2s,5s) a2 · overlay: ov [1s,2s) a3 + sticker · text: txt [0,1s)
 * audio: mus [0,5s) (music asset).
 */
export const richProject = (): Project =>
  makeProject({
    tracks: [
      {
        id: 'main',
        kind: 'main',
        clips: [
          videoClip(0, sec(2), { id: 'v1', assetId: 'a1' }),
          videoClip(sec(2), sec(3), { id: 'v2', assetId: 'a2' }),
        ],
      },
      {
        id: 'ov',
        kind: 'overlay',
        clips: [
          videoClip(sec(1), sec(1), { id: 'ov1', assetId: 'a3' }),
          stickerClip(sec(3), sec(1)),
        ],
      },
      { id: 'text', kind: 'text', clips: [textClip(0, sec(1))] },
      { id: 'audio', kind: 'audio', clips: [audioClip(0, sec(5))] },
    ],
  })

export const richAssets = () => ({
  a1: makeAsset({ id: 'a1', duration: sec(10) }),
  a2: makeAsset({ id: 'a2', duration: sec(10) }),
  a3: makeAsset({ id: 'a3', duration: sec(10), width: 1920, height: 1080 }),
  music: makeAsset({
    id: 'music',
    kind: 'audio',
    mime: 'audio/mpeg',
    duration: sec(30),
    hasVideo: false,
  }),
})

/** A fresh store loaded with `richProject` and its assets. */
export const richStore = (): EditorStoreApi => {
  const store = createEditorStore()
  store.getState().load(richProject(), Object.values(richAssets()))
  return store
}

/** Clip by id from the store's project (throws when missing). */
export const clipIn = <C extends Clip = Clip>(store: EditorStoreApi, id: string): C => {
  for (const t of store.getState().project?.tracks ?? [])
    for (const c of t.clips) if (c.id === id) return c as C
  throw new Error(`no clip ${id}`)
}

const sha = 'a'.repeat(64)

export const packsFixture = (): Packs => ({
  index: PackIndex.parse({
    version: '1',
    updatedAt: '2026-11-01',
    packs: [],
    fonts: [
      {
        family: 'Poppins',
        files: [
          { path: 'fonts/Poppins/Poppins-Bold.ttf', sha256: sha, size: 1, weight: 700 },
          { path: 'fonts/Poppins/Poppins-Regular.ttf', sha256: sha, size: 1, weight: 400 },
          {
            path: 'fonts/Poppins/Poppins-Italic.ttf',
            sha256: sha,
            size: 1,
            weight: 400,
            italic: true,
          },
        ],
      },
      {
        family: 'Anton',
        files: [{ path: 'fonts/Anton/Anton.ttf', sha256: sha, size: 1, weight: 400 }],
      },
    ],
  }),
  manifests: [
    PackManifest.parse({
      id: 'trend',
      version: '1.0.0',
      name: 'Trend',
      curatedAt: '2026-11-01',
      captionStyles: [
        {
          id: 'hormozi',
          name: 'Hormozi',
          trendScore: 90,
          thumb: 'thumbs/hormozi.webp',
          style: CaptionStyle.parse({ base: { fontFamily: 'Anton' }, activeColor: '#00FF00' }),
        },
        { id: 'clean', name: 'Clean', trendScore: 40, style: CaptionStyle.parse({ base: {} }) },
      ],
      textPresets: [
        {
          id: 'neon',
          name: 'Neon',
          trendScore: 70,
          style: TextStyle.parse({ color: '#FF00FF' }),
          animationIn: 'builtin/pop',
          sampleText: 'NEON',
        },
        { id: 'plain', name: 'Plain', trendScore: 70, style: TextStyle.parse({}) },
      ],
      filters: [
        { id: 'warm', name: 'Warm', trendScore: 80, lut: 'luts/warm.cube', defaultIntensity: 0.8 },
        { id: 'cold', name: 'Cold', trendScore: 20, lut: 'luts/cold.cube' },
      ],
      animations: [
        { id: 'swoosh', name: 'Swoosh', kind: 'in', trendScore: 60, tracks: {} },
        { id: 'wobble', name: 'Wobble', kind: 'loop', trendScore: 60, tracks: {} },
      ],
      transitions: [{ id: 'whip', name: 'Whip', type: 'whip', trendScore: 95, duration: 300_000 }],
      effects: [{ id: 'shake', name: 'Shake', effect: 'shake', trendScore: 85 }],
      stickers: [
        {
          id: 'fire',
          name: 'Fire',
          file: 'stickers/fire.webp',
          width: 256,
          height: 256,
          trendScore: 99,
        },
      ],
      templates: [],
    }),
    PackManifest.parse({
      id: 'extra',
      version: '1.0.0',
      name: 'Extra',
      curatedAt: '2026-11-01',
      filters: [{ id: 'film', name: 'Film', trendScore: 80, lut: 'luts/film.cube' }],
    }),
  ],
})

let jobSeq = 0
export const makeJob = (over: Partial<Job> = {}): Job =>
  ({
    id: `job${++jobSeq}`,
    kind: 'silence',
    status: 'queued',
    progress: 0,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...over,
  }) as Job
