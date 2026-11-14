/**
 * Builds the dev harness' demo project: one timeline that exercises every compositor path
 * (cover/contain + blurred fill, transitions, LUT, adjustments, effects, chroma-keyed
 * overlay, sticker with keyframes, text, captions, music with fades). Media can be the
 * generated fixtures (dev/fixtures.ts) or any files the user picks.
 */
import {
  Asset,
  EffectPreset,
  Project,
  type AssetKind,
  type Clip,
  type MediaClip,
  type Track,
  type TransitionType,
} from '@reelforge/core'

export interface MediaEntry {
  name: string
  kind: AssetKind
  url: string
  width?: number | undefined
  height?: number | undefined
  duration?: number | undefined
  hasAudio?: boolean | undefined
}

export interface Demo {
  project: Project
  assets: Record<string, Asset>
  urls: Record<string, string>
}

const NOW = '2026-01-01T00:00:00.000Z'

export function toAsset(e: MediaEntry, id: string): Asset {
  return Asset.parse({
    id,
    kind: e.kind,
    name: e.name,
    size: 1,
    mime: e.kind === 'image' ? 'image/png' : e.kind === 'audio' ? 'audio/mp4' : 'video/mp4',
    createdAt: NOW,
    width: e.width,
    height: e.height,
    duration: e.duration,
    hasVideo: e.kind === 'video',
    hasAudio: e.hasAudio ?? false,
    proxy: 'ready',
  })
}

let seq = 0
const id = (p: string): string => `${p}${++seq}`

/**
 * Demo timeline. Main-track clips cycle through the picked videos/images with a rotating
 * set of transitions; extra tracks are added when suitable media exists.
 */
export function buildDemo(media: readonly MediaEntry[], opts: { clips?: number } = {}): Demo {
  const assets: Record<string, Asset> = {}
  const urls: Record<string, string> = {}
  const byKind = { video: [] as string[], image: [] as string[], audio: [] as string[] }
  media.forEach((m, i) => {
    const aid = `asset${i + 1}`
    assets[aid] = toAsset(m, aid)
    urls[aid] = m.url
    byKind[m.kind].push(aid)
  })
  const visual = [...byKind.video.filter((a) => !/green/i.test(assets[a]!.name)), ...byKind.image]
  const transitions: TransitionType[] = [
    'wipeleft',
    'circleopen',
    'glitch',
    'slideup',
    'whip',
    'fade',
  ]
  const main: MediaClip[] = []
  const n = opts.clips ?? 5
  let at = 0
  for (let i = 0; i < n && visual.length > 0; i++) {
    const aid = visual[i % visual.length]!
    const a = assets[aid]!
    const duration = 2_500_000
    const srcDur = a.duration ?? 0
    const clip: Clip = {
      id: id('m'),
      type: a.kind === 'image' ? 'image' : 'video',
      assetId: aid,
      start: at,
      duration,
      in: srcDur > duration ? (i * 1_300_000) % (srcDur - duration) : 0,
      fit: a.width && a.height && a.width > a.height ? 'contain' : 'cover',
      ...(i > 0
        ? { transitionIn: { type: transitions[(i - 1) % transitions.length]!, duration: 500_000 } }
        : {}),
      ...(i === 0 ? { filter: { ref: 'dev/warm', intensity: 0.8 } } : {}),
      ...(i === 1 ? { adjustments: { contrast: 20, saturation: 30, vignette: 40 } } : {}),
      ...(i % 3 === 2
        ? { effects: [{ id: id('fx'), ref: i % 2 ? 'dev/shake' : 'dev/zoomPulse', start: 0 }] }
        : {}),
      ...(a.kind === 'image' ? { autoMotion: 'zoomIn' as const } : {}),
    } as Clip
    main.push(clip as MediaClip)
    at += duration
  }
  const tracks: Partial<Track>[] = [{ id: 'main', kind: 'main', clips: main }]
  const overlay: Clip[] = []
  const green = byKind.video.find((a) => /green/i.test(assets[a]!.name))
  if (green) {
    overlay.push({
      id: id('o'),
      type: 'video',
      assetId: green,
      start: 1_000_000,
      duration: 4_000_000,
      chromaKey: { enabled: true, color: '#00ff00', similarity: 0.3, blend: 0.1 },
      transform: { x: { value: 760 }, y: { value: 520 }, scale: { value: 0.45 } },
    } as Clip)
  }
  const img = byKind.image[0]
  if (img) {
    overlay.push({
      id: id('o'),
      type: 'image',
      assetId: img,
      start: 5_500_000,
      duration: 3_000_000,
      fit: 'contain',
      blendMode: 'screen',
      transform: {
        x: { value: 300 },
        y: { value: 1500 },
        scale: { value: 0.3 },
        rotation: {
          value: 0,
          keyframes: [
            { t: 0, value: -20, easing: 'linear' },
            { t: 3_000_000, value: 20, easing: 'easeInOut' },
          ],
        },
      },
    } as Clip)
  }
  if (overlay.length > 0) tracks.push({ id: 'overlay', kind: 'overlay', clips: overlay })
  tracks.push({
    id: 'text',
    kind: 'text',
    clips: [
      {
        id: id('t'),
        type: 'text',
        text: 'ReelForge preview',
        start: 0,
        duration: 4_000_000,
        transform: { y: { value: 300 } },
      } as Clip,
    ],
  })
  const music = byKind.audio[0]
  if (music) {
    tracks.push({
      id: 'music',
      kind: 'audio',
      clips: [
        {
          id: id('a'),
          type: 'audio',
          assetId: music,
          start: 0,
          duration: Math.min(assets[music]!.duration ?? 10_000_000, Math.max(at, 1)),
          audio: { volume: 0.4, fadeIn: 1_000_000, fadeOut: 1_000_000 },
        } as Clip,
      ],
    })
  }
  const words = 'Every frame is composited live on the GPU'.split(' ')
  const project = Project.parse({
    id: 'demo',
    name: 'Preview demo',
    createdAt: NOW,
    updatedAt: NOW,
    settings: { backgroundBlur: true },
    tracks,
    captions: {
      words: words.map((text, i) => ({
        text,
        start: 400_000 + i * 450_000,
        end: 800_000 + i * 450_000,
      })),
      style: { base: {}, maxWordsPerLine: 3 },
    },
  })
  return { project, assets, urls }
}

/** Effect presets addressable as `dev/<effect>` from harness projects. */
export function devEffect(ref: string): EffectPreset | undefined {
  const [pack, effect] = ref.split('/')
  if (pack !== 'dev' || !effect) return undefined
  const r = EffectPreset.safeParse({ id: effect, name: effect, effect })
  return r.success ? r.data : undefined
}

/** A 17³ warm/teal grade as .cube text (the harness' `dev/warm` filter). */
export function warmCube(n = 17): string {
  const lines = ['TITLE "dev warm"', `LUT_3D_SIZE ${n}`]
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const R = r / (n - 1)
        const G = g / (n - 1)
        const B = b / (n - 1)
        const l = 0.2126 * R + 0.7152 * G + 0.0722 * B
        // warm highlights, teal shadows, gentle S-curve
        const s = (x: number): number => x * x * (3 - 2 * x) * 0.35 + x * 0.65
        const out = [s(R) + 0.06 * l, s(G) + 0.01, s(B) + 0.08 * (1 - l) - 0.04 * l]
        lines.push(out.map((v) => Math.min(1, Math.max(0, v)).toFixed(6)).join(' '))
      }
    }
  }
  return lines.join('\n')
}
