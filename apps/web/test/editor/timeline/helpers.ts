/**
 * Builders for timeline tests. Clips, tracks and projects go through the core zod schema so
 * every default (transform, audio props, flags) is present, without depending on core ops.
 */
import { Clip, Project, Track, sec, type Marker, type Word } from '@reelforge/core'

let seq = 0

const DEFAULTS: Record<Clip['type'], Record<string, unknown>> = {
  video: { assetId: 'vid' },
  image: { assetId: 'img' },
  audio: { assetId: 'aud' },
  text: { text: 'Hello' },
  sticker: { ref: 'pack/sticker' },
}

/** A clip of `type` at `start` (µs) lasting `duration` (µs), schema defaults filled in. */
export const clip = (
  type: Clip['type'],
  start: number,
  duration: number,
  extra: Record<string, unknown> = {},
): Clip => Clip.parse({ id: `k${++seq}`, type, start, duration, ...DEFAULTS[type], ...extra })

/** Contiguous main-track video clips (ids m0, m1, …) with the given durations in seconds. */
export const mainClips = (...seconds: number[]): Clip[] => {
  let t = 0
  return seconds.map((s, i) => {
    const c = clip('video', t, sec(s), { id: `m${i}` })
    t += sec(s)
    return c
  })
}

/** A track of `kind` holding `clips`. */
export const track = (kind: Track['kind'], clips: Clip[], id: string = kind, extra = {}): Track =>
  Track.parse({ id, kind, clips, ...extra })

/** A project with the given tracks (plus optional markers / caption words). */
export const project = (
  tracks: Track[],
  opts: { markers?: Marker[]; words?: Partial<Word>[]; fps?: number } = {},
): Project =>
  Project.parse({
    id: 'p1',
    name: 'Timeline test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: 1,
    tracks,
    markers: opts.markers ?? [],
    ...(opts.fps ? { settings: { fps: opts.fps } } : {}),
    ...(opts.words
      ? {
          captions: {
            words: opts.words,
            style: { base: {} },
          },
        }
      : {}),
  })
