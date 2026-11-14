/**
 * Test data builders. Projects are built with the core zod schema (defaults filled in) rather
 * than core ops, so these tests don't depend on the ops implementation.
 */
import { Asset, Project, sec, type Clip, type Track } from '@reelforge/core'

let seq = 0
const nextId = (prefix: string) => `${prefix}${++seq}`

export const videoClip = (start: number, duration: number, extra: Partial<Clip> = {}): Clip =>
  ({
    id: nextId('c'),
    type: 'video',
    assetId: 'a1',
    start,
    duration,
    in: 0,
    speed: 1,
    speedRamp: [],
    reverse: false,
    fit: 'cover',
    ...extra,
  }) as Clip

export const makeProject = (
  overrides: { id?: string; name?: string; revision?: number; tracks?: Partial<Track>[] } = {},
): Project =>
  Project.parse({
    id: overrides.id ?? 'p1',
    name: overrides.name ?? 'Test project',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: overrides.revision ?? 1,
    tracks: (
      overrides.tracks ?? [
        { id: 'main', kind: 'main', clips: [videoClip(0, sec(2)), videoClip(sec(2), sec(3))] },
        { id: 'text', kind: 'text', clips: [] },
        { id: 'audio', kind: 'audio', clips: [] },
      ]
    ).map((t, i) => ({ id: `t${i}`, kind: 'overlay', ...t })),
  })

export const makeAsset = (overrides: Partial<Asset> = {}): Asset =>
  Asset.parse({
    id: nextId('a'),
    kind: 'video',
    name: 'clip.mp4',
    size: 1000,
    mime: 'video/mp4',
    createdAt: '2026-01-01T00:00:00.000Z',
    duration: sec(4),
    width: 1080,
    height: 1920,
    hasVideo: true,
    hasAudio: true,
    proxy: 'ready',
    ...overrides,
  })

/** Ids of the clips on track `trackId`, in order. */
export const clipIds = (p: Project | null, trackId = 'main'): string[] =>
  p?.tracks.find((t) => t.id === trackId)?.clips.map((c) => c.id) ?? []

/** Ignores the promise of a fire-and-forget call in tests. */
export const flushMicrotasks = async (times = 5): Promise<void> => {
  for (let i = 0; i < times; i++) await Promise.resolve()
}
