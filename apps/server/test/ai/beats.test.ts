import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { analyzeBeats, beatsJob } from '../../src/ai/beats/index.ts'
import {
  BEAT_SAMPLE_RATE,
  BeatAnalyzer,
  bpmFromBeats,
  downbeatPhase,
  estimateTempo,
} from '../../src/ai/beats/tracker.ts'
import {
  addAssetFile,
  clickTrack,
  FFMPEG_BIN,
  ffmpeg,
  makeAsset,
  makeContext,
  makePaths,
  makeTempDir,
  MemoryStore,
  NO_FFMPEG,
  rng,
  skipBecause,
} from './helpers.ts'

const SR = BEAT_SAMPLE_RATE

/** Feed samples in irregular chunk sizes, like an FFmpeg pipe would. */
const analyse = (samples: Float32Array, seed = 7): ReturnType<BeatAnalyzer['finish']> => {
  const a = new BeatAnalyzer()
  const rand = rng(seed)
  for (let i = 0; i < samples.length;) {
    const n = 1 + Math.floor(rand() * 16_384)
    a.push(samples.subarray(i, i + n))
    i += n
  }
  return a.finish()
}

/** For each detected beat, distance (s) to the nearest true beat. */
const errors = (detected: readonly number[], truth: readonly number[]): number[] =>
  detected.map((us) => Math.min(...truth.map((t) => Math.abs(us / 1e6 - t))))

describe('BeatAnalyzer on synthetic click tracks', () => {
  for (const bpm of [90, 120, 128, 150]) {
    for (const noise of [0, 0.05]) {
      it(`${bpm} BPM${noise ? ' + noise' : ''}: tempo ±1 BPM, beats ±15 ms`, () => {
        const { samples, beats: truth } = clickTrack({
          bpm,
          seconds: 30,
          sampleRate: SR,
          noise,
          seed: bpm,
        })
        const r = analyse(samples)
        expect(Math.abs(r.bpm - bpm)).toBeLessThanOrEqual(1)
        const errs = errors(r.beats, truth)
        expect(Math.max(...errs)).toBeLessThanOrEqual(0.015)
        // Recall: nearly every click is found (edges may lose one beat each).
        expect(r.beats.length).toBeGreaterThanOrEqual(truth.length - 2)
        expect(r.beats.length).toBeLessThanOrEqual(truth.length)
        for (let i = 1; i < r.beats.length; i++)
          expect(r.beats[i]).toBeGreaterThan(r.beats[i - 1] ?? 0)
      })
    }
  }

  it('finds the downbeats of an accented 4/4 pattern', () => {
    const { samples, beats: truth } = clickTrack({
      bpm: 120,
      seconds: 30,
      sampleRate: SR,
      accentEvery: 4,
      offset: 0.5,
    })
    const r = analyse(samples)
    const accented = truth.filter((_, i) => i % 4 === 0)
    expect(r.downbeats.length).toBeGreaterThan(10)
    for (const d of r.downbeats) {
      expect(Math.min(...accented.map((t) => Math.abs(d / 1e6 - t)))).toBeLessThanOrEqual(0.015)
    }
    expect(r.downbeats.every((d) => r.beats.includes(d))).toBe(true)
  })

  it('returns no beats for silence or very short input', () => {
    expect(analyse(new Float32Array(SR * 5))).toEqual({ bpm: 0, beats: [], downbeats: [] })
    expect(analyse(new Float32Array(100))).toEqual({ bpm: 0, beats: [], downbeats: [] })
    const noise = new Float32Array(SR * 10)
    const rand = rng(3)
    for (let i = 0; i < noise.length; i++) noise[i] = (rand() * 2 - 1) * 0.3
    const r = analyse(noise)
    // Stationary noise has no tempo; whatever is reported must not be a confident grid.
    expect(r.beats.length).toBeLessThan(40)
  })

  it('ignores leading and trailing silence', () => {
    const { samples, beats: truth } = clickTrack({
      bpm: 128,
      seconds: 20,
      sampleRate: SR,
      offset: 4,
    })
    const padded = new Float32Array(samples.length + SR * 4)
    padded.set(samples)
    const r = analyse(padded)
    expect(r.beats[0]! / 1e6).toBeGreaterThan(3.9)
    expect(r.beats.at(-1)! / 1e6).toBeLessThan(20.1)
    expect(Math.abs(r.bpm - 128)).toBeLessThanOrEqual(1)
    expect(Math.max(...errors(r.beats, truth))).toBeLessThanOrEqual(0.015)
  })
})

