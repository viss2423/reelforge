import { describe, expect, it } from 'vitest'
import {
  PackManifest,
  TemplatePreset,
  applyTemplate,
  mainTrack,
  mainTrackLayout,
  parseRef,
  projectDuration,
  resolveAnimationRef,
  resolvePackItem,
  validateProject,
  type Asset,
  type MediaClip,
  type TextClip,
} from '../src/index.ts'
import { NOW, asset } from './helpers.ts'

const SEC = 1_000_000

const pack = PackManifest.parse({
  id: 'trend',
  version: '1.0.0',
  name: 'Trend',
  curatedAt: NOW,
  captionStyles: [
    { id: 'hormozi', name: 'Hormozi', style: { base: { fontFamily: 'Anton' }, mode: 'pop' } },
  ],
  textPresets: [
    {
      id: 'title',
      name: 'Title',
      style: { fontFamily: 'Bebas Neue', fontSize: 140 },
      animationIn: 'builtin/pop',
      animationOut: 'trend/drop',
      animationLoop: 'trend/missing',
    },
  ],
  filters: [{ id: 'teal', name: 'Teal', lut: 'luts/teal.cube', defaultIntensity: 0.7 }],
  animations: [
    {
      id: 'drop',
      name: 'Drop',
      kind: 'out',
      tracks: {
        y: [
          { t: 0, value: 0 },
          { t: 1, value: 200 },
        ],
      },
    },
  ],
  effects: [{ id: 'shake', name: 'Shake', effect: 'shake' }],
  templates: [
    {
      id: 'fast-cuts',
      name: 'Fast cuts',
      fps: 60,
      background: '#112233',
      captionStyle: 'trend/hormozi',
      slots: [
        {
          duration: 2 * SEC,
          kind: 'video',
          effects: ['trend/shake', 'trend/nope'],
          filter: 'trend/teal',
        },
        {
          duration: 2 * SEC,
          kind: 'image',
          transitionIn: { type: 'whip', duration: 300_000 },
          text: { text: 'WAIT FOR IT', preset: 'trend/title' },
        },
        { duration: 3 * SEC, kind: 'any', speed: 2, filter: 'trend/unknown' },
      ],
    },
  ],
})
const template = pack.templates[0]!

describe('pack refs', () => {
  it('parses `<packId>/<itemId>` only', () => {
    expect(parseRef('a/b')).toEqual({ packId: 'a', itemId: 'b' })
    expect(parseRef('a')).toBeUndefined()
    expect(parseRef('/b')).toBeUndefined()
    expect(parseRef('a/')).toBeUndefined()
    expect(parseRef('a/b/c')).toBeUndefined()
  })

  it('resolves items by section and falls back to builtins for animations', () => {
    expect(resolvePackItem([pack], 'filters', 'trend/teal')?.lut).toBe('luts/teal.cube')
    expect(resolvePackItem([pack], 'filters', 'trend/shake')).toBeUndefined()
    expect(resolvePackItem([pack], 'filters', 'other/teal')).toBeUndefined()
    expect(resolvePackItem([pack], 'filters', undefined)).toBeUndefined()
    expect(resolvePackItem([pack], 'filters', 'bad')).toBeUndefined()
    expect(resolveAnimationRef([pack], 'builtin/fade')?.id).toBe('fade')
    expect(resolveAnimationRef([pack], 'trend/drop')?.kind).toBe('out')
    expect(resolveAnimationRef([pack], 'trend/zzz')).toBeUndefined()
  })
})

