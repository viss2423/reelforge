import { describe, expect, it } from 'vitest'
import { buildCatalogue, snapFont, uniqueId } from '../../src/trends/catalogue.ts'
import { extractSignals } from '../../src/trends/extract.ts'
import {
  extractJson,
  fallbackIdea,
  llmGenerate,
  reelIdeas,
  remixTemplates,
  soundsOf,
} from '../../src/trends/generate.ts'
import { appleMusic } from '../../src/trends/sources/apple-music.ts'
import { deezer } from '../../src/trends/sources/deezer.ts'
import { parseRedditListing } from '../../src/trends/sources/reddit.ts'
import { bundledPacks, fakeLlm, fixture, fixtureCtx } from './helpers.ts'

const NOV = new Date('2026-11-20T12:00:00')
const setup = async () => {
  const { manifests, index } = await bundledPacks()
  const cat = buildCatalogue(manifests, index)
  const signals = extractSignals(
    [
      { source: 'reddit', items: parseRedditListing(fixture('reddit-top.json')) },
      { source: 'apple-music', items: await appleMusic.fetch(fixtureCtx()) },
      { source: 'deezer', items: await deezer.fetch(fixtureCtx()) },
    ],
    NOV,
  )
  return { manifests, index, cat, signals }
}

describe('catalogue', () => {
  it('uses essentials + the newest monthly pack', async () => {
    const { cat } = await setup()
    expect(cat.packs.map((p) => p.id)).toEqual(['essentials', 'trending-2026-11'])
    expect(cat.animations.in).toContain('trending-2026-11/punch-in')
    expect(cat.animations.out).toContain('essentials/fade-out')
    expect(cat.fonts.get('Montserrat')?.length).toBeGreaterThan(2)
  })

  it('snaps fonts to shipped families and weights', async () => {
    const { cat } = await setup()
    expect(snapFont(cat, 'poppins', 850)).toEqual({ fontFamily: 'Poppins', fontWeight: 800 })
    expect(snapFont(cat, 'Comic Sans MS', 700).fontFamily).toBe('Montserrat')
    expect(snapFont(cat, 'Anton', 900)).toEqual({ fontFamily: 'Anton', fontWeight: 400 })
  })

  it('unique slug ids', () => {
    const taken = new Set(['a-b'])
    expect(uniqueId('A b!', taken)).toBe('a-b-2')
    expect(uniqueId('Ünïcode Name', taken)).toBe('unicode-name')
  })
})

describe('remix (no LLM)', () => {
  it('re-cuts the best matching templates on the beat of the top sounds', async () => {
    const { cat, signals } = await setup()
    const sounds = soundsOf(signals, 3)
    const out = remixTemplates(cat, signals, new Set())
    expect(out).toHaveLength(3)
    for (const [i, { item, origin }] of out.entries()) {
      const bpm = sounds[i]!.bpm
      expect(item.musicHint?.bpm).toBe(bpm)
      expect(item.musicHint?.title).toContain(sounds[i]!.title)
      expect(origin).toEqual({ trend: sounds[i]!.title, kind: 'sound' })
      const beat = 60_000_000 / bpm
      for (const s of item.slots) {
        const beats = s.duration / beat
        expect(Math.abs(beats - Math.round(beats))).toBeLessThan(0.01)
      }
    }
    // Photo dump is the hottest format in the reddit fixture.
    expect(out[0]!.item.tags).toContain('photo-dump')
  })
})

describe('LLM generation (fake port)', () => {
  it('compiles specs into valid items and keeps only valid ones', async () => {
    const { cat, signals } = await setup()
    const calls: string[] = []
    const gen = await llmGenerate({
      llm: fakeLlm({ bad: true, calls }),
      cat,
      signals,
      taken: new Set(),
      signal: new AbortController().signal,
    })
    expect(calls).toHaveLength(4)
    expect(gen.captionStyles.map((c) => c.item.id)).toEqual(['frosted-karaoke'])
    expect(gen.captionStyles[0]!.item.style.base.fontFamily).toBe('Poppins')
    const [cozy, unknown] = gen.textPresets.map((t) => t.item)
    expect(cozy!.animationIn).toBe('trending-2026-11/punch-in')
    expect(unknown!.style.fontFamily).toBe('Montserrat')
    expect(unknown!.animationIn).toBe(cat.animations.in[0]) // unknown ref → safe default
    const t = gen.templates[0]!.item
    expect(t.musicHint).toEqual({ title: 'Dracula — Tame Impala', bpm: 120 })
    expect(t.slots[0]!.text).toEqual({
      text: 'snow day photo dump',
      preset: 'trending-live/cozy-pov-hook',
    })
    expect(t.slots[0]!.transitionIn).toBeUndefined()
    expect(t.slots[1]!.transitionIn).toEqual({ type: 'whip', duration: 125_000 }) // ¼ beat
    expect(t.slots[1]!.effects).toEqual(['trending-2026-11/beat-punch'])
    expect(t.slots[4]!.transitionIn?.duration).toBe(250_000) // ½ beat
    expect(t.captionStyle).toBe('trending-live/frosted-karaoke')
    expect(gen.templates[0]!.origin.trend).toBe('photo dump')
    expect(gen.hashtags).toEqual(['winterphotodump', 'cozyseason', 'snowday'])
    expect(gen.tokensPerSecond).toBe(42)
  })

  it('a failing step is recorded, not fatal', async () => {
    const { cat, signals } = await setup()
    const llm = {
      available: async () => true,
      complete: async () => ({ text: 'sorry, I cannot', tokensPerSecond: 1 }),
    }
    const gen = await llmGenerate({
      llm,
      cat,
      signals,
      taken: new Set(),
      signal: new AbortController().signal,
    })
    expect(gen.templates).toEqual([])
    expect(gen.errors.length).toBe(4)
  })

  it('extracts JSON from chatty replies', () => {
    expect(extractJson('Sure! {"items":[1]} hope that helps')).toEqual({ items: [1] })
    expect(extractJson('nope')).toBeUndefined()
  })
})

describe('reel ideas', () => {
  it('LLM ideas for matched topics, template fallback for the rest', async () => {
    const { manifests, signals } = await setup()
    const templates = manifests.flatMap((m) =>
      m.templates.map((item) => ({ ref: `${m.id}/${item.id}`, item })),
    )
    const { ideas, usedLlm } = await reelIdeas({
      llm: fakeLlm(),
      topics: ['oklahoma state basketball', 'thanksgiving'],
      templates,
      signals,
      signal: new AbortController().signal,
    })
    expect(usedLlm).toBe(true)
    expect(ideas[0]).toMatchObject({
      title: 'Game night recap',
      template: 'essentials/countdown-list',
    })
    expect(ideas[0]!.hashtags).toEqual(['gameday', 'hoops'])
    expect(ideas[1]!.topic).toBe('thanksgiving')
    expect(ideas[1]!.hooks).toHaveLength(3)
    expect(templates.map((t) => t.ref)).toContain(ideas[1]!.template)
  })

  it('fallback idea is deterministic', async () => {
    const { manifests, signals } = await setup()
    const templates = manifests.flatMap((m) =>
      m.templates.map((item) => ({ ref: `${m.id}/${item.id}`, item })),
    )
    expect(fallbackIdea('snow day', templates, signals)).toEqual(
      fallbackIdea('snow day', templates, signals),
    )
  })
})
