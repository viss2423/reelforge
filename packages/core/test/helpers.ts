/** Shared fixtures for core tests. */
import {
  Asset,
  CaptionStyle,
  TextClip,
  Word,
  createProject,
  insertMediaClip,
  mainTrack,
  type MediaClip,
  type Project,
} from '../src/index.ts'

export const NOW = '2026-01-01T00:00:00.000Z'

let seq = 0

/** A probed asset (defaults: 10 s 1920×1080 video with audio). */
export function asset(overrides: Partial<Asset> & { kind?: Asset['kind'] } = {}): Asset {
  seq++
  const kind = overrides.kind ?? 'video'
  return Asset.parse({
    id: `a${seq}`,
    kind,
    name: `${kind}-${seq}`,
    size: 1000,
    mime: kind === 'audio' ? 'audio/mp4' : kind === 'image' ? 'image/png' : 'video/mp4',
    createdAt: NOW,
    duration: kind === 'image' ? undefined : 10_000_000,
    width: 1920,
    height: 1080,
    hasAudio: kind !== 'image',
    hasVideo: kind !== 'audio',
    ...overrides,
  })
}

/** Empty project with a deterministic id. */
export const project = (fps: 24 | 25 | 30 | 50 | 60 = 30): Project =>
  createProject({ name: 'Test', id: 'p_test', now: NOW, fps })

/** Project whose main track holds one clip per duration (each from its own 10 s asset). */
export function projectWithMain(durations: number[]): {
  p: Project
  clips: MediaClip[]
  assets: Record<string, Asset>
} {
  const p = project()
  const assets: Record<string, Asset> = {}
  const track = mainTrack(p)
  const clips = durations.map((d) => {
    const a = asset()
    assets[a.id] = a
    return insertMediaClip(p, { trackId: track.id, asset: a, duration: d })
  })
  return { p, clips, assets }
}

/** Words "w0 w1 …" each `len` µs long separated by `gap` µs, starting at `from`. */
export function words(n: number, opts: { from?: number; len?: number; gap?: number } = {}): Word[] {
  const len = opts.len ?? 300_000
  const gap = opts.gap ?? 100_000
  let t = opts.from ?? 0
  return Array.from({ length: n }, (_, i) => {
    const w = Word.parse({ text: `w${i}`, start: t, end: t + len })
    t += len + gap
    return w
  })
}

export const captionStyle = (overrides: Record<string, unknown> = {}): CaptionStyle =>
  CaptionStyle.parse({ base: {}, ...overrides })

export const textClip = (overrides: Record<string, unknown> = {}): TextClip =>
  TextClip.parse({
    id: 'tx1',
    type: 'text',
    start: 0,
    duration: 2_000_000,
    text: 'Hello',
    ...overrides,
  })
