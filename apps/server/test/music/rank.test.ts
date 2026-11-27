import type { LibraryTrack } from '@reelforge/core'
import { describe, expect, it } from 'vitest'
import { dedupeTracks, rankTracks, scoreTrack, tempoMatch } from '../../src/music/rank.ts'

const track = (over: Partial<LibraryTrack> & { id: string }): LibraryTrack => ({
  source: 'x',
  title: over.id,
  artist: 'A',
  licence: { code: 'by', name: 'CC BY 4.0', attributionRequired: true },
  duration: 120_000_000,
  tags: [],
  genres: [],
  cached: false,
  analyzed: false,
  ...over,
})

const q = { duration: 30_000_000, hasSpeech: false }

describe('tempoMatch', () => {
  it('treats half and double time as matches', () => {
    expect(tempoMatch(120, 120)).toBe(1)
    expect(tempoMatch(60, 120)).toBe(1)
    expect(tempoMatch(240, 120)).toBe(1)
    expect(tempoMatch(126, 120)).toBeGreaterThan(0.6)
    expect(tempoMatch(90, 120)).toBe(0)
  })
})

describe('rankTracks', () => {
  it('prefers mood matches, the target tempo and long-enough tracks', () => {
    const ranked = rankTracks(
      [
        track({ id: 'slow', tags: ['calm'], bpm: 70 }),
        track({ id: 'match', tags: ['energetic', 'edm'], bpm: 128 }),
        track({ id: 'short', tags: ['energetic', 'edm'], bpm: 128, duration: 12_000_000 }),
      ],
      { ...q, mood: 'energetic', targetBpm: 128 },
    )
    expect(ranked.map((t) => t.id)).toEqual(['match', 'short', 'slow'])
    expect(ranked[0]!.reasons).toContain('128 BPM')
    expect(ranked[0]!.reasons).toContain('energetic')
  })

  it('with speech, instrumentals beat vocal tracks', () => {
    const ranked = rankTracks(
      [track({ id: 'vocal', tags: ['vocals'] }), track({ id: 'inst', instrumental: true })],
      { ...q, hasSpeech: true },
    )
    expect(ranked[0]!.id).toBe('inst')
    expect(ranked[0]!.reasons).toContain('instrumental')
  })

  it('prefers licences without attribution, all else equal', () => {
    const cc0 = track({
      id: 'cc0',
      licence: { code: 'cc0', name: 'CC0 1.0', attributionRequired: false },
    })
    const ranked = rankTracks([track({ id: 'by' }), cc0], q)
    expect(ranked[0]!.id).toBe('cc0')
    expect(ranked[0]!.reasons).toContain('no credit needed')
    expect(ranked[1]!.reasons[0]).toMatch(/credit in caption/)
  })

  it('uses analysed energy against the mood', () => {
    const calm = scoreTrack(track({ id: 'a', energy: 0.3 }), { ...q, mood: 'chill' })
    const loud = scoreTrack(track({ id: 'b', energy: 0.95 }), { ...q, mood: 'chill' })
    expect(calm.score).toBeGreaterThan(loud.score)
  })

  it('scores stay within 0..1 and ties keep source order', () => {
    const ranked = rankTracks([track({ id: '1' }), track({ id: '2' })], q)
    expect(ranked.map((t) => t.id)).toEqual(['1', '2'])
    for (const t of ranked) expect(t.score).toBeGreaterThanOrEqual(0)
    for (const t of ranked) expect(t.score).toBeLessThanOrEqual(1)
  })
})

describe('dedupeTracks', () => {
  it('drops the same recording from a second source', () => {
    const out = dedupeTracks([
      track({ id: 'openverse:1', title: 'Night Drive!', artist: 'DJ X' }),
      track({ id: 'jamendo:9', title: 'night drive', artist: 'dj x' }),
      track({ id: 'jamendo:10', title: 'Night Drive (Instrumental)', artist: 'DJ X' }),
      track({ id: 'openverse:1', title: 'other' }),
    ])
    expect(out.map((t) => t.id)).toEqual(['openverse:1', 'jamendo:10'])
  })
})

describe('trend order', () => {
  const trend = [
    {
      title: 'Club Hit',
      bpm: 126,
      genre: 'Dance',
      mood: 'energetic' as const,
      energy: 0.85,
      weight: 1,
    },
  ]
  it('ranks the track most similar to a trending sound first and says why', () => {
    const slow = track({ id: 'slow', bpm: 80, tags: ['ambient'], energy: 0.2 })
    const club = track({ id: 'club', bpm: 125, tags: ['dance', 'electronic'], energy: 0.8 })
    const plain = rankTracks([club, slow], { ...q, mood: 'chill' })
    expect(plain[0]!.id).toBe('slow')
    const ranked = rankTracks([slow, club], { ...q, mood: 'chill', trend })
    expect(ranked[0]!.id).toBe('club')
    expect(ranked[0]!.trendMatch).toMatchObject({ title: 'Club Hit' })
    expect(ranked[0]!.trendMatch!.similarity).toBeGreaterThan(0.8)
    expect(ranked[0]!.reasons[0]).toBe('sounds like Club Hit')
  })
  it('leaves scores alone without trending sounds', () => {
    const t = track({ id: 'a', bpm: 120 })
    expect(scoreTrack(t, { ...q, trend: [] })).toEqual(scoreTrack(t, q))
  })
})