describe('applyTemplate', () => {
  const video1 = asset({ duration: 10 * SEC })
  const video2 = asset({ duration: 4 * SEC })
  const image = asset({ kind: 'image' })
  const music = asset({ kind: 'audio', duration: 60 * SEC })
  const all: Record<string, Asset> = Object.fromEntries(
    [video1, video2, image, music].map((a) => [a.id, a]),
  )

  it('fills slots in order, preferring each slot kind, and resolves pack refs', () => {
    const p = applyTemplate(template, [video1, image, video2, music], { packs: [pack], now: NOW })
    expect(p.name).toBe('Fast cuts')
    expect(p.settings).toMatchObject({ fps: 60, background: '#112233' })
    expect(p.templateRef).toBe('trend/fast-cuts')
    const main = mainTrack(p).clips as MediaClip[]
    expect(main.map((c) => [c.assetId, c.duration, c.speed])).toEqual([
      [video1.id, 2 * SEC, 1],
      [image.id, 2 * SEC, 1],
      [video2.id, 2 * SEC, 2], // 4 s of source at 2× → 2 s
    ])
    expect(main[0]!.filter).toEqual({ ref: 'trend/teal', intensity: 0.7 })
    expect(main[0]!.effects.map((e) => e.ref)).toEqual(['trend/shake'])
    expect(main[1]!.transitionIn).toEqual({ type: 'whip', duration: 300_000 })
    expect(main[2]!.filter).toBeUndefined()
    expect(validateProject(p, all)).toEqual([])
  })

  it('creates slot texts with preset style and resolvable animations', () => {
    const p = applyTemplate(template, [video1, image, video2], { packs: [pack], now: NOW })
    const texts = p.tracks.flatMap((t) => t.clips).filter((c): c is TextClip => c.type === 'text')
    expect(texts).toHaveLength(1)
    const t = texts[0]!
    const layout = mainTrackLayout(p)
    expect(t.start).toBe(layout[1]!.start)
    expect(t.start + t.duration).toBe(layout[2]!.start)
    expect(t).toMatchObject({ text: 'WAIT FOR IT', presetRef: 'trend/title' })
    expect(t.style.fontFamily).toBe('Bebas Neue')
    expect(t.animationIn).toEqual({ ref: 'builtin/pop', duration: 400_000 })
    expect(t.animationOut?.ref).toBe('trend/drop')
    expect(t.animationLoop).toBeUndefined()
  })

  it('sets the caption style and trims the music bed to the video', () => {
    const p = applyTemplate(template, [video1, image, video2, music], {
      packs: [pack],
      name: 'Mine',
    })
    expect(p.name).toBe('Mine')
    expect(p.captions).toMatchObject({ styleRef: 'trend/hormozi', words: [] })
    expect(p.captions!.style.base.fontFamily).toBe('Anton')
    const audio = p.tracks.find((t) => t.kind === 'audio')!.clips[0]!
    expect(audio.start + audio.duration).toBe(projectDuration(p))
    expect(projectDuration(p)).toBe(6 * SEC - 300_000)
  })

  it('reuses assets when there are fewer than slots and skips unresolvable refs', () => {
    const p = applyTemplate(template, [video1], { packs: [] })
    expect(p.templateRef).toBeUndefined()
    expect(p.captions).toBeUndefined()
    const main = mainTrack(p).clips as MediaClip[]
    expect(main.map((c) => c.assetId)).toEqual([video1.id, video1.id, video1.id])
    expect(main.every((c) => c.filter === undefined && c.effects.length === 0)).toBe(true)
    expect(validateProject(p)).toEqual([])
  })

  it('produces an empty project without visual assets', () => {
    const p = applyTemplate(template, [music], { packs: [pack] })
    expect(mainTrack(p).clips).toHaveLength(0)
    expect(p.tracks.find((t) => t.kind === 'audio')!.clips).toHaveLength(0)
  })

  it('skips slots whose asset is too short for one frame', () => {
    const tiny = asset({ duration: 1000 })
    const tpl = TemplatePreset.parse({
      id: 't',
      name: 'T',
      slots: [{ duration: SEC, kind: 'video' }],
    })
    const p = applyTemplate(tpl, [tiny], { packs: [] })
    expect(mainTrack(p).clips).toHaveLength(0)
  })
})
