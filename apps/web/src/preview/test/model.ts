/**
 * Project-model builders for tests. They go through the real zod schemas from
 * @reelforge/core (fully implemented) so defaults match production data exactly.
 */
import {
  Asset,
  AudioClip,
  MediaClip,
  Project,
  StickerClip,
  Track,
  type Clip,
  type TrackKind,
} from '@reelforge/core'

/** Builder overrides: the schema INPUT type (defaults optional, nested objects partial). */
type Input<S extends { _zod: { input: unknown } }> = Partial<Exclude<SchemaInput<S>, undefined>>
/** zod 4 input type (defaults optional) without importing zod directly. */
type SchemaInput<S extends { _zod: { input: unknown } }> = S['_zod']['input']

let seq = 0
const nextId = (p: string): string => `${p}${++seq}`

export const video = (o: Input<typeof MediaClip> = {}): MediaClip =>
  MediaClip.parse({
    id: nextId('v'),
    type: 'video',
    assetId: 'a1',
    start: 0,
    duration: 1_000_000,
    ...o,
  })

export const image = (o: Input<typeof MediaClip> = {}): MediaClip =>
  MediaClip.parse({
    id: nextId('i'),
    type: 'image',
    assetId: 'img1',
    start: 0,
    duration: 1_000_000,
    ...o,
  })

export const sticker = (o: Input<typeof StickerClip> = {}): StickerClip =>
  StickerClip.parse({
    id: nextId('s'),
    type: 'sticker',
    ref: 'pack/star',
    start: 0,
    duration: 1_000_000,
    ...o,
  })

export const audio = (o: Input<typeof AudioClip> = {}): AudioClip =>
  AudioClip.parse({
    id: nextId('au'),
    type: 'audio',
    assetId: 'm1',
    start: 0,
    duration: 1_000_000,
    ...o,
  })

export const track = (kind: TrackKind, clips: Clip[], o: Input<typeof Track> = {}): Track =>
  Track.parse({ id: nextId('t'), kind, clips, ...o })

/** Lay out main-track clips contiguously in the MODEL (as core's ops do). */
export function mainTrack(clips: MediaClip[], o: Input<typeof Track> = {}): Track {
  let at = 0
  for (const c of clips) {
    c.start = at
    at += c.duration
  }
  return track('main', clips, o)
}

export const project = (tracks: Track[], o: Partial<SchemaInput<typeof Project>> = {}): Project =>
  Project.parse({
    id: 'p1',
    name: 'Test',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    tracks,
    ...o,
  })

export const asset = (o: Input<typeof Asset> = {}): Asset =>
  Asset.parse({
    id: 'a1',
    kind: 'video',
    name: 'clip.mp4',
    size: 1,
    mime: 'video/mp4',
    createdAt: '2026-01-01T00:00:00Z',
    width: 1080,
    height: 1920,
    duration: 10_000_000,
    hasVideo: true,
    hasAudio: true,
    proxy: 'ready',
    ...o,
  })
