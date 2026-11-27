import { describe, expect, it } from 'vitest'
import { editTempo, genreBpm, beatsUs } from '../../src/trends/bpm.ts'
import { extractSignals, hashtags, normalize, soundKey, topOf } from '../../src/trends/extract.ts'
import { rankItems, rescore } from '../../src/trends/rank.ts'
import { parseRedditListing } from '../../src/trends/sources/reddit.ts'
import { parseYoutube } from '../../src/trends/sources/youtube.ts'
import { appleMusic } from '../../src/trends/sources/apple-music.ts'
import { deezer } from '../../src/trends/sources/deezer.ts'
import { bundledPacks, findItem, fixture, fixtureCtx } from './helpers.ts'

const NOV = new Date('2026-11-20T12:00:00')

const fixtureSignals = async () =>
  extractSignals(
    [
      { source: 'youtube', items: parseYoutube(fixture('youtube-most-popular.json')) },
      { source: 'reddit', items: parseRedditListing(fixture('reddit-top.json')) },
      { source: 'apple-music', items: await appleMusic.fetch(fixtureCtx()) },
      { source: 'deezer', items: await deezer.fetch(fixtureCtx()) },
    ],
    NOV,
  )

describe('signal extraction', () => {
  it('finds formats, aesthetics, caption cues, hashtags and sounds', async () => {
    const s = await fixtureSignals()
    const texts = (k: string) => s.filter((x) => x.kind === k).map((x) => x.text)
    expect(texts('format')).toEqual(
      expect.arrayContaining(['photo dump', 'pov', 'grwm', 'storytime', 'tier list']),
    )
    expect(texts('aesthetic')).toEqual(expect.arrayContaining(['y2k', 'cozy', 'cool', 'holiday']))
    expect(texts('caption')).toEqual(
      expect.arrayContaining(['lowercase', 'word by word', 'karaoke']),
    )
    expect(texts('hashtag')).toContain('photodump')
    expect(texts('hashtag')).not.toContain('fyp')
    // Photo dump is reported by two sources and ranks first among formats.
    expect(topOf(s, 'format', 1)[0]).toMatchObject({ text: 'photo dump', weight: 1 })
    expect(topOf(s, 'format', 1)[0]!.sources).toEqual(['reddit', 'youtube'])
  })

  it('merges a song charting on two services, keeping artist, genre and tempo', async () => {
    const s = await fixtureSignals()
    const sounds = topOf(s, 'sound', 50)
    const dracula = sounds.find((x) => x.text === 'dracula')
    expect(dracula?.sources).toEqual(['deezer'])
    const texas = sounds.find((x) => x.text === "choosin' texas")
    expect(texas?.sources).toEqual(['apple-music', 'deezer'])
    expect(texas?.meta).toMatchObject({ artist: 'Ella Langley', genre: 'Country' })
    expect(sounds.find((x) => x.text === 'something just like this')?.meta?.bpm).toBe(102.9)
  })

  it('adds calendar moments so there is always something in season', () => {
    const s = extractSignals([], NOV)
    expect(topOf(s, 'topic', 10).map((x) => x.text)).toEqual(
      expect.arrayContaining(['thanksgiving', 'black friday']),
    )
    expect(s.every((x) => x.weight > 0 && x.weight <= 1)).toBe(true)
  })

  it('normalises text, hashtags and song titles', () => {
    expect(normalize('  Café — POV!!  ')).toBe('cafe pov')
    expect(hashtags('#PhotoDump #fyp #2026 #ok')).toEqual(['photodump', 'ok'])
    expect(soundKey('Dracula (with JENNIE)')).toBe('dracula')
    expect(soundKey('Song - Remix')).toBe('song')
  })
})

describe('ranking without an LLM', () => {
  it('moves matching items up and lets the rest cool off gently', async () => {
    const { manifests } = await bundledPacks()
    const s = await fixtureSignals()
    const scores = rankItems(manifests, s)
    const before = (ref: string) => {
      const [p, id] = ref.split('/')
      const m = manifests.find((x) => x.id === p)!
      return findItem(m, id!)!.trendScore
    }
    const photo = 'trending-2026-11/photo-dump'
    const product = 'trending-2026-11/product-showcase'
    expect(scores.get(photo)! - before(photo)).toBeGreaterThan(
      scores.get(product)! - before(product),
    )
    expect(scores.get(photo)!).toBeGreaterThanOrEqual(before(photo))
    // Unmatched items lose at most 10 %.
    for (const [ref, v] of scores) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(100)
      expect(v).toBeGreaterThanOrEqual(Math.floor(before(ref) * 0.9))
    }
    // Deterministic and non-compounding: same inputs, same output.
    expect(rankItems(manifests, s)).toEqual(scores)
  })

  it('rescore is bounded', () => {
    expect(rescore(50, 0)).toBe(45)
    expect(rescore(100, 10)).toBe(100)
    expect(rescore(0, 100)).toBe(25)
  })
})

describe('tempo helpers', () => {
  it('genre tempo, edit band, whole beats', () => {
    expect(genreBpm('Hip-Hop/Rap')).toBe(92)
    expect(genreBpm('Country')).toBe(112)
    expect(genreBpm(undefined)).toBe(120)
    expect(editTempo(60)).toBe(120)
    expect(editTempo(174)).toBe(87)
    expect(beatsUs(4, 120)).toBe(2_000_000)
  })
})
