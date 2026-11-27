/**
 * Minimal stand-ins for core ops that are still stubs on this branch. They implement just
 * enough of each op's contract (draft mutation, return values, magnetic main track) for the
 * panel tests to check how panels DRIVE the ops — targets, arguments, undo grouping — not
 * the ops' own algorithms, which core tests cover.
 *
 * Usage (in each test file):
 *   vi.mock('@reelforge/core', async (importOriginal) => {
 *     const real = await importOriginal<typeof import('@reelforge/core')>()
 *     const { fakeCore } = await import('./fakeCore.ts')
 *     return { ...real, ...fakeCore(real) }
 *   })
 * This module must only import TYPES from core (it is loaded while core is being mocked).
 */
import type * as Core from '@reelforge/core'
import { vi } from 'vitest'

type CoreModule = typeof Core
type P = Core.Project

const findTrackOf = (p: P, clipId: string) => {
  for (const track of p.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId)
    if (index !== -1) return { track, index, clip: track.clips[index]! }
  }
  return undefined
}

let seq = 0
const id = (prefix: string) => `${prefix}-fake${++seq}`

export const fakeCore = (real: CoreModule) => {
  const fail = (code: string, msg: string): never => {
    throw new real.OpError(code, msg)
  }
  const normalizeMainTrack = (p: P) => {
    const main = p.tracks.find((t) => t.kind === 'main')
    let t = 0
    for (const c of main?.clips ?? []) {
      c.start = t
      t += c.duration
    }
  }
  const evaluate = (a: Core.Animatable, t: number): number => {
    const k = a.keyframes
    if (k.length === 0) return a.value
    if (t <= k[0]!.t) return k[0]!.value
    for (let i = 1; i < k.length; i++) {
      const b = k[i]!
      if (t <= b.t) {
        const prev = k[i - 1]!
        if (b.easing === 'hold') return prev.value
        return prev.value + ((b.value - prev.value) * (t - prev.t)) / (b.t - prev.t)
      }
    }
    return k.at(-1)!.value
  }
  const trackOfKind = (p: P, kind: Core.TrackKind, trackId?: string) => {
    let track = trackId
      ? p.tracks.find((t) => t.id === trackId)
      : p.tracks.find((t) => t.kind === kind)
    if (!track) {
      track = real.Track.parse({ id: id('t'), kind })
      p.tracks.push(track)
      track = p.tracks.at(-1)!
    }
    return track
  }
  const push = <C extends Core.Clip>(p: P, kind: Core.TrackKind, clip: C, trackId?: string): C => {
    const track = trackOfKind(p, kind, trackId)
    track.clips.push(clip)
    track.clips.sort((a, b) => a.start - b.start)
    // Return the draft proxy (Immer wraps pushed objects lazily).
    return track.clips.find((c) => c.id === clip.id)! as C
  }

  return {
    evaluate: vi.fn<CoreModule['evaluate']>(evaluate),
    normalizeMainTrack: vi.fn<CoreModule['normalizeMainTrack']>(normalizeMainTrack),
    setClipSpeed: vi.fn<CoreModule['setClipSpeed']>((p: P, clipId: string, speed: number) => {
      const loc = findTrackOf(p, clipId) ?? fail('not_found', clipId)
      const c = loc.clip as Core.MediaClip
      c.duration = Math.max(1, Math.round((c.duration * c.speed) / speed))
      c.speed = speed
      normalizeMainTrack(p)
    }),
    trimClip: vi.fn<CoreModule['trimClip']>(
      (p: P, clipId: string, e: { start?: number; end?: number }) => {
        const c = (findTrackOf(p, clipId) ?? fail('not_found', clipId)).clip
        const end = e.end ?? c.start + c.duration
        const start = e.start ?? c.start
        c.start = start
        c.duration = end - start
      },
    ),
    moveClip: vi.fn<CoreModule['moveClip']>(
      (p: P, clipId: string, to: { trackId?: string; start?: number }) => {
        const loc = findTrackOf(p, clipId) ?? fail('not_found', clipId)
        const [clip] = loc.track.clips.splice(loc.index, 1)
        const dest = to.trackId ? p.tracks.find((t) => t.id === to.trackId)! : loc.track
        dest.clips.push({ ...clip!, start: to.start ?? clip!.start })
      },
    ),
    addTrack: vi.fn<CoreModule['addTrack']>(
      (p: P, kind: Core.TrackKind, opts?: { index?: number }) => {
        const track = real.Track.parse({ id: id('t'), kind })
        p.tracks.splice(opts?.index ?? p.tracks.length, 0, track)
        return p.tracks.find((t) => t.id === track.id)!
      },
    ),
    insertTextClip: vi.fn<CoreModule['insertTextClip']>(
      (p: P, a: Parameters<CoreModule['insertTextClip']>[1]) =>
        push(
          p,
          'text',
          real.TextClip.parse({
            id: id('text'),
            type: 'text',
            start: a.at,
            duration: a.duration ?? 3_000_000,
            text: a.text,
            style: real.TextStyle.parse(a.style ?? {}),
            ...(a.presetRef ? { presetRef: a.presetRef } : {}),
          }),
          a.trackId,
        ),
    ),
    insertStickerClip: vi.fn<CoreModule['insertStickerClip']>(
      (p: P, a: Parameters<CoreModule['insertStickerClip']>[1]) =>
        push(
          p,
          'overlay',
          real.StickerClip.parse({
            id: id('st'),
            type: 'sticker',
            start: a.at,
            duration: a.duration ?? 3_000_000,
            ...(a.ref ? { ref: a.ref } : {}),
            ...(a.assetId ? { assetId: a.assetId } : {}),
          }),
          a.trackId,
        ),
    ),
    insertAudioClip: vi.fn<CoreModule['insertAudioClip']>(
      (p: P, a: Parameters<CoreModule['insertAudioClip']>[1]) =>
        push(
          p,
          'audio',
          real.AudioClip.parse({
            id: id('aud'),
            type: 'audio',
            start: a.at,
            duration: a.asset.duration ?? 1_000_000,
            assetId: a.asset.id,
            role: a.role ?? 'music',
          }),
          a.trackId,
        ),
    ),
    splitClip: vi.fn<CoreModule['splitClip']>(
      (p: P, clipId: string, t: number): [Core.Clip, Core.Clip] => {
        const loc = findTrackOf(p, clipId) ?? fail('not_found', clipId)
        const c = loc.clip
        if (t <= c.start || t >= c.start + c.duration) fail('out_of_range', 'split outside clip')
        const right = { ...c, id: id(`${clipId}-r`), start: t, duration: c.start + c.duration - t }
        c.duration = t - c.start
        loc.track.clips.splice(loc.index + 1, 0, right)
        return [loc.track.clips[loc.index]!, loc.track.clips[loc.index + 1]!]
      },
    ),
    /** Shortens the clip by the cut length (timeline time) and re-packs the main track. */
    removeSourceRanges: vi.fn<CoreModule['removeSourceRanges']>(
      (p: P, clipId: string, ranges: readonly Core.Range[]) => {
        const c = (findTrackOf(p, clipId) ?? fail('not_found', clipId)).clip as Core.MediaClip
        const cut = ranges.reduce((n, r) => n + r.end - r.start, 0)
        c.duration = Math.max(1, Math.round(c.duration - cut / c.speed))
        normalizeMainTrack(p)
      },
    ),
    buildCaptions: vi.fn<CoreModule['buildCaptions']>(
      (
        p: P,
        transcripts: Readonly<Record<string, readonly Core.Word[]>>,
        style: Core.CaptionStyle,
        opts?: { styleRef?: string; language?: string },
      ) => {
        const words = Object.values(transcripts)
          .flat()
          .map((w) => ({ ...w }))
          .sort((a, b) => a.start - b.start)
        p.captions = {
          enabled: true,
          language: opts?.language ?? 'auto',
          words,
          style,
          ...(opts?.styleRef ? { styleRef: opts.styleRef } : {}),
        }
      },
    ),
    syncToBeats: vi.fn<CoreModule['syncToBeats']>(
      (_p: P, _beats: readonly number[], _opts?: Core.BeatSyncOptions) => {},
    ),
    applyReframe: vi.fn<CoreModule['applyReframe']>(
      (p: P, clipId: string, path: ReadonlyArray<{ t: number; x: number }>) => {
        const c = (findTrackOf(p, clipId) ?? fail('not_found', clipId)).clip as Core.MediaClip
        c.transform.x.keyframes = path.map((pt) => ({
          t: pt.t,
          value: pt.x * 1080,
          easing: 'linear',
        }))
      },
    ),
    /** Linear mapping (no reverse/ramps): visible when the source time is inside the clip. */
    sourceToTimeline: vi.fn<CoreModule['sourceToTimeline']>(
      (clip: Core.MediaClip | Core.AudioClip, s: number) => {
        const t = clip.start + (s - clip.in) / clip.speed
        return t >= clip.start && t < clip.start + clip.duration ? t : undefined
      },
    ),
  }
}