describe('tempo helpers', () => {
  it('estimateTempo picks the prior-favoured octave of a periodic envelope', () => {
    const fps = SR / 512
    const env = new Float32Array(2000)
    const period = (60 * fps) / 120
    for (let k = 0; k * period < env.length; k++) env[Math.round(k * period)] = 1
    expect(Math.abs(estimateTempo(env, fps) - 120)).toBeLessThan(2)
    expect(estimateTempo(new Float32Array(10), fps)).toBe(0)
  })

  it('bpmFromBeats is robust to a missed beat', () => {
    const t = [0, 0.5, 1, 1.5, 2.5, 3, 3.5, 4]
    expect(bpmFromBeats(t)).toBeCloseTo(120, 6)
    expect(bpmFromBeats([0, 1])).toBe(0)
  })

  it('downbeatPhase selects the accented phase', () => {
    expect(downbeatPhase([1, 1, 5, 1, 1, 1, 5, 1, 1, 1, 5, 1])).toBe(2)
    expect(downbeatPhase([1, 2, 3])).toBe(0)
  })
})

describe.skipIf(skipBecause(NO_FFMPEG))('beats job (FFmpeg + worker thread)', () => {
  let tmp: ReturnType<typeof makeTempDir>
  let wav: string
  beforeAll(() => {
    tmp = makeTempDir('beats')
    wav = path.join(tmp.dir, 'clicks.wav')
    // 120 BPM: a 1 kHz click with a 5 ms decay every 0.5 s, starting at t = 0.25 s.
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='0.8*sin(2*PI*1000*t)*exp(-mod(t+0.25,0.5)*200)*gte(t,0.25)':s=44100:d=20",
      '-ac',
      '2',
      wav,
    ])
  })
  afterAll(() => tmp.cleanup())

  it('analyzeBeats streams PCM to the worker and finds 120 BPM', async () => {
    const r = await analyzeBeats({ ffmpeg: FFMPEG_BIN, file: wav })
    expect(Math.abs(r.bpm - 120)).toBeLessThanOrEqual(1)
    const truth = Array.from({ length: 40 }, (_, k) => 0.25 + 0.5 * k)
    expect(Math.max(...errors(r.beats, truth))).toBeLessThanOrEqual(0.015)
  })

  it('runs as a job, caches beats on the asset and emits an asset event', async () => {
    const paths = makePaths(tmp.dir)
    const store = new MemoryStore()
    const asset = makeAsset('a1', 'clicks.wav', { kind: 'audio', duration: 20_000_000 })
    addAssetFile(paths, store, asset, wav)
    const ctx = makeContext('beats', { assetId: 'a1' }, paths, store)
    const r = (await beatsJob.handler(ctx)) as { bpm: number; beats: number[] }
    expect(Math.abs(r.bpm - 120)).toBeLessThanOrEqual(1)
    expect(store.getAsset('a1')?.beats).toEqual(r.beats)
    expect(
      ctx.events.some((e) => e.type === 'asset' && e.asset.beats?.length === r.beats.length),
    ).toBe(true)
    expect(ctx.progressLog.at(-1)?.p).toBe(1)
  })

  it('honours cancellation', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(
      analyzeBeats({ ffmpeg: FFMPEG_BIN, file: wav, signal: ac.signal }),
    ).rejects.toThrow(/cancel/i)
  })

  it('rejects files without audio', async () => {
    const vid = path.join(tmp.dir, 'silent.mp4')
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=1', '-c:v', 'libx264', vid])
    await expect(analyzeBeats({ ffmpeg: FFMPEG_BIN, file: vid })).rejects.toThrow(/no audio/)
  })

  it('benchmark: a 3-minute track', async () => {
    const long = path.join(tmp.dir, 'long.wav')
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='0.6*sin(2*PI*800*t)*exp(-mod(t,0.46875)*150)+0.05*sin(2*PI*110*t)':s=44100:d=180",
      long,
    ])
    const t0 = performance.now()
    const r = await analyzeBeats({ ffmpeg: FFMPEG_BIN, file: long })
    const ms = performance.now() - t0
    console.warn(
      `[bench] beats on a 3-min track: ${ms.toFixed(0)} ms (${(180_000 / ms).toFixed(0)}× realtime), ${r.bpm} BPM`,
    )
    expect(Math.abs(r.bpm - 128)).toBeLessThanOrEqual(1)
    expect(ms).toBeLessThan(10_000)
  }, 60_000)
})
