/** Chorus / energy section finder on synthetic audio and envelopes. */
import { describe, expect, it } from 'vitest'
import {
  ENVELOPE_RATE,
  EnergyEnvelope,
  findBestSection,
  normalizeEnvelope,
  trackEnergy,
} from '../../src/music/sections.ts'
import { rng } from '../ai/helpers.ts'

const SR = 22_050

/** PCM for [seconds, amplitude] blocks: noisy 200 Hz tone + 2 Hz kick, like a mix bus. */
const song = (blocks: ReadonlyArray<readonly [number, number]>, seed = 1): Float32Array => {
  const total = blocks.reduce((s, [d]) => s + d, 0)
  const out = new Float32Array(Math.round(total * SR))
  const rand = rng(seed)
  let i = 0
  for (const [d, amp] of blocks) {
    const n = Math.round(d * SR)
    for (let k = 0; k < n; k++, i++) {
      const t = i / SR
      const kick = Math.exp(-25 * (t % 0.5)) * Math.sin(2 * Math.PI * 55 * t)
      out[i] = amp * (0.5 * Math.sin(2 * Math.PI * 200 * t) + 0.5 * kick + 0.05 * (rand() - 0.5))
    }
  }
  return out
}

const envelopeOf = (pcm: Float32Array): Float32Array => {
  const e = new EnergyEnvelope(SR)
  // Irregular chunks, like the FFmpeg pipe.
  for (let i = 0; i < pcm.length; i += 7919) e.push(pcm.subarray(i, i + 7919))
  return e.finish()
}

const s = (x: number) => Math.round(x * 1_000_000)

describe('EnergyEnvelope', () => {
  it('produces 10 frames/s in dBFS', () => {
    const env = envelopeOf(song([[3, 0.5]]))
    expect(env.length).toBe(3 * ENVELOPE_RATE)
    for (const v of env) expect(v).toBeGreaterThan(-20)
    for (const v of env) expect(v).toBeLessThan(0)
    const quiet = envelopeOf(song([[1, 0.01]]))
    expect(Math.max(...quiet)).toBeLessThan(Math.min(...env) - 20)
  })
})

describe('findBestSection', () => {
  const layout = [
    [12, 0.05], // intro
    [12, 0.7], // chorus 12–24
    [12, 0.2], // verse
    [12, 0.7], // chorus 36–48
    [8, 0.05], // outro
  ] as const
  const env = envelopeOf(song(layout))

  it('starts a 10 s reel on the first chorus', () => {
    const r = findBestSection(env, { length: s(10) })
    expect(r.start).toBeGreaterThanOrEqual(s(11.5))
    expect(r.start).toBeLessThanOrEqual(s(12.5))
    expect(r.end - r.start).toBe(s(10))
  })

  it('a 30 s reel still enters at a chorus rather than the intro', () => {
    const r = findBestSection(env, { length: s(30) })
    expect([s(12), s(36)].some((c) => Math.abs(r.start - c) <= s(0.5))).toBe(true)
  })

  it('snaps to candidate bar starts', () => {
    const bars = Array.from({ length: 28 }, (_, i) => s(i * 2)) // every 2 s
    const r = findBestSection(env, { length: s(8), candidates: bars })
    expect(bars).toContain(r.start)
    expect(r.start).toBe(s(12))
  })

  it('handles edge cases: short tracks, flat audio, silence', () => {
    expect(findBestSection(env, { length: s(120) })).toMatchObject({ start: 0 })
    expect(findBestSection(new Float32Array(0), { length: s(10) })).toEqual({
      start: 0,
      end: 0,
      score: 0,
    })
    const flat = envelopeOf(song([[40, 0.5]]))
    expect(findBestSection(flat, { length: s(10) }).start).toBe(0)
    const silent = new Float32Array(400).fill(-120)
    expect(findBestSection(silent, { length: s(10) }).start).toBe(0)
    expect(Array.from(normalizeEnvelope(silent)).every((v) => v === 0)).toBe(true)
  })

  it('ignores candidates that leave no room for the reel', () => {
    const r = findBestSection(env, { length: s(10), candidates: [s(55), s(70)] })
    // No usable candidate → falls back to the free search.
    expect(Math.abs(r.start - s(12))).toBeLessThanOrEqual(s(0.5))
  })
})

describe('trackEnergy', () => {
  it('rises with loudness and tempo', () => {
    const loud = envelopeOf(song([[20, 0.8]]))
    const soft = envelopeOf(song([[20, 0.05]]))
    expect(trackEnergy(loud, 140)).toBeGreaterThan(trackEnergy(soft, 140))
    expect(trackEnergy(loud, 150)).toBeGreaterThan(trackEnergy(loud, 70))
    expect(trackEnergy(new Float32Array(0), 120)).toBe(0)
    for (const e of [trackEnergy(loud, 300), trackEnergy(soft, 0)]) {
      expect(e).toBeGreaterThanOrEqual(0)
      expect(e).toBeLessThanOrEqual(1)
    }
  })
})
